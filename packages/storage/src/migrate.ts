import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientConfig } from 'pg';
import { runner, type RunnerOption } from 'node-pg-migrate';
type MigrationLoader = Exclude<NonNullable<RunnerOption['migrationLoaderStrategies']>[number]['loader'], string>;

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const fail = (code: string) => Object.assign(new Error(code), { code });

/** node-pg-migrate owns ordering, SQL execution and its ledger. The loader adds
 * a checksum in the SAME transaction as each SQL migration and ledger entry. */
export async function migrateDatabase(connection: ClientConfig, schema: string, directory = migrationDirectory) {
  const client = new Client({ ...connection, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 6000, idle_in_transaction_session_timeout: 15000, options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c datestyle=ISO,MDY` });
  client.on('error', () => { /* The current query rejects; finally closes this dedicated session. */ });
  try {
    await client.connect();
    await client.query("SET lock_timeout='5s'");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`adi:migrate:${schema}`]);
    const tables = (await client.query<{ relname: string }>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m','S','f')", [schema])).rows;
    if (tables.some(row => row.relname === 'schema_migrations') || (tables.length && !tables.some(row => row.relname === 'pgmigrations'))) throw fail('migration_schema_not_empty');
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query('CREATE TABLE IF NOT EXISTS migration_checksums(name text PRIMARY KEY,checksum text NOT NULL)');
    const loader: MigrationLoader = async paths => {
      const files = await Promise.all(paths.map(async path => {
        const name = basename(path, '.sql');
        if (!/^\d{12,17}_[a-z][a-z0-9_]*$/.test(name) || !path.endsWith('.sql')) throw fail('migration_filename_invalid');
        const sql = await readFile(path, 'utf8');
        return { path, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      }));
      if (!files.length) throw fail('migration_files_missing');
      const history = (await client.query<{ name: string; checksum: string | null }>('SELECT m.name,c.checksum FROM pgmigrations m LEFT JOIN migration_checksums c ON c.name=m.name ORDER BY m.id')).rows;
      const checksums = (await client.query<{ name: string }>('SELECT name FROM migration_checksums')).rows;
      if (checksums.length !== history.length || history.some((row, index) => row.name !== files[index]?.name || row.checksum !== files[index]?.checksum)) throw fail('migration_checksum_mismatch');
      return files.map(file => ({ id: file.path, filePaths: [file.path], actions: { up: pgm => {
        pgm.sql(file.sql);
        pgm.sql(`INSERT INTO migration_checksums(name,checksum) VALUES('${file.name}','${file.checksum}')`);
      }, down: false } }));
    };
    await runner({ dbClient: client, schema, migrationsSchema: schema, migrationsTable: 'pgmigrations', dir: directory,
      direction: 'up', singleTransaction: true, checkOrder: true, advisoryLockMode: 'wait',
      lockValue: parseInt(createHash('sha256').update(`adi:pgm:${schema}`).digest('hex').slice(0, 12), 16),
      migrationLoaderStrategies: [{ extensions: ['.sql'], loader }], log: () => {} });
  } finally {
    // Closing the dedicated session releases BOTH advisory locks, including on timeout.
    await client.end();
  }
}
