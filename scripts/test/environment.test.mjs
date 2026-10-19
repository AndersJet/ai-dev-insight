import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvironment, environmentFor } from '../lib/environment.mjs';
test('environment precedence is shell then selected file then defaults, with literal passwords and role isolation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'adi-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'local.env'); writeFileSync(file, 'ADI_WEB_PORT=5000\nADI_ADMIN_PASSWORD="$(literal)$VALUE#secret"\nADI_DATABASE_URL=private-db\nTRAE_OPENAPI_APP_SECRET=private-provider\n');
  const env = loadEnvironment({ ENV_FILE: file, ADI_WEB_PORT: '5001', PATH: process.env.PATH });
  assert.equal(env.ADI_WEB_PORT, '5001'); assert.equal(env.ADI_API_PORT, '4180');
  assert.equal(env.ADI_ADMIN_PASSWORD, '$(literal)$VALUE#secret');
  assert.equal(env.ADI_WEB_ORIGIN, 'http://127.0.0.1:5001');
  const web = environmentFor(env, 'web'); assert.equal(web.ADI_WEB_PORT, '5001');
  for (const key of ['ADI_ADMIN_PASSWORD','ADI_DATABASE_URL','TRAE_OPENAPI_APP_SECRET']) assert.equal(web[key], undefined);
  assert.equal(environmentFor(env, 'worker').ADI_ADMIN_PASSWORD, undefined);
  assert.equal(environmentFor(env, 'api').TRAE_OPENAPI_APP_SECRET, undefined);
  assert.equal(environmentFor(env, 'init').ADI_ADMIN_PASSWORD, env.ADI_ADMIN_PASSWORD);
});

test('the Stop trial flag reaches API and worker while remaining outside the web environment',()=>{
 const env={ADI_USAGE_STOP_WINDOW_ENABLED:'true'};
 assert.equal(environmentFor(env,'api').ADI_USAGE_STOP_WINDOW_ENABLED,'true');
 assert.equal(environmentFor(env,'worker').ADI_USAGE_STOP_WINDOW_ENABLED,'true');
 assert.equal(environmentFor(env,'web').ADI_USAGE_STOP_WINDOW_ENABLED,undefined);
});

test('dev reports an invalid database URL before building and never prints the credential', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const dir = mkdtempSync(join(tmpdir(), 'adi-invalid-url-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'local.env');
  writeFileSync(file, 'ADI_DATABASE_URL="postgres://fixture:unencoded/password@127.0.0.1:55438/adi_test"\nADI_ADMIN_EMAIL=fixture@example.invalid\nADI_ADMIN_PASSWORD=synthetic-admin-password\n');
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/dev.mjs'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: file }, timeout: 15000 }), error => {
    const output = String(error.stdout) + String(error.stderr);
    assert.match(output, /invalid_database_url/);
    assert.doesNotMatch(output, /Scope:|build\$|unencoded\/password|synthetic-admin-password/);
    return true;
  });
});
