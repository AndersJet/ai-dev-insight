import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {parseIntoClientConfig} from 'pg-connection-string';
import {testDatabase,connectionString,migrationPrefix} from './helpers.js';
import {migrateDatabase} from '../src/migrate.js';

async function beforeSearchMigration(t:TestContext){
 const db=await testDatabase(t),directory=await migrationPrefix(t,'202610100001_session_list_snapshots');
 await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);
 return db;
}

test('an administrator-prebuilt exact prompt GIN index is reused and verified by the normal bounded migration',async t=>{
 const db=await beforeSearchMigration(t);
 await db.query("CREATE INDEX hook_prompt_trgm ON hook_events USING gin ((payload->>'prompt') public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'");
 const before=(await db.query("SELECT 'hook_prompt_trgm'::regclass::oid AS id")).rows[0]!.id;
 await db.migrate();
 const after=(await db.query("SELECT 'hook_prompt_trgm'::regclass::oid AS id")).rows[0]!.id;
 assert.equal(after,before,'application migration must not rebuild an existing valid administrator index');
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='202610100002_snapshot_safety_and_prompt_search'")).rows[0]!.n,1);
});

for(const [kind,statement]of [
 ['btree','CREATE INDEX hook_prompt_trgm ON hook_events(user_id)'],
 ['wrong expression',"CREATE INDEX hook_prompt_trgm ON hook_events USING gin ((payload->>'last_assistant_message') public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'"],
 ['missing predicate',"CREATE INDEX hook_prompt_trgm ON hook_events USING gin ((payload->>'prompt') public.gin_trgm_ops)"],
] as const)test(`a same-name ${kind} index cannot impersonate the required prompt search index`,async t=>{
 const db=await beforeSearchMigration(t);await db.query(statement);
 await assert.rejects(db.migrate(),{code:'55000'});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='202610100002_snapshot_safety_and_prompt_search'")).rows[0]!.n,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM migration_checksums WHERE name='202610100002_snapshot_safety_and_prompt_search'")).rows[0]!.n,0);
 await db.query('DROP INDEX hook_prompt_trgm');await db.migrate();
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='202610100002_snapshot_safety_and_prompt_search'")).rows[0]!.n,1);
});
