import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from '../packages/storage/test/helpers.ts';
import { createIdentityService, createAnalyticsService, createSessionDerivationService } from '../packages/domain/dist/index.js';

const cleanup = []; const db = await testDatabase({ after: callback => cleanup.push(callback) });
try {
  await db.migrate(); const now = new Date(); const at = new Date(now.getTime() - 86_400_000);
  await db.ensurePartitions(new Date(now.getTime() - 70 * 86_400_000), new Date(now.getTime() + 86_400_000));
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'estimate-plan@example.invalid', name: '估算计划夹具' });
  const temporary = await identity.login('estimate-plan@example.invalid', seed.temporaryPassword);
  const actor = await identity.changePassword(temporary.token, seed.temporaryPassword, 'estimate-plan-fixture-password');
  const department = randomUUID(); await db.query('INSERT INTO departments(id,name) VALUES($1,$2)', [department, '估算计划部门']);
  const people = (await db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'estimate-plan-'||g::text||'@example.invalid','合成人员'||g::text FROM generate_series(1,500) g RETURNING id")).rows.map(row => row.id);
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) SELECT gen_random_uuid(),u,md5(u::text)||md5(u::text),'计划夹具' FROM unnest($1::uuid[]) u", [people]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) SELECT gen_random_uuid(),u,'estimate-plan',$2::timestamptz,$2::timestamptz+interval '19 milliseconds' FROM unnest($1::uuid[]) u", [people, at]);
  await db.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload,capture_generation)
    SELECT gen_random_uuid(),$2::timestamptz+g*interval '1 millisecond',$3,s.user_id,$4,i.id,s.id,
      CASE g%4 WHEN 0 THEN 'UserPromptSubmit' WHEN 1 THEN 'PreToolUse' WHEN 2 THEN 'PostToolUse' ELSE 'Stop' END,
      CASE g%4 WHEN 0 THEN '{"prompt":"hello"}'::jsonb
        WHEN 1 THEN jsonb_build_object('tool_use_id','tool-'||(g/4)::text,'tool_name','Read','tool_input','alpha')
        WHEN 2 THEN jsonb_build_object('tool_use_id','tool-'||(g/4)::text,'tool_name','Read','tool_response','two words')
        ELSE '{"last_assistant_message":"good"}'::jsonb END,1
    FROM sessions s JOIN installations i ON i.user_id=s.user_id CROSS JOIN generate_series(0,19) g WHERE s.user_id=ANY($1::uuid[])`, [people, at, now, department]);
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) SELECT gen_random_uuid(),'derive_session','derive:'||id::text,jsonb_build_object('session_id',id) FROM sessions WHERE user_id=ANY($1::uuid[])", [people]);
  const worker = createSessionDerivationService(db, { batchSize: 16 }); let batches = 0;
  while (await worker.runOne()) { if (++batches > 1100) throw new Error('Synthetic projection did not finish'); }
  for (const table of ['users','sessions','jobs','hook_events','session_derivations','session_fragments','session_turns','session_steps']) await db.query(`ANALYZE ${table}`);
  let statement;
  const traced = new Proxy(db, { get(target, property) { if (property === 'query') return (sql, values) => { if (sql.startsWith('WITH visible AS MATERIALIZED')) statement = { sql, values }; return target.query(sql, values); }; return Reflect.get(target, property); } });
  const service = createAnalyticsService(traced, identity); const started = performance.now();
  const result = await service.contentEstimate(actor.token, { from: new Date(now.getTime() - 2 * 86_400_000).toISOString(), to: now.toISOString() });
  const elapsed = performance.now() - started;
  if (result.estimate.tokens !== '22500' || result.estimate.sessions !== 500 || result.estimate.pending_sessions !== 0 || !statement) throw new Error('Scoped content estimate fixture mismatch');
  const plan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.sql}`, statement.values)).rows[0]['QUERY PLAN'][0];
  const report = { checked_at: new Date().toISOString(), fixture: { people: 500, events: 10000, sessions: 500, tool_pairs: 2500, payload: 'small synthetic prompt/tool/reply; not production payload size or concurrency' }, batches, endpoint_ms: elapsed, plan };
  await mkdir(new URL('../.run/', import.meta.url), { recursive: true }); await writeFile(new URL('../.run/content-estimation-plan.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ people: 500, events: 10000, tokens: result.estimate.tokens, endpoint_ms: elapsed, sql_execution_ms: plan['Execution Time'] }));
} finally { for (const action of cleanup.reverse()) await action(); }
