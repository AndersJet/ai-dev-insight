import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('bootstrap tooling reports configuration failure without printing credential-bearing URLs', async () => {
  const run = promisify(execFile);
  try {
    await run(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'migrate'], { env: { ...process.env, ADI_DATABASE_URL: 'postgres://user:fixture-secret@%' } });
    assert.fail('Malformed configuration must fail');
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'stderr' in error);
    const stderr = String(error.stderr);
    assert.ok(!stderr.includes('fixture-secret'));
    assert.match(stderr, /invalid_database_url/);
  }
});

test('init provisions a fresh database from environment and repeated startup preserves sessions', async t => {
  const { testDatabase, connectionString } = await import('../../../../packages/storage/test/helpers.js');
  const { createIdentityService } = await import('../../../../packages/domain/src/identity.js');
  const db = await testDatabase(t), run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'adi-cli-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_INSTALLATION_KEY_FILE: join(directory, 'credential.key'), ADI_EMAIL_DOMAINS: 'example.invalid', ADI_ADMIN_EMAIL: 'init@example.invalid', ADI_ADMIN_PASSWORD: 'init-configured-password' };
  const init = () => run(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init'], { env });
  const result = await init(); assert.doesNotMatch(result.stdout + result.stderr, /init-configured-password|password_hash/);
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const loggedIn = await identity.login(env.ADI_ADMIN_EMAIL, env.ADI_ADMIN_PASSWORD);
  assert.equal(loggedIn.user.must_change_password, false);
  await init(); assert.ok(await identity.resolve(loggedIn.token));
});

test('startup CLI explains why a populated legacy dataset needs an independent clean target', async t => {
  const { testDatabase, connectionString } = await import('../../../../packages/storage/test/helpers.js');
  const { migrateDatabase } = await import('../../../../packages/storage/src/migrate.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-cli-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrations = new URL('../../../../packages/storage/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql') && name < '202610090001_')) {
    await copyFile(new URL(name, migrations), join(directory, name));
  }
  await migrateDatabase({ connectionString }, db.schema, directory);
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES(gen_random_uuid(),'legacy-private@example.invalid','合成旧账号')");
  const env = { ...process.env, ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_INSTALLATION_KEY_FILE: join(directory, 'credential.key'), ADI_EMAIL_DOMAINS: 'example.invalid', ADI_ADMIN_EMAIL: 'init@example.invalid', ADI_ADMIN_PASSWORD: 'synthetic-cli-admin-password' };
  for (const action of ['init', 'migrate']) {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), action], { env }), error => {
      assert.ok(error && typeof error === 'object' && 'stderr' in error && 'code' in error);
      assert.equal(error.code, 1);
      const stderr = String(error.stderr), result = JSON.parse(stderr);
      assert.equal(result.error, 'independent_clean_dataset_required');
      assert.match(result.message, /独立.*目标/);
      assert.match(result.message, /dataset-rebuild-cli/);
      assert.doesNotMatch(stderr, /legacy-private|synthetic-cli-admin-password|password_hash|RAISE EXCEPTION|postgres:\/\//);
      return true;
    });
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0]?.n, 1);
});

test('migration CLI identifies checksum mismatches without exposing database details', async t => {
  const { testDatabase, connectionString } = await import('../../../../packages/storage/test/helpers.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-cli-checksum-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await db.migrate();
  await db.query("UPDATE migration_checksums SET checksum='synthetic-private-checksum'");
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'migrate'], { env: { ...process.env, ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_INSTALLATION_KEY_FILE: join(directory, 'credential.key') } }), error => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error && 'code' in error);
    assert.equal(error.code, 1);
    const stderr = String(error.stderr), result = JSON.parse(stderr);
    assert.equal(result.error, 'migration_checksum_mismatch');
    assert.match(result.message, /迁移.*不一致/);
    assert.doesNotMatch(stderr, /synthetic-private-checksum|postgres:\/\//);
    return true;
  });
});

test('migration CLI explains that an unmanaged nonempty schema must be preserved', async t => {
  const { testDatabase, connectionString } = await import('../../../../packages/storage/test/helpers.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-cli-nonempty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await db.query(`CREATE SCHEMA "${db.schema}"`);
  await db.query('CREATE TABLE synthetic_private_table(value text)');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'migrate'], { env: { ...process.env, ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_INSTALLATION_KEY_FILE: join(directory, 'credential.key') } }), error => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error && 'code' in error);
    assert.equal(error.code, 1);
    const stderr = String(error.stderr), result = JSON.parse(stderr);
    assert.equal(result.error, 'migration_schema_not_empty');
    assert.match(result.message, /保留.*独立.*目标/);
    assert.doesNotMatch(stderr, /synthetic_private_table|postgres:\/\//);
    return true;
  });
  await db.query('SELECT value FROM synthetic_private_table');
});

test('migration CLI hides arbitrary SQL exceptions that merely start with a known guard message', async t => {
  const { testDatabase, connectionString } = await import('../../../../packages/storage/test/helpers.js');
  const { migrateDatabase } = await import('../../../../packages/storage/src/migrate.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-cli-sql-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrations = new URL('../../../../packages/storage/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql') && name < '202610090001_')) {
    await copyFile(new URL(name, migrations), join(directory, name));
  }
  await migrateDatabase({ connectionString }, db.schema, directory);
  await db.query("CREATE FUNCTION synthetic_private_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'independent_clean_dataset_required synthetic-private-sql-detail'; END $$");
  await db.query('CREATE TRIGGER synthetic_private_error BEFORE INSERT ON migration_checksums FOR EACH ROW EXECUTE FUNCTION synthetic_private_error()');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'migrate'], { env: { ...process.env, ADI_DATABASE_URL: connectionString, ADI_DATABASE_SCHEMA: db.schema, ADI_INSTALLATION_KEY_FILE: join(directory, 'credential.key') } }), error => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error && 'code' in error);
    assert.equal(error.code, 1);
    const result=JSON.parse(String(error.stderr));
    assert.equal(result.error,'operation_failed');assert.equal(result.stage,'migrate');assert.equal(result.sqlstate,'P0001');
    assert.doesNotMatch(String(error.stderr),/synthetic-private-sql-detail|RAISE EXCEPTION|postgres:\/\//);
    return true;
  });
});
