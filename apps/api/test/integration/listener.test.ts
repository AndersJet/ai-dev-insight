import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

test('API process serves the explicitly configured interface and shuts down cleanly', { timeout: 12_000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '::1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/main.js', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', ADI_DATABASE_URL: '', ADI_API_HOST: '::1', ADI_API_PORT: String(address.port) },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    let status: number | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const response = await fetch(`http://[::1]:${address.port}/api/v1/me`, { signal: AbortSignal.timeout(400) }); status = response.status; await response.body?.cancel(); break; }
      catch { await delay(40); }
    }
    assert.equal(status, 401, 'the configured listener must serve the authenticated API');
    child.kill('SIGTERM');
    const result = await Promise.race([exited, delay(2_000).then(() => null)]);
    assert.ok(result, 'SIGTERM must close the HTTP listener');
    assert.equal(result[0], 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
});
