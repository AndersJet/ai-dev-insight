import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase, connectionString } from '../../../../packages/storage/test/helpers.js';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test('local dev loads the selected environment, initializes four applications and exits without stopping its database', { timeout: 60000 }, async t => {
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-dev-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apiPort = await freePort(), webPort = await freePort(), collectorPort = await freePort();
  const file = join(directory, 'development.env');
  await writeFile(file, Object.entries({ ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_EMAIL_DOMAINS: 'example.invalid', ADI_ADMIN_EMAIL: 'dev@example.invalid', ADI_ADMIN_PASSWORD: 'synthetic-local-password', ADI_API_PORT: apiPort, ADI_WEB_PORT: webPort, ADI_COLLECTOR_PORT: collectorPort, ADI_CLEANUP_JOURNAL_DIR: join(directory, 'journal') }).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: file }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; const pids = new Set<number>();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-40000); for (const match of String(chunk).matchAll(/"pid":(\d+)/g)) pids.add(Number(match[1])); });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
  const deadline = Date.now() + 40000; let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const [api, web, collector] = await Promise.all([fetch(`http://127.0.0.1:${apiPort}/api/v1/me`),fetch(`http://127.0.0.1:${webPort}/login`),fetch(`http://127.0.0.1:${collectorPort}/readyz`)]);
      ready = api.status === 401 && web.ok && collector.ok;
      await Promise.all([api.body?.cancel(),web.body?.cancel(),collector.body?.cancel()]); if (ready) break;
    } catch { /* Startup still building or initializing. */ }
    await delay(100);
  }
  if (!ready) t.diagnostic(output.replaceAll(connectionString, '[test database]').replaceAll('synthetic-local-password', '[test password]'));
  assert.equal(ready, true, 'all local application endpoints must become ready');
  const login = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.invalid', password: 'synthetic-local-password' }) });
  assert.equal(login.status, 200); assert.equal((await login.json()).data.must_change_password, false);
  assert.match(output, /worker_supervisor_started/); assert.doesNotMatch(output, /synthetic-local-password/);
  child.kill('SIGINT'); const [code] = await exited; assert.equal(code, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0]!.n, 1);
  assert.ok(pids.size >= 7);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
