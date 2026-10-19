import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { managedRuntime } from './managed-runtime-fixture.js';

test('managed sender rejects paused, retired and monotonic-expired leases before sending any Hook', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-managed-stop-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0; const server = createServer((request, response) => { calls++; request.resume(); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const owner = 'a'.repeat(64),runtime=await managedRuntime(dir,owner);await runtime.renew({enabled:false});
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token: 'adi_' + 'a'.repeat(43), endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`, protocol_version: 2, runtime_owner: owner }), { mode: 0o600 });
  async function send(){const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sender.js', import.meta.url)), '--config', config], { env: runtime.env });
    child.stdin.on('error', () => {}); const exit = once(child, 'exit'); child.stdin.end('{"session_id":"paused","hook_event_name":"Stop"}');
    const [code, signal] = await exit; assert.equal(code, 0); assert.equal(signal, null);}
  await send();assert.equal(calls,0,'paused v2 lease cannot emit a Hook');
  await runtime.renew({enabled:true,version:1});await send();assert.equal(calls,0,'retired v1 runtime proof remains closed');
  const good=runtime.state.leases[0]!;await runtime.renew({leases:[{...good,monotonic_issued_at:good.monotonic_issued_at-60000,monotonic_expires_at:good.monotonic_expires_at-60000}]});await send();assert.equal(calls,0,'a fresh wall expiry cannot revive an expired monotonic lease');
  await runtime.renew();await send();assert.equal(calls,1,'a new genuine lease resumes the same credentials');
});

test('client process sends a lossless installation-bound envelope and never forwards server output to Trae', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-client-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let body = ''; let authorization = '';
  const server = createServer((request, response) => {
    authorization = request.headers.authorization ?? '';
    request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end('{"continue":false,"secret":"must-not-reach-IDE"}'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const token = 'adi_' + 'a'.repeat(43); const installation = 'a163f758-49a9-4d19-b713-0680c1810f66';
  const config = join(dir, 'config.json');
  const runtime = await managedRuntime(dir);
  await writeFile(config, JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`, token, installation_id: installation, protocol_version: 2, runtime_owner: runtime.owner }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sender.js', import.meta.url)), '--config', config], { stdio: ['pipe', 'pipe', 'pipe'], env: runtime.env });
  let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exit = once(child, 'exit'); const deadline = setTimeout(() => child.kill('SIGKILL'), 3000); t.after(() => { clearTimeout(deadline); child.kill('SIGKILL'); });
  const raw = '{"hook_event_name":"UserPromptSubmit","session_id":"client-session","prompt":"合成提示","counter":9007199254740993}';
  child.stdin.end(raw);
  const [code, signal] = await exit; assert.equal(code, 0); assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, '');
  assert.equal(authorization, `Bearer ${token}`); assert.ok(body.includes('9007199254740993'));
  const envelope = JSON.parse(body); assert.equal(envelope.schema_version, 2); assert.equal(envelope.installation_id, installation); assert.equal(envelope.source_session_id, 'client-session');
  assert.equal(envelope.event_type, 'UserPromptSubmit'); assert.equal(envelope.timestamp_source, 'client_observed');
  assert.match(envelope.client_event_id, /^[0-9a-f-]{36}$/); assert.equal(envelope.payload.prompt, '合成提示');
});

test('network failure, unfinished stdin and invalid input finish quietly within a bounded process lifetime', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-client-fault-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0; let redirected = 0;
  const destination = createServer((request, response) => { redirected++; request.resume(); response.end(); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const blackhole = createServer((request, response) => {
    requests++; request.resume();
    if (request.headers['content-length'] && request.url === '/hooks') {
      if (redirectMode) { response.writeHead(302, { Location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/hooks` }); response.end(); }
      // Otherwise intentionally never produce response headers.
    }
  });
  let redirectMode = false;
  blackhole.listen(0, '127.0.0.1'); await once(blackhole, 'listening');
  t.after(() => { for (const server of [blackhole, destination]) { server.closeAllConnections(); server.close(); } });
  const config = join(dir, 'config.json');
  const runtime = await managedRuntime(dir);
  await writeFile(config, JSON.stringify({ endpoint: `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}/hooks`, token: 'adi_' + 'b'.repeat(43), installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', protocol_version: 2, runtime_owner: runtime.owner }), { mode: 0o600 });
  async function run(input: string | Buffer, path = config, end = true) {
    await runtime.renew();
    const started = performance.now(); const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sender.js', import.meta.url)), '--config', path], { stdio: ['pipe', 'pipe', 'pipe'], env: runtime.env });
    let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.on('error', () => {});
    const exit = once(child, 'exit'); const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      if (end) child.stdin.end(input); else child.stdin.write(input);
      const [code, signal] = await exit;
      assert.equal(code, 0); assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, '');
      const elapsed = performance.now() - started; assert.ok(elapsed < 1200, `process lifetime ${elapsed.toFixed(0)}ms exceeded controlled test bound`); return elapsed;
    } finally { clearTimeout(deadline); child.kill('SIGKILL'); }
  }
  const valid = '{"session_id":"fault-test","hook_event_name":"Stop","last_assistant_message":"合成输出"}';
  const slow = await run(valid); t.diagnostic(`blackhole exit: ${slow.toFixed(1)}ms including Node startup`); assert.equal(requests, 1);
  const stdin = await run('{', config, false); t.diagnostic(`unfinished stdin exit: ${stdin.toFixed(1)}ms including Node startup`); assert.equal(requests, 1);
  await run(valid, join(dir, 'missing.json')); await run('{'); await run(Buffer.from([0xff])); await run('x'.repeat(3 * 1024 * 1024));
  assert.equal(requests, 1, 'invalid or oversized inputs must not be transmitted');
  redirectMode = true; await run(valid); assert.equal(requests, 2); assert.equal(redirected, 0, 'credentials must not follow redirects');
  await new Promise<void>(resolve => blackhole.close(() => resolve())); await run(valid); assert.equal(requests, 2);
});
