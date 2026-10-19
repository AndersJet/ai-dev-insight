import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {parseIntoClientConfig} from 'pg-connection-string';
import {testDatabase,connectionString,migrationPrefix} from './helpers.js';
import {migrateDatabase} from '../src/migrate.js';

const generated="CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END";
async function beforeNormalized(t:TestContext){
 const db=await testDatabase(t),directory=await migrationPrefix(t,'202610100002_snapshot_safety_and_prompt_search');
 await migrateDatabase(parseIntoClientConfig(connectionString),db.schema,directory);await db.ensurePartitions(new Date('2026-09-01'),new Date('2026-11-01'));return db;
}
test('normal bounded migration reuses exact native stored prompt projection and attached GIN, with complete partition coverage',async t=>{
 const db=await beforeNormalized(t);await db.query(`ALTER TABLE hook_events ADD COLUMN prompt_search text GENERATED ALWAYS AS (${generated}) STORED`);
 await db.query("CREATE INDEX hook_prompt_search_trgm ON hook_events USING gin(prompt_search public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'");
 const before=(await db.query("SELECT 'hook_prompt_search_trgm'::regclass::oid AS id")).rows[0]!.id;
 await db.migrate();assert.equal((await db.query("SELECT 'hook_prompt_search_trgm'::regclass::oid AS id")).rows[0]!.id,before);
 const columns=(await db.query<{stored:string;native:boolean}>("SELECT a.attgenerated AS stored,pg_get_expr(d.adbin,d.adrelid) LIKE '%lower((payload%' AS native FROM pg_partition_tree('hook_events') p JOIN pg_attribute a ON a.attrelid=p.relid AND a.attname='prompt_search' JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum")).rows;
 assert.ok(columns.length>=3);assert.ok(columns.every(column=>column.stored==='s'&&column.native));
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='202610100003_snapshot_normalized_prompt_search'")).rows[0]!.n,1);
});
for(const [kind,column]of [
 ['plain text','text'],
 ['different generated expression',"text GENERATED ALWAYS AS (lower(payload->>'prompt')) STORED"],
 ['different collation',`text COLLATE "C" GENERATED ALWAYS AS (${generated}) STORED`],
] as const)test(`a preexisting ${kind} column cannot impersonate exact native prompt search`,async t=>{
 const db=await beforeNormalized(t);await db.query('ALTER TABLE hook_events ADD COLUMN prompt_search '+column);await assert.rejects(db.migrate(),{code:'55000'});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name='202610100003_snapshot_normalized_prompt_search'")).rows[0]!.n,0);
 await db.query('ALTER TABLE hook_events DROP COLUMN prompt_search');await db.migrate();
});
for(const [kind,definition]of [
 ['btree','CREATE INDEX hook_prompt_search_trgm ON hook_events(user_id)'],
 ['wrong field',"CREATE INDEX hook_prompt_search_trgm ON hook_events USING gin((payload->>'prompt') public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'"],
 ['no partial predicate',"CREATE INDEX hook_prompt_search_trgm ON hook_events USING gin(prompt_search public.gin_trgm_ops)"],
] as const)test(`a preexisting ${kind} index cannot impersonate native normalized GIN`,async t=>{
 const db=await beforeNormalized(t);await db.query(`ALTER TABLE hook_events ADD COLUMN prompt_search text GENERATED ALWAYS AS (${generated}) STORED`);await db.query(definition);
 await assert.rejects(db.migrate(),{code:'55000'});await db.query('DROP INDEX hook_prompt_search_trgm');await db.migrate();
});
test('a partition with a substituted generated expression cannot impersonate the parent native projection',async t=>{
 const db=await beforeNormalized(t);await db.query(`ALTER TABLE hook_events ADD COLUMN prompt_search text GENERATED ALWAYS AS (${generated}) STORED`);
 await db.query("ALTER TABLE hook_events_202609 ALTER COLUMN prompt_search SET EXPRESSION AS (lower(payload->>'prompt'))");
 await assert.rejects(db.migrate(),{code:'55000'});
 await db.query(`ALTER TABLE hook_events_202609 ALTER COLUMN prompt_search SET EXPRESSION AS (${generated})`);await db.migrate();
});
