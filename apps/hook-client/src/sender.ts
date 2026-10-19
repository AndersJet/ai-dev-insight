import { request as http, type ClientRequest } from 'node:http';
import { request as https } from 'node:https';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readClientConfig, readSmallJson, uuid, type ClientConfig } from './config.js';
import {readLeaseClock,activeRuntimeLease} from './runtime-clock.js';

// This is a command Hook, not a detached/background delivery guarantee. The
// deadline covers config I/O, stdin and network after Node has started.
const observedAt = new Date().toISOString();
const maxBytes = 2 * 1024 * 1024 - 2048;
let finished = false; let pending: ClientRequest | undefined;
function finish() {
  if (finished) return;
  finished = true; pending?.destroy(); process.stdin.destroy(); process.exit(0);
}
setTimeout(finish, 750);
process.on('uncaughtException', finish); process.on('unhandledRejection', finish);
process.on('SIGTERM', finish); process.on('SIGINT', finish);
function bounded(value: unknown): boolean {
  const queue = [{ value, depth: 0 }]; let count = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++count > 19_900 || item.depth > 31 || (Array.isArray(item.value) && item.value.length > 2048)) return false;
    if (item.value && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) {
        if (queue.length + count > 19_900) return false;
        queue.push({ value, depth: item.depth + 1 });
      }
    }
  }
  return true;
}
async function runtimeGeneration(config: ClientConfig): Promise<string | null> {
  const home = homedir(); if (!isAbsolute(home)) return null;
  const profile = join(home, '.trae-cn'), directory = join(profile, 'adi-plugin-control');
  if (!(await lstat(profile)).isDirectory() || !(await lstat(directory)).isDirectory()) return null;
  const control = await readSmallJson(join(directory, 'control.json'), true,32768);
  if (!control || typeof control !== 'object' || !('version' in control) || control.version !== 2 || !('owner' in control) || control.owner !== config.runtime_owner || !('enabled' in control) || control.enabled !== true || !('generation' in control) || typeof control.generation !== 'string' || !uuid.test(control.generation) || !('leases' in control) || !Array.isArray(control.leases) || control.leases.length > 128 || !('clock_kind' in control)) return null;
  const scopes=control.leases.flatMap(lease=>lease&&typeof lease.clock_scope==='string'?[lease.clock_scope]:[]),clock=await readLeaseClock(process.platform==='win32'?scopes:[]);
  if(control.clock_kind!==clock.kind)return null;
  return control.leases.some(lease=>activeRuntimeLease(lease,Date.now(),clock))?control.generation:null;
}
async function run() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || Number(process.versions.node.split('.')[0]) !== 24) return finish();
  const config = await readClientConfig(process.argv[3]!);
  const generation = await runtimeGeneration(config); if (!generation) return finish();
  let bytes = 0; const chunks: Buffer[] = [];
  process.stdin.on('error', finish);
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length; if (bytes > maxBytes) return finish(); chunks.push(buffer);
  }
  if (!bytes) return finish();
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  const payload: unknown = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !bounded(payload) || !('session_id' in payload) || typeof payload.session_id !== 'string' || !payload.session_id.trim() || payload.session_id.length > 256 || !('hook_event_name' in payload) || typeof payload.hook_event_name !== 'string' || !['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'].includes(payload.hook_event_name)) return finish();
  // Serialize metadata separately and embed the original JSON, preserving number
  // tokens and all payload fields. Never spread untrusted keys into metadata.
  if (await runtimeGeneration(config) !== generation) return finish();
  const metadata = JSON.stringify({ schema_version: 2, installation_id: config.installation_id, client_event_id: randomUUID(), occurred_at: observedAt, timestamp_source: 'client_observed', event_type: payload.hook_event_name, source_session_id: payload.session_id });
  const body = `${metadata.slice(0, -1)},"payload":${raw}}`;
  const url = new URL(config.endpoint);
  pending = (url.protocol === 'https:' ? https : http)(url, { method: 'POST', agent: false, maxHeaderSize: 8192, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, 'Content-Length': Buffer.byteLength(body) } }, response => {
    // No redirects and no returned text reaches stdin/stdout of the IDE.
    response.destroy(); finish();
  });
  pending.on('error', finish); pending.end(body);
}
void run().catch(finish);
