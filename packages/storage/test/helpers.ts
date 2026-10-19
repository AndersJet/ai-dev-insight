import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openDatabase } from '../src/index.js';

// Tests are deliberately incapable of targeting the company host or an arbitrary DB.
export const connectionString = process.env.ADI_TEST_DATABASE_URL ?? 'postgres://adi_test:adi_test_local_only@127.0.0.1:55438/adi_test';
const target = new URL(connectionString);
const localTest = ['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === '55438';
const ciService = process.env.CI === 'true' && target.hostname === 'postgres-test' && target.port === '5432';
if (!(localTest || ciService) || target.pathname !== '/adi_test' || target.username !== 'adi_test' || target.search || target.hash) throw new Error('Integration tests require the isolated adi_test database without URL overrides (local 55438 or CI postgres-test:5432)');

export async function testDatabase(t: TestContext) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const db = openDatabase({ connectionString, schema });
  t.after(async () => {
    await db.close();
    const admin = openDatabase({ connectionString, schema, maxConnections: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.close(); }
  });
  return db;
}

/** A historical database must contain a contiguous migration prefix, never later releases. */
export async function migrationPrefix(t: TestContext, lastMigration: string) {
  const source = new URL('../migrations/', import.meta.url);
  const files = (await readdir(source)).filter(file => file.endsWith('.sql') && file <= lastMigration + '.sql').sort();
  if (!files.includes(lastMigration + '.sql')) throw new Error('missing_migration_fixture_boundary');
  const directory = await mkdtemp(join(tmpdir(), 'adi-migration-prefix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(files.map(file => copyFile(new URL(file, source), join(directory, file))));
  return directory;
}

// CI reaches its PostgreSQL service directly using client-18 binaries; the local
// Docker fallback is restricted to the already-whitelisted local test database.
export function testPostgresCommand(tool: 'pg_dump' | 'pg_restore') {
  const native = ciService || process.env.ADI_TEST_PG_TOOLS === 'native';
  const args = ['--username=adi_test', '--dbname=adi_test', '--no-password'];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: 'C', PGHOST: target.hostname, PGPORT: target.port,
    PGUSER: 'adi_test', PGDATABASE: 'adi_test', PGPASSWORD: decodeURIComponent(target.password), PGCONNECT_TIMEOUT: '5',
  };
  return native ? { file: tool, args, env } : {
    file: 'docker', args: ['exec', ...(tool === 'pg_restore' ? ['-i'] : []), 'adi-test-postgres-test-1', tool, ...args], env: process.env,
  };
}
export function testPostgresExecLine(tool: 'pg_dump' | 'pg_restore') {
  const command = testPostgresCommand(tool);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return 'exec ' + [command.file, ...command.args].map(quote).join(' ') + ' "$@"';
}
