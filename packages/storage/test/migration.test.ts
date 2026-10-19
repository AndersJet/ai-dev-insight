import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
const migrationNames = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
// Historical upgrade characterizations stop at the complete pre-rebuild ledger.
// A populated schema must never silently cross into the new dataset protocol.
const legacyMigrationNames=migrationNames.filter(name=>name<'202610090001_');
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, connectionString } from './helpers.js';
import { openDatabase } from '../src/index.js';
import {setTimeout as delay} from 'node:timers/promises';

test('connection URL options cannot override the dedicated schema or statement limit', async t => {
  const baseline = await testDatabase(t); await baseline.migrate();
  const url = new URL(connectionString); url.searchParams.set('options', '-c search_path=public -c timezone=Pacific/Honolulu -c datestyle=SQL,DMY'); url.searchParams.set('statement_timeout', '0');
  const db = openDatabase({ connectionString: url.href, schema: baseline.schema }); t.after(() => db.close());
  const state = (await db.query("SELECT current_schema() AS schema,current_setting('statement_timeout') AS timeout,current_setting('TimeZone') AS zone,current_setting('DateStyle') AS dates")).rows[0];
  assert.equal(state?.schema, baseline.schema); assert.equal(state?.timeout, '5s'); assert.equal(state?.zone, 'UTC'); assert.equal(state?.dates, 'ISO, MDY');
});

test('migrations can run twice and deleted accounts still reserve their unique email', async t => {
  const db = await testDatabase(t);
  await db.migrate(); await db.migrate();
  const id = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name,status) VALUES($1,$2,$3,$4)', [id, 'person@example.invalid', '合成员工', 'deleted']);
  await assert.rejects(db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [randomUUID(), 'person@example.invalid', '重复身份']), { code: '23505' });
  const rows = await db.query<{ id: string }>('SELECT id FROM users WHERE email_key=$1', ['person@example.invalid']);
  assert.equal(rows.rows[0]?.id, id);
});
test('concurrent migration runners serialize and altered migration checksums are rejected', async t => {
  const db = await testDatabase(t);
  await Promise.all([db.migrate(), db.migrate()]);
  await db.query('UPDATE migration_checksums SET checksum=$1', ['tampered']);
  await assert.rejects(db.migrate(), /migration_checksum_mismatch/);
});
test('migration setup can wait for shared extension initialization without changing ordinary transaction deadlines',{timeout:15000},async t=>{
  const owner=await testDatabase(t);await owner.migrate();const target=await testDatabase(t);
  let release!:()=>void,locked!:(pid:number)=>void,lockFailed!:(error:unknown)=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>((resolve,reject)=>{locked=resolve;lockFailed=reject;});
  const holder=owner.transaction(async client=>{
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('adi:extension:btree_gist',0))");
    locked((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number);await gate;
  });
  void holder.catch(lockFailed);
  const blocker=await ready;
  const migrated=target.migrate().then(()=>({ok:true,code:''}),error=>({ok:false,code:String(error.code)}));
  try{
    let waiting=false;const deadline=Date.now()+3000;
    while(Date.now()<deadline){waiting=Boolean((await owner.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rowCount);if(waiting)break;await delay(10);}
    assert.equal(waiting,true,'observe the real migration waiting for the shared extension lock');
    await delay(1500);
  }finally{release();await holder;}
  assert.deepEqual(await migrated,{ok:true,code:''});
  assert.equal((await target.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0]!.n,migrationNames.length);
  assert.equal(await target.transaction(async client=>(await client.query('SHOW lock_timeout')).rows[0]!.lock_timeout),'1s');
});
test('an unavailable migration lock still times out without leaving a partial schema and can be retried',{timeout:15000},async t=>{
  const owner=await testDatabase(t);await owner.migrate();const target=await testDatabase(t);
  let release!:()=>void,locked!:(pid:number)=>void,lockFailed!:(error:unknown)=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>((resolve,reject)=>{locked=resolve;lockFailed=reject;});
  t.signal.addEventListener('abort',()=>release(),{once:true});
  // This key belongs only to the target schema, so the deliberate long wait
  // cannot make unrelated test files time out on the database-wide extension.
  const holder=owner.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`adi:migrate:${target.schema}`]);
    locked((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number);await gate;
  });
  void holder.catch(lockFailed);const blocker=await ready;
  const attempted=target.migrate().then(()=>({ok:true,code:''}),error=>({ok:false,code:String(error.code)}));
  try{
    let waiting=false;const deadline=Date.now()+3000;
    while(Date.now()<deadline){waiting=Boolean((await owner.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rowCount);if(waiting)break;await delay(10);}
    assert.equal(waiting,true);
    const outcome=await attempted;assert.equal(outcome.ok,false);assert.ok(['55P03','57014','database_io_timeout'].includes(outcome.code),outcome.code);
  }finally{release();await holder;}
  assert.equal((await target.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present',[target.schema])).rows[0]!.present,false);
  await target.migrate();assert.equal((await target.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0]!.n,migrationNames.length);
});
test('department management grants are separate from membership and cannot masquerade as global roles', async t => {
  const db = await testDatabase(t); await db.migrate();
  const user = randomUUID(); const a = randomUUID(); const b = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'scope@example.invalid', '多部门管理']);
  await db.query('INSERT INTO departments(id,name) VALUES($1,$2),($3,$4)', [a, 'A', b, 'B']);
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [user, a, '2026-09-01T00:00:00Z']);
  for (const id of [a, b]) await db.query('INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,$2,$3,$4)', [user, 'department_admin', id, '2026-09-01T00:00:00Z']);
  await assert.rejects(db.query('INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,$2,$3,$4)', [user, 'super', a, '2026-09-01T00:00:00Z']), { code: '23514' });
  await assert.rejects(db.query('INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,$2,$3)', [user, 'department_admin', '2026-09-01T00:00:00Z']), { code: '23514' });
  const grants = await db.query<{ count: string }>('SELECT count(*) FROM role_grants WHERE user_id=$1', [user]);
  const memberships = await db.query<{ count: string }>('SELECT count(*) FROM membership_periods WHERE user_id=$1', [user]);
  assert.equal(grants.rows[0]?.count, '2'); assert.equal(memberships.rows[0]?.count, '1');
});
test('membership periods allow a transfer boundary but reject overlapping departments', async t => {
  const db = await testDatabase(t); await db.migrate();
  const user = randomUUID(); const before = randomUUID(); const after = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'transfer@example.invalid', '调岗员工']);
  await db.query('INSERT INTO departments(id,name) VALUES($1,$2),($3,$4)', [before, '部门A', after, '部门B']);
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4)', [user, before, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z']);
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [user, after, '2026-09-01T00:00:00Z']);
  await assert.rejects(db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4)', [user, after, '2026-08-20T00:00:00Z', '2026-09-02T00:00:00Z']), { code: '23P01' });
  const old = await db.query<{ department_id: string }>('SELECT department_id FROM membership_periods WHERE user_id=$1 AND tstzrange(valid_from,valid_to,$3) @> $2::timestamptz', [user, '2026-08-25T00:00:00Z', '[)']);
  assert.equal(old.rows[0]?.department_id, before);
});

test('a failure after an earlier migration rolls back its DDL and ledger before a clean retry', async t => {
  const db = await testDatabase(t);
  // A real relation collision in migration 2 follows migration 1's users DDL.
  // The pre-existing fixture must survive; all work in the failed migrate call must not.
  await db.query(`CREATE SCHEMA "${db.schema}"`);
  await db.query('CREATE TABLE departments(marker text PRIMARY KEY)');
  await db.query("INSERT INTO departments VALUES('preexisting-fixture')");
  await assert.rejects(db.migrate(), { code: 'migration_schema_not_empty' });
  const tables = await db.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [db.schema]);
  assert.deepEqual(tables.rows.map(row => row.table_name), ['departments']);
  assert.equal((await db.query('SELECT marker FROM departments')).rows[0]?.marker, 'preexisting-fixture');
  await db.query('DROP TABLE departments');
  await db.migrate();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0]?.n, migrationNames.length);
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'after-retry@example.invalid','迁移重试')", [randomUUID()]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0]?.n, 1);
});

test('node-pg-migrate applies future SQL atomically, detects tampering and refuses the retired ledger', async t => {
  const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { parseIntoClientConfig } = await import('pg-connection-string');
  const { migrateDatabase } = await import('../src/migrate.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../migrations/', import.meta.url), directory, { recursive: true });
  const connection = parseIntoClientConfig(connectionString);
  await migrateDatabase(connection, db.schema, directory);
  const nextVersion=BigInt(migrationNames.at(-1)!.split('_')[0]!)+1n;
  const upgrade = join(directory, `${nextVersion}_future.sql`);
  await writeFile(upgrade, 'CREATE TABLE upgrade_probe(id integer); SELECT * FROM missing_upgrade_relation;');
  await assert.rejects(migrateDatabase(connection, db.schema, directory), { code: '42P01' });
  assert.equal((await db.query("SELECT to_regclass('upgrade_probe') AS table")).rows[0]!.table, null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0]!.n, migrationNames.length);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM migration_checksums')).rows[0]!.n, migrationNames.length);
  await writeFile(upgrade, 'CREATE TABLE upgrade_probe(id integer);');
  await migrateDatabase(connection, db.schema, directory);
  await writeFile(upgrade, 'CREATE TABLE upgrade_probe(id bigint);');
  await assert.rejects(migrateDatabase(connection, db.schema, directory), /migration_checksum_mismatch/);
  const old = await testDatabase(t); await old.query(`CREATE SCHEMA "${old.schema}"`); await old.query('CREATE TABLE schema_migrations(version integer)');
  await assert.rejects(old.migrate(), { code: 'migration_schema_not_empty' });
  assert.equal((await old.query("SELECT to_regclass('users') AS table")).rows[0]!.table, null);
});

test('removing registration verification upgrades an applied schema without changing registration or adoption facts',async t=>{
  const {mkdtemp,cp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {parseIntoClientConfig}=await import('pg-connection-string');
  const {migrateDatabase}=await import('../src/migrate.js');
  const db=await testDatabase(t),directory=await mkdtemp(join(tmpdir(),'adi-before-no-mail-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(new URL('../migrations/',import.meta.url),directory,{recursive:true});
  for (const name of migrationNames.filter(name => name >= '202609280002_')) await rm(join(directory,name));
  await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);
  const id=randomUUID(),registered=new Date('2026-09-28T01:00:00Z'),adopted=new Date('2026-09-28T02:00:00Z');
  await db.query("INSERT INTO users(id,email_key,display_name,registered_at,email_verified_at,adopted_at) VALUES($1,'upgrade@example.org','升级测试',$2,$2,$3)",[id,registered,adopted]);
  for(const name of legacyMigrationNames)await cp(new URL('../migrations/'+name,import.meta.url),join(directory,name));
  await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);
  assert.deepEqual((await db.query('SELECT registered_at,adopted_at FROM users WHERE id=$1',[id])).rows[0],{registered_at:registered,adopted_at:adopted});
  assert.equal((await db.query("SELECT to_regclass('registration_challenges') AS relation")).rows[0]!.relation,null);
  const ledger=(await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c USING(name) ORDER BY m.id')).rows,basis=(await db.query('SELECT * FROM users ORDER BY id')).rows;
  await assert.rejects(db.migrate(),/independent_clean_dataset_required/);
  assert.deepEqual((await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c USING(name) ORDER BY m.id')).rows,ledger);
  assert.deepEqual((await db.query('SELECT * FROM users ORDER BY id')).rows,basis,'the rejected new dataset upgrade preserves registered and adopted identities');
  assert.equal((await db.query("SELECT to_regclass('plugin_account_credentials') AS relation")).rows[0]!.relation,null,'the entire new upgrade transaction rolls back');
  await db.query("INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,'unverified@example.org','无需邮箱验证',now())",[randomUUID()]);
  await assert.rejects(db.query("INSERT INTO users(id,email_key,display_name,adopted_at) VALUES($1,'invalid@example.org','注册前不可采纳',now())",[randomUUID()]),{code:'23514'});
});

test('account credential migration preserves existing valid installations and history before explicit reset', async t => {
  const { mkdtemp, cp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { parseIntoClientConfig } = await import('pg-connection-string');
  const { migrateDatabase } = await import('../src/migrate.js');
  const db = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'adi-before-personal-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../migrations/', import.meta.url), directory, { recursive: true });
  for (const name of migrationNames.filter(name => name >= '202609280003_')) await rm(join(directory, name));
  await migrateDatabase(parseIntoClientConfig(connectionString), db.schema, directory);
  const owner = randomUUID(), installation = randomUUID(), at = new Date('2026-09-28T01:00:00Z');
  await db.query("INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,'package-migration@example.invalid','历史采集身份',now())", [owner]);
  await db.query('INSERT INTO installations(id,user_id,label,token_hash,last_seen) VALUES($1,$2,$3,$4,$5)', [installation,owner,'原有采集身份','a'.repeat(64),at]);
  const before = (await db.query('SELECT id,user_id,token_hash,label,last_seen,enabled FROM installations')).rows;
  for(const name of legacyMigrationNames)await cp(new URL('../migrations/'+name,import.meta.url),join(directory,name));
  await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);
  assert.deepEqual((await db.query('SELECT id,user_id,token_hash,label,last_seen,enabled FROM installations')).rows, before);
  assert.equal((await db.query('SELECT credential_ciphertext FROM installations')).rows[0]?.credential_ciphertext, null);
  const ledger=(await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c USING(name) ORDER BY m.id')).rows,basis=(await db.query('SELECT * FROM installations ORDER BY id')).rows;
  await assert.rejects(db.migrate(),/independent_clean_dataset_required/);
  assert.deepEqual((await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c USING(name) ORDER BY m.id')).rows,ledger);
  assert.deepEqual((await db.query('SELECT * FROM installations ORDER BY id')).rows,basis,'the rejected new dataset upgrade cannot rewrite valid credentials or history');
  assert.equal((await db.query("SELECT to_regclass('plugin_account_credentials') AS relation")).rows[0]!.relation,null);
  await db.query("INSERT INTO installations(id,user_id,label,token_hash,credential_ciphertext) VALUES($1,$2,'共用凭据',$3,'synthetic-ciphertext')", [randomUUID(),owner,'b'.repeat(64)]);
  await assert.rejects(db.query("INSERT INTO installations(id,user_id,label,token_hash,credential_ciphertext) VALUES($1,$2,'重复有效共用凭据',$3,'synthetic-ciphertext')", [randomUUID(),owner,'c'.repeat(64)]), { code: '23505' });
});
