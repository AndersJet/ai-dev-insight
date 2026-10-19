import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from '../packages/storage/test/helpers.ts';
import { createIdentityService, createAnalyticsService } from '../packages/domain/dist/index.js';

// Fixed synthetic scale and the same isolated-target guard as integration tests.
// This captures the SQL actually used by the public analytics service.
const cleanup = [];
const db = await testDatabase({ after: callback => cleanup.push(callback) });
try {
  await db.migrate(); const now = new Date(); const at = new Date(now.getTime() - 86_400_000);
  await db.ensurePartitions(new Date(now.getTime() - 70 * 86_400_000), new Date(now.getTime() + 86_400_000));
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'plan-root@example.invalid', name: '合成计划核验' });
  const temporary = await identity.login('plan-root@example.invalid', seed.temporaryPassword);
  const actor = await identity.changePassword(temporary.token, seed.temporaryPassword, 'synthetic-plan-only-password');
  const department = randomUUID(); await db.query('INSERT INTO departments(id,name) VALUES($1,$2)', [department, '合成计划部门']);
  const people = (await db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'plan-'||g::text||'@example.invalid','合成人员'||g::text FROM generate_series(1,500) g RETURNING id")).rows.map(row => row.id);
  await db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) SELECT unnest($1::uuid[]),$2,$3::timestamptz-interval '7 days'", [people, department, now]);
  await db.query("INSERT INTO eligibility_periods(user_id,included,valid_from) SELECT unnest($1::uuid[]),true,$2::timestamptz-interval '7 days'", [people, now]);
  // These hashes are synthetic identifiers, never issued credentials.
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) SELECT gen_random_uuid(),u,md5(u::text)||md5(u::text),'计划夹具' FROM unnest($1::uuid[]) u", [people]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) SELECT gen_random_uuid(),u,'plan-fixture',$2::timestamptz,$2::timestamptz+interval '19 milliseconds' FROM unnest($1::uuid[]) u", [people, at]);
  await db.query("INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload) SELECT gen_random_uuid(),$2::timestamptz+g*interval '1 millisecond',$3,s.user_id,$4,i.id,s.id,'UserPromptSubmit','{}'::jsonb FROM sessions s JOIN installations i ON i.user_id=s.user_id CROSS JOIN generate_series(0,19) g WHERE s.user_id=ANY($1::uuid[])", [people, at, now, department]);
  for (const table of ['users', 'membership_periods', 'eligibility_periods', 'sessions', 'installations', 'hook_events']) await db.query(`ANALYZE ${table}`);
  let statement;
  const traced = new Proxy(db, { get(target, property) { if (property === 'query') return (sql, values) => { statement = { sql, values }; return target.query(sql, values); }; return Reflect.get(target, property); } });
  const analytics = createAnalyticsService(traced, identity); const started = performance.now();
  const result = await analytics.overview(actor.token, { from: new Date(now.getTime() - 2 * 86_400_000).toISOString(), to: now.toISOString() });
  if (result.prompt_turns !== 10_000 || result.observed_users !== 500 || result.coverage_ratio !== 1 || !statement) throw new Error('Plan fixture statistics mismatch');
  const elapsed = performance.now() - started;
  const plan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.sql}`, statement.values)).rows[0]['QUERY PLAN'][0];
  const relations = (await db.query(`SELECT c.relname AS name,pg_table_size(c.oid)::text AS table_bytes,pg_indexes_size(c.oid)::text AS index_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`, [db.schema])).rows;
  const indexes = (await db.query(`SELECT c.relname AS name,t.relname AS table_name,pg_relation_size(c.oid)::text AS bytes
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND c.relkind='i' ORDER BY t.relname,c.relname`, [db.schema])).rows;
  const storage = { relations, indexes,
    table_bytes: relations.reduce((sum, row) => sum + BigInt(row.table_bytes), 0n).toString(),
    index_bytes: relations.reduce((sum, row) => sum + BigInt(row.index_bytes), 0n).toString(),
    scope: 'Owned synthetic schema relation files only; includes empty precreated partitions, excludes WAL, backups and shared system files. Not an annual capacity forecast.' };
  const report = { checked_at: new Date().toISOString(), fixture: { people: 500, events: 10_000, payload: 'empty synthetic JSON; not representative of production payload size' }, endpoint_ms: elapsed, plan, storage };
  await mkdir(new URL('../.run/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.run/analytics-plan.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ people: 500, events: 10_000, endpoint_ms: elapsed, sql_execution_ms: plan['Execution Time'], table_bytes: storage.table_bytes, index_bytes: storage.index_bytes }));
} finally { for (const action of cleanup.reverse()) await action(); }
