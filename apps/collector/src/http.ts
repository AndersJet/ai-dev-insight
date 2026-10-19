import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { jsonBudgetFailure, HookSchema, type HookEnvelope } from '@adi/contracts';
import type { DeliveryQueue } from './delivery.js';

export interface IntakePolicy {
  expiresAt: number;
  writable?:boolean;
  installations: ReadonlyMap<string, { tokenHash: string; enabled: boolean; admissionEpoch: number }>;
}
export interface IntakeOptions {
  maxBodyBytes?: number; maxReadingBytes?: number; maxReaders?: number; readTimeoutMs?: number;
  maxNodes?: number; maxDepth?: number; maxArrayItems?: number;
}
const defaults = { maxBodyBytes: 2 * 1024 * 1024, maxReadingBytes: 64 * 1024 * 1024, maxReaders: 2048, readTimeoutMs: 1000, maxNodes: 20_000, maxDepth: 32, maxArrayItems: 2048 };
const ajv = new Ajv({ strict: true, allErrors: false });
addFormats.default(ajv);
const validate = ajv.compile<HookEnvelope>(HookSchema);

function boundedTree(root: unknown, limits: typeof defaults): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || ++nodes > limits.maxNodes || entry.depth > limits.maxDepth) return false;
    if (Array.isArray(entry.value) && entry.value.length > limits.maxArrayItems) return false;
    if (entry.value && typeof entry.value === 'object') {
      for (const value of Object.values(entry.value)) {
        if (stack.length + nodes >= limits.maxNodes) return false;
        stack.push({ value, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}
function equalToken(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual.slice('Bearer '.length)).digest(); const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Policy is a replaceable in-memory snapshot. This process has no DB or disk access.
export function createCollector(queue: Pick<DeliveryQueue, 'admit'> & Partial<Pick<DeliveryQueue,'isReady'>>, policy: () => IntakePolicy | null, options: IntakeOptions = {}) {
  const limits = { ...defaults, ...options };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Intake limits must be positive integers');
  let readingBytes = 0; let readers = 0;
  const stats = { received: 0, admitted: 0, filtered: 0, malformed: 0, limited: 0, aborted: 0,limited_body_bytes:0,limited_inflight_bytes:0,limited_readers:0,limited_read_timeout:0,limited_json_budget:0,limited_delivery_capacity:0 };
  type LimitReason='limited_body_bytes'|'limited_inflight_bytes'|'limited_readers'|'limited_read_timeout'|'limited_json_budget'|'limited_delivery_capacity';
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const pathname = req.url?.split('?')[0];
    if(pathname==='/readyz'){
      if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,{'Cache-Control':'no-store'});res.end();return;}
      const current=policy(),ready=queue.isReady?.()===true&&current?.writable===true&&current.expiresAt>Date.now();res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({ready}));return;
    }
    if (pathname !== '/hooks') { res.writeHead(404); res.end(); return; }
    stats.received++;
    let done = false; let size = 0; let active = false;
    let chunks: Buffer[] = [];
    const timer = setTimeout(() => finish('limited', true,'limited_read_timeout'), limits.readTimeoutMs);
    const finish = (outcome: 'admitted'|'filtered'|'malformed'|'limited'|'aborted', early = false,reason?:LimitReason) => {
      if (done) return;
      done = true; clearTimeout(timer);
      stats[outcome]++;
      if(reason)stats[reason]++;
      readingBytes -= size; if (active) readers--;
      chunks = [];
      if (!res.destroyed) {
        if (early) { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); }
        res.writeHead(200, { 'Content-Length': '0' }); res.end();
      }
      if (early) {
        req.pause();
        // Flush the empty response, then stop a client still sending an oversized body.
        res.once('finish', () => { req.socket.destroy(); });
      }
    };
    const snapshot = policy();
    if (req.method !== 'POST' || !snapshot || snapshot.writable===false || snapshot.expiresAt <= Date.now()) { finish('filtered', true); return; }
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || header.length > 1024) { finish('filtered', true); return; }
    const announced = Number(req.headers['content-length'] ?? 0);
    if (readers >= limits.maxReaders) { finish('limited', true,'limited_readers'); return; }
    if (announced > limits.maxBodyBytes) { finish('limited', true,'limited_body_bytes'); return; }
    readers++; active = true;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      if (size + chunk.length > limits.maxBodyBytes) { finish('limited', true,'limited_body_bytes'); return; }
      if (readingBytes + chunk.length > limits.maxReadingBytes) { finish('limited', true,'limited_inflight_bytes'); return; }
      size += chunk.length; readingBytes += chunk.length; chunks.push(chunk);
    });
    req.on('aborted', () => finish('aborted'));
    req.on('error', () => finish('aborted'));
    res.on('close', () => { if (!done) finish('aborted'); });
    req.on('end', () => {
      if (done) return;
      let value: unknown;
      let body: string;
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); if (jsonBudgetFailure(body, { wireBytes: limits.maxBodyBytes })) { finish('limited',false,'limited_json_budget'); return; } value = JSON.parse(body); } catch { finish('malformed'); return; }
      if (!boundedTree(value, limits)) { finish('limited',false,'limited_json_budget'); return; }
      if (!validate(value)) { finish('malformed'); return; }
      // Refresh at admission; a snapshot captured before a slow upload may be obsolete.
      const latest = policy();
      const installation = latest?.installations.get(value.installation_id);
      if (!latest || latest.writable===false || latest.expiresAt <= Date.now() || !installation?.enabled || !equalToken(header, installation.tokenHash)) { finish('filtered'); return; }
      const admitted=queue.admit(body, { admissionEpoch: installation.admissionEpoch, receivedAt: new Date().toISOString(), tokenHash: installation.tokenHash });finish(admitted?'admitted':'limited',false,admitted?undefined:'limited_delivery_capacity');
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return { server, snapshot: () => ({ ...stats, readingBytes, readers }) };
}
