import { readFile, writeFile, mkdir, rename, unlink, rmdir, readdir, lstat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readSmallJson, validateCredentials, validateEndpoint, uuid } from './config.js';

type JsonObject = Record<string, unknown>;
type Entry = { event: string; group: JsonObject };
type Manifest = { version: 1; release: string; releases: string[]; entries: Entry[] };
type Journal = { before: string; after: string; manifest: Manifest | null; created: string | null; remove: string[] };
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
const ownedFiles = ['sender.js', 'config.js', 'package.json', 'config.json'];
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new Error(code); }
async function protectWindowsDirectory(path: string) {
  if (process.platform !== 'win32') return;
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`;
  try { await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, maxBuffer: 4096, windowsHide: true }); }
  catch { fail('private_acl_failed'); }
}
async function optionalFile(path: string) {
  try {
    const info = await lstat(path); if (!info.isFile() || info.size > 1024 * 1024) fail('unsafe_or_oversized_file');
    const file = await open(path, 'r');
    try {
      const data = Buffer.alloc(1024 * 1024 + 1); let offset = 0;
      while (offset < data.length) { const { bytesRead } = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset > 1024 * 1024) fail('unsafe_or_oversized_file');
      return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, offset));
    } finally { await file.close(); }
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}
async function atomic(path: string, text: string) {
  const temp = join(dirname(path), `.adi-write-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}
function parseHooks(raw: string | null): JsonObject {
  if (raw === null) return { version: 1, hooks: {} };
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed) || !object(parsed.hooks) || (parsed.version !== undefined && parsed.version !== 1) || Object.values(parsed.hooks).some(value => !Array.isArray(value))) fail('unsupported_hooks_configuration');
  return parsed;
}
function parseManifest(raw: string | null): Manifest | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || typeof value.release !== 'string' || !uuid.test(value.release) || !Array.isArray(value.releases) || value.releases.length > 1000 || !value.releases.every(item => typeof item === 'string' && uuid.test(item)) || !Array.isArray(value.entries) || !value.entries.every(item => object(item) && typeof item.event === 'string' && events.includes(item.event) && object(item.group))) fail('invalid_installation_manifest');
  return value as Manifest;
}
function shell(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function powershell(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function command(release: string) {
  const script = join(release, 'sender.js'); const config = join(release, 'config.json');
  if (process.platform === 'win32') return `try { & ${powershell(process.execPath)} ${powershell(script)} --config ${powershell(config)} *> $null } catch {} ; exit 0`;
  return `${shell(process.execPath)} ${shell(script)} --config ${shell(config)} >/dev/null 2>&1; exit 0`;
}
function entries(release: string): Entry[] {
  const cmd = command(release);
  return events.map(event => ({ event, group: { ...(['PreToolUse', 'PostToolUse', 'Notification'].includes(event) ? { matcher: '*' } : {}), ...(event === 'Stop' ? { loop_limit: 1000 } : {}), hooks: [{ type: 'command', command: cmd, timeout: 2 }] } }));
}
function merge(original: JsonObject, previous: Manifest | null, next: Entry[]): JsonObject {
  const result = structuredClone(original); const hooks = result.hooks as JsonObject;
  for (const old of previous?.entries ?? []) {
    const groups = hooks[old.event] as unknown[] | undefined;
    if (!groups) fail('managed_hooks_modified');
    const matches = groups.filter(group => isDeepStrictEqual(group, old.group));
    if (matches.length !== 1) fail('managed_hooks_modified');
    const remaining = groups.filter(group => !isDeepStrictEqual(group, old.group));
    if (remaining.length) hooks[old.event] = remaining; else delete hooks[old.event];
  }
  for (const entry of next) {
    const groups = hooks[entry.event] as unknown[] | undefined;
    hooks[entry.event] = [...groups ?? [], entry.group];
  }
  return result;
}
function legacy(original: JsonObject, trae: string, replace: boolean) {
  const result = structuredClone(original); const hooks = result.hooks as JsonObject;
  const known = new Set([`"${join(trae, 'trae-hook-send.sh')}"`, `powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "${join(trae, 'trae-hook-send.ps1')}"`]);
  let count = 0;
  for (const event of Object.keys(hooks)) {
    const remaining: unknown[] = [];
    for (const group of hooks[event] as unknown[]) {
      if (!object(group) || !Array.isArray(group.hooks)) { remaining.push(group); continue; }
      const definitions: unknown[] = []; let removed = false;
      for (const definition of group.hooks) {
        if (!object(definition) || typeof definition.command !== 'string' || !/trae-hook-send\.(?:sh|ps1)/.test(definition.command)) { definitions.push(definition); continue; }
        count++;
        if (!replace || !known.has(definition.command)) fail('legacy_hook_requires_migration');
        removed = true;
      }
      if (!removed) remaining.push(group); else if (definitions.length) remaining.push({ ...group, hooks: definitions });
    }
    if (remaining.length) hooks[event] = remaining; else delete hooks[event];
  }
  return { result, count };
}
async function acquire(base: string) {
  const lock = join(base, 'install.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 }); const owner = `owner-${randomUUID()}`;
      await writeFile(join(lock, owner), String(process.pid), { flag: 'wx', mode: 0o600 });
      return async () => { await unlink(join(lock, owner)); await rmdir(lock); };
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      const names = await readdir(lock); if (names.length !== 1 || !names[0]?.startsWith('owner-') || !uuid.test(names[0].slice(6))) fail('installation_busy');
      const owner = join(lock, names[0]); const pid = Number(await optionalFile(owner)); if (!Number.isSafeInteger(pid) || pid < 1) fail('installation_busy');
      let alive = true;
      try { process.kill(pid, 0); } catch (reason) { if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'ESRCH') alive = false; }
      if (alive) fail('installation_busy');
      // The unique owner filename prevents two stale-lock removers from removing
      // a newly acquired lock. Any competing ENOENT aborts this attempt safely.
      await unlink(owner); await rmdir(lock);
    }
  }
  return fail('installation_busy');
}
async function cleanRelease(base: string, id: string) {
  if (!uuid.test(id)) fail('invalid_installation_manifest');
  const directory = join(base, id);
  let info; try { info = await lstat(directory); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_installation_path');
  for (const file of ownedFiles) await unlink(join(directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // Preserve any unrecognized files the user placed in a release directory.
  await rmdir(directory).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
}
async function recover(base: string, hooksPath: string) {
  const raw = await optionalFile(join(base, 'pending.json')); if (raw === null) return;
  const value: unknown = JSON.parse(raw);
  if (!object(value) || typeof value.before !== 'string' || typeof value.after !== 'string' || !(value.created === null || (typeof value.created === 'string' && uuid.test(value.created))) || !Array.isArray(value.remove) || !value.remove.every(id => typeof id === 'string' && uuid.test(id))) fail('invalid_installation_journal');
  const state = { ...value, manifest: parseManifest(value.manifest === null ? null : JSON.stringify(value.manifest)) } as Journal;
  const current = digest((await optionalFile(hooksPath)) ?? '');
  if (current === state.after) {
    if (state.manifest) await atomic(join(base, 'manifest.json'), JSON.stringify(state.manifest)); else await unlink(join(base, 'manifest.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const release of state.remove) await cleanRelease(base, release);
  } else if (current === state.before) {
    if (state.created) await cleanRelease(base, state.created);
  } else fail('installation_recovery_conflict');
  await unlink(join(base, 'pending.json'));
}
async function installationInput(flags: Map<string, string>) {
  const document = await readSmallJson(flags.get('--credentials') ?? fail('credentials_required'));
  const credentials = validateCredentials(document);
  const savedEndpoint = object(document) && typeof document.endpoint === 'string' ? document.endpoint : undefined;
  const endpoint = validateEndpoint(flags.get('--endpoint') ?? savedEndpoint ?? fail('endpoint_required'));
  return { credentials, endpoint };
}
async function run() {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('node_24_required');
  const action = process.argv[2]; if (!['plan', 'install', 'uninstall', 'status'].includes(action ?? '')) fail('usage_required');
  const flags = new Map<string, string>();
  for (let i = 3; i < process.argv.length;) {
    const key = process.argv[i]; const value = process.argv[i + 1];
    if (key === '--replace-legacy' && !flags.has(key)) { flags.set(key, 'true'); i++; continue; }
    if (!key || !['--trae-dir', '--credentials', '--endpoint'].includes(key) || !value || flags.has(key)) fail('invalid_arguments'); flags.set(key, value); i += 2;
  }
  const trae = resolve(flags.get('--trae-dir') ?? join(homedir(), '.trae-cn')); const base = join(trae, 'adi-collector'); const hooksPath = join(trae, 'hooks.json');
  const raw = await optionalFile(hooksPath); parseHooks(raw);
  if (action === 'plan') {
    await installationInput(flags);
    const previous = parseManifest(await optionalFile(join(base, 'manifest.json')));
    const replacement = legacy(parseHooks(raw), trae, flags.has('--replace-legacy'));
    merge(replacement.result, previous, entries(join(base, 'preview')));
    process.stdout.write(JSON.stringify({ action: 'plan', events, runtime: process.execPath, profile: trae, legacy_commands_to_replace: replacement.count, command_deadline_ms: 750, hook_timeout_seconds: 2 }) + '\n'); return;
  }
  if (action === 'status') {
    const manifest = parseManifest(await optionalFile(join(base, 'manifest.json')));
    process.stdout.write(JSON.stringify({ installed: manifest !== null, pending_recovery: (await optionalFile(join(base, 'pending.json'))) !== null, profile: trae }) + '\n'); return;
  }
  const configuration = action === 'install' ? await installationInput(flags) : null;
  await mkdir(trae, { recursive: true, mode: 0o700 });
  const profile = await lstat(trae); if (!profile.isDirectory() || profile.isSymbolicLink()) fail('unsafe_installation_path');
  try { await mkdir(base, { mode: 0o700 }); await writeFile(join(base, '.owned'), 'adi-hook-client-v1', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    const info = await lstat(base); if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0) || await optionalFile(join(base, '.owned')) !== 'adi-hook-client-v1') fail('unsafe_installation_path');
  }
  const unlock = await acquire(base);
  try {
    await protectWindowsDirectory(base);
    await recover(base, hooksPath);
    const originalRaw = await optionalFile(hooksPath); const original = parseHooks(originalRaw);
    const old = parseManifest(await optionalFile(join(base, 'manifest.json')));
    if (action === 'uninstall' && !old) { process.stdout.write('{"action":"uninstall","changed":false}\n'); return; }
    // Shared-token legacy scripts require an explicit migration decision. Do not
    // silently keep sending a second copy or remove a user's unrelated command.
    const prepared = action === 'install' ? legacy(original, trae, flags.has('--replace-legacy')).result : original;
    const release = randomUUID(); const nextEntries = action === 'install' ? entries(join(base, release)) : [];
    const next: Manifest | null = action === 'install' ? { version: 1, release, releases: [...old?.releases ?? [], release], entries: nextEntries } : null;
    if (next && next.releases.length > 1000) fail('release_limit');
    const after = JSON.stringify(merge(prepared, old, nextEntries), null, 2) + '\n';
    const journal: Journal = { before: digest(originalRaw ?? ''), after: digest(after), manifest: next, created: next ? release : null, remove: next ? [] : old?.releases ?? [] };
    if (originalRaw !== null) await writeFile(join(base, `hooks-backup-${randomUUID()}.json`), originalRaw, { flag: 'wx', mode: 0o600 });
    await atomic(join(base, 'pending.json'), JSON.stringify(journal));
    if (next) {
      const target = join(base, release); await mkdir(target, { mode: 0o700 });
      for (const file of ['sender.js', 'config.js']) await writeFile(join(target, file), await readFile(new URL(file, import.meta.url)), { flag: 'wx', mode: 0o600 });
      await writeFile(join(target, 'package.json'), '{"type":"module"}', { flag: 'wx', mode: 0o600 });
      await writeFile(join(target, 'config.json'), JSON.stringify({ ...configuration!.credentials, endpoint: configuration!.endpoint }), { flag: 'wx', mode: 0o600 });
    }
    if (digest((await optionalFile(hooksPath)) ?? '') !== journal.before) fail('hooks_changed_during_install');
    await atomic(hooksPath, after);
    await recover(base, hooksPath);
    process.stdout.write(JSON.stringify({ action, changed: true, profile: trae, restart_trae_required: true }) + '\n');
  } finally { await unlock(); }
}
void run().catch(error => {
  const known = new Set(['node_24_required', 'usage_required', 'invalid_arguments', 'credentials_required', 'endpoint_required', 'invalid_credentials_file', 'invalid_collector_endpoint', 'https_required', 'invalid_config_file', 'unsafe_or_oversized_file', 'unsupported_hooks_configuration', 'invalid_installation_manifest', 'managed_hooks_modified', 'installation_busy', 'unsafe_installation_path', 'invalid_installation_journal', 'installation_recovery_conflict', 'legacy_hook_requires_migration', 'hooks_changed_during_install', 'private_acl_failed', 'release_limit']);
  const code = error instanceof Error && known.has(error.message) ? error.message : 'installation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
