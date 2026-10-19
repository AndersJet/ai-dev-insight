import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { managedRuntime } from './managed-runtime-fixture.js';
import type { AddressInfo } from 'node:net';
const execute = promisify(execFile);
const source = new URL('../native/', import.meta.url);
const installationId = 'a163f758-49a9-4d19-b713-0680c1810f66';
const token = 'adi_' + 'a'.repeat(43);
const runtimeOwner = 'a'.repeat(64);

test('native envelope retains the exact payload and rejects invalid metadata and excessive nesting', async () => {
  const core = runInNewContext((await readFile(new URL('core.js', source), 'utf8')) + '\nADI;');
  const raw = '{"hook_event_name":"UserPromptSubmit","session_id":"合成","n":9007199254740993,"A":1,"a":2}';
  const body: string = core.envelope(raw, { installation_id: installationId }, installationId, '2026-09-28T00:00:00.000Z');
  assert.ok(body.endsWith('"payload":' + raw + '}'));
  assert.equal(JSON.parse(body).schema_version, 2);
  assert.throws(() => core.envelope('{"session_id":"s","hook_event_name":"unknown"}', {}, '', ''));
  assert.throws(() => core.envelope('{"session_id":"s","hook_event_name":"Stop","x":' + '['.repeat(34) + '1' + ']'.repeat(34) + '}', {}, '', ''));
});

test('macOS native installer preserves unrelated hooks, updates once, detects edits and uninstalls its own files', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-native-install-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['install-hook.sh', 'send-hook.sh']) await writeFile(join(dir, name), await readFile(new URL(name, source)));
  await writeFile(join(dir, 'native-macos.js'), (await readFile(new URL('core.js', source), 'utf8')) + '\n' + await readFile(new URL('macos.js', source), 'utf8'));
  const profile = join(dir, "profile with 'quote $dollar"); await mkdir(profile);
  const original = { version: 1, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-validator' }] }] } };
  await writeFile(join(profile, 'hooks.json'), JSON.stringify(original));
  const creds = join(dir, 'credentials.json');
  await writeFile(creds, JSON.stringify({ installation_id: installationId, token, endpoint: 'http://example.invalid/hooks', protocol_version: 2, runtime_owner: runtimeOwner }), { mode: 0o600 });
  const command = (action: string) => execute('/bin/bash', [join(dir, 'install-hook.sh'), action, '--trae-dir', profile, '--credentials', creds], { env: { ...process.env, PATH: '/usr/bin:/bin' } });
  await command('plan'); assert.deepEqual(JSON.parse(await readFile(join(profile, 'hooks.json'), 'utf8')), original);
  await command('install'); await command('install');
  const path = join(profile, 'hooks.json'); const installed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(installed.hooks.Stop.length, 2); assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  const base = join(profile, 'adi-native-collector'); const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  assert.equal((await stat(join(base, manifest.release, 'config.json'))).mode & 0o777, 0o600);
  const managed = JSON.parse(await readFile(join(base, manifest.release, 'config.json'), 'utf8'));
  assert.equal(managed.protocol_version, 2); assert.equal(managed.runtime_owner, runtimeOwner);
  const modified = structuredClone(installed); modified.hooks.Stop[1].hooks[0].timeout = 5;
  await writeFile(path, JSON.stringify(modified)); await assert.rejects(command('install'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), modified);
  await writeFile(path, JSON.stringify(installed)); await command('uninstall');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
  await assert.rejects(readFile(join(base, manifest.release, 'config.json')), { code: 'ENOENT' });
});

test('native installer reinstalls after a known legacy overwrite without relaxing modified-hook protection', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-native-roundtrip-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['install-hook.sh', 'send-hook.sh', 'install-hook.ps1', 'send-hook.ps1', 'send-worker.ps1','native-windows.ps1','project-core.ps1','project-io.ps1','project-git.ps1','windows-process.cs']) await writeFile(join(dir, name), await readFile(new URL(name, source)));
  await writeFile(join(dir, 'native-macos.js'), (await readFile(new URL('core.js', source), 'utf8')) + '\n' + await readFile(new URL('macos.js', source), 'utf8'));
  const profile = join(dir, 'profile'); await mkdir(profile);
  const creds = join(dir, 'credentials.json');
  await writeFile(creds, JSON.stringify({ installation_id: installationId, token, endpoint: 'http://example.invalid/hooks', protocol_version: 2, runtime_owner: runtimeOwner }), { mode: 0o600 });
  const command = (action: string, replace = true) => process.platform === 'win32'
    ? execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'install-hook.ps1'), action, '-TraeDir', profile, '-Credentials', creds, ...(replace ? ['-ReplaceLegacy'] : [])])
    : execute('/bin/bash', [join(dir, 'install-hook.sh'), action, '--trae-dir', profile, '--credentials', creds, ...(replace ? ['--replace-legacy'] : [])]);
  await command('install');
  const path = join(profile, 'hooks.json'), base = join(profile, 'adi-native-collector');
  const manifestRaw = await readFile(join(base, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const installed = JSON.parse(await readFile(path, 'utf8'));
  const legacy = structuredClone(installed);
  const legacyCommand = process.platform === 'win32' ? 'powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + join(profile, 'trae-hook-send.ps1') + '"' : '"' + profile + '/trae-hook-send.sh"';
  for (const event of Object.keys(legacy.hooks)) legacy.hooks[event] = [{ hooks: [{ type: 'command', command: legacyCommand, timeout: 5 }] }];
  const unrelated = { hooks: [{ type: 'command', command: 'user-validator' }] };
  legacy.hooks.Stop.push(unrelated);
  const rejectsWithoutChanges = async (value: typeof legacy, action = 'install', replace = true, error = 'managed_hooks_modified') => {
    const raw = JSON.stringify(value); await writeFile(path, raw);
    await assert.rejects(command(action, replace), (reason: unknown) => reason instanceof Error && 'stdout' in reason && 'stderr' in reason && (String(reason.stdout) + String(reason.stderr)).includes(error));
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.equal(await readFile(join(base, 'manifest.json'), 'utf8'), manifestRaw);
  };
  await rejectsWithoutChanges(legacy, 'install', false, 'legacy_hook_requires_migration');
  await rejectsWithoutChanges(legacy, 'uninstall');
  const missing = structuredClone(legacy); delete missing.hooks.SessionStart;
  await rejectsWithoutChanges(missing);
  const duplicate = structuredClone(legacy); duplicate.hooks.SessionStart.push(structuredClone(duplicate.hooks.SessionStart[0]));
  await rejectsWithoutChanges(duplicate);
  const modified = structuredClone(legacy); modified.hooks.Stop.push(structuredClone(installed.hooks.Stop[0])); modified.hooks.Stop.at(-1).hooks[0].timeout = 5;
  await rejectsWithoutChanges(modified);
  const unknown = structuredClone(legacy); unknown.hooks.SessionStart[0].hooks[0].command += ' --custom';
  await rejectsWithoutChanges(unknown, 'install', true, 'legacy_hook_requires_migration');
  await writeFile(path, JSON.stringify(legacy));
  await command('plan'); assert.equal(await readFile(path, 'utf8'), JSON.stringify(legacy));
  await command('install');
  const updated = JSON.parse(await readFile(path, 'utf8'));
  for (const event of Object.keys(installed.hooks)) assert.equal(updated.hooks[event].length, event === 'Stop' ? 2 : 1);
  assert.deepEqual(updated.hooks.Stop[0], unrelated);
  assert.ok(!JSON.stringify(updated).includes('trae-hook-send.'));
  await assert.rejects(readFile(join(base, manifest.release, 'config.json')), { code: 'ENOENT' });
  await command('install'); await command('uninstall');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks, { Stop: [unrelated] });
});

test('native installer plans and reinstalls a completely cleared configuration, preserving metadata and refusing partial edits', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-native-reset-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['install-hook.sh','send-hook.sh','install-hook.ps1','send-hook.ps1','send-worker.ps1','native-windows.ps1','project-core.ps1','project-io.ps1','project-git.ps1','windows-process.cs','windows-client.cs']) await writeFile(join(dir, name), await readFile(new URL(name, source)));
  await writeFile(join(dir, 'native-macos.js'), (await readFile(new URL('core.js', source), 'utf8')) + '\n' + await readFile(new URL('macos.js', source), 'utf8'));
  const profile = join(dir, 'profile'); await mkdir(profile);
  const creds = join(dir, 'credentials.json');
  await writeFile(creds, JSON.stringify({ installation_id: installationId, token, endpoint: 'http://example.invalid/hooks', protocol_version: 2, runtime_owner: runtimeOwner }), { mode: 0o600 });
  const command = (action: string) => process.platform === 'win32'
    ? execute('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(dir,'install-hook.ps1'),action,'-TraeDir',profile,'-Credentials',creds])
    : execute('/bin/bash', [join(dir,'install-hook.sh'),action,'--trae-dir',profile,'--credentials',creds]);
  const path = join(profile, 'hooks.json'), base = join(profile, 'adi-native-collector');
  // Empty objects must also work on the first installation, before a manifest exists.
  await writeFile(path, '{}'); await command('plan'); assert.equal(await readFile(path, 'utf8'), '{}'); await command('install');
  for (const raw of ['{}','',' \n\t','{"version":1,"hooks":{}}','{"custom":{"preserved":true},"hooks":{"Stop":[]}}',null]) {
    const before = await readFile(join(base, 'manifest.json'), 'utf8');
    if (raw === null) await unlink(path); else await writeFile(path, raw);
    await command('plan');
    if (raw === null) await assert.rejects(readFile(path), { code: 'ENOENT' }); else assert.equal(await readFile(path, 'utf8'), raw);
    assert.equal(await readFile(join(base, 'manifest.json'), 'utf8'), before);
    await command('install');
    const installed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.keys(installed.hooks).length, 6);
    assert.ok(Object.values(installed.hooks).every(groups => Array.isArray(groups) && groups.length === 1));
    if (raw?.includes('custom')) assert.deepEqual(installed.custom, { preserved: true });
    await assert.rejects(readFile(join(base, JSON.parse(before).release, 'config.json')), { code: 'ENOENT' });
  }
  const installed = JSON.parse(await readFile(path, 'utf8')), partial = structuredClone(installed); delete partial.hooks.Stop;
  for (const value of [partial, { hooks: { Stop: [{ hooks: [{ command: 'user-validator' }] }] } }, { hooks: null }, { hooks: [] }, { hooks: { Stop: {} } }, { version: 2, hooks: {} }, null, []]) {
    const raw = JSON.stringify(value); await writeFile(path, raw);
    await assert.rejects(command('install')); assert.equal(await readFile(path, 'utf8'), raw);
  }
  await writeFile(path, JSON.stringify(installed)); await command('uninstall');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks, {});
});

test('macOS native hook sends lossless HTTP, suppresses output/redirects and bounds unfinished stdin and network stalls', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-native-send-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'native-macos.js'), (await readFile(new URL('core.js', source), 'utf8')) + '\n' + await readFile(new URL('macos.js', source), 'utf8'));
  await writeFile(join(dir, 'send-hook.sh'), await readFile(new URL('send-hook.sh', source)));
  let received = ''; let auth = ''; let mode = 'ok'; let calls = 0;
  const server = createServer((request, response) => {
    calls++; auth = request.headers.authorization ?? ''; let input = '';
    request.setEncoding('utf8'); request.on('data', data => { input += data; }); request.on('end', () => {
      received = input;
      if (mode === 'redirect') response.writeHead(302, { Location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/redirected` }).end();
      else if (mode === 'ok') response.end('must not reach IDE');
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = await managedRuntime(dir);
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ protocol_version: 2, runtime_owner: runtime.owner, installation_id: installationId, token, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks` }), { mode: 0o600 });
  async function send(raw: string | Buffer, end = true) {
    await runtime.renew();
    const start = performance.now(); const child = spawn('/bin/bash', [join(dir, 'send-hook.sh'), config], { env: { ...runtime.env, PATH: '/usr/bin:/bin' } });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.on('error', () => {});
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000); const exited = once(child, 'exit');
    if (end) child.stdin.end(raw); else child.stdin.write(raw);
    const [code, signal] = await exited; clearTimeout(timeout);
    assert.equal(signal, null); assert.equal(code, 0); assert.equal(stdout, ''); assert.equal(stderr, ''); assert.ok(performance.now() - start < 1200);
  }
  const raw = '{"hook_event_name":"UserPromptSubmit","session_id":"native","prompt":"中文\\nline","n":9007199254740993}';
  await send(raw); assert.equal(auth, `Bearer ${token}`); assert.ok(received.endsWith('"payload":' + raw + '}')); assert.equal(calls, 1);
  mode = 'redirect'; await send(raw); assert.equal(calls, 2);
  mode = 'stall'; await send(raw); assert.equal(calls, 3);
  await send('{', false); await send('{'); await send(Buffer.from([0xff])); await send('x'.repeat(3*1024*1024)); assert.equal(calls, 3);
});
