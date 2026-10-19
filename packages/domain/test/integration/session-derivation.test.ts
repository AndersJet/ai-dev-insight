import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createSessionDerivationService } from '../../src/session-derivation.js';

for(const mode of ['payload','event-type'] as const)test(`prepared derivation recomputes when ${mode} changes before its authoritative write`,async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date(),user=randomUUID(),installation=randomUUID();await db.ensurePartitions(new Date(now.getTime()-86400000),new Date(now.getTime()+86400000));await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'prepared@example.invalid','预计算校验')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')",[installation,user,'9'.repeat(64)]);
 const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'prepared',occurred_at:now.toISOString(),event_type:'UserPromptSubmit',source_session_id:'prepared',payload:{prompt:'old value',last_assistant_message:'fixed'}},{admissionEpoch:1,receivedAt:now});if(saved.outcome!=='committed')throw new Error('Fixture did not commit');
 const change=mode==='payload'?"payload=jsonb_set(payload,'{prompt}','\"修复这个缺陷\"'::jsonb)":"event_type='Stop'";
 // Real database fault injection after preparation and before authoritative
 // fact reading; it must never publish stale cached calculations.
 await db.query(`CREATE FUNCTION change_prepared_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE hook_events SET ${change} WHERE session_id=NEW.session_id; RETURN NEW; END $$; CREATE TRIGGER change_prepared_fact BEFORE INSERT ON session_derivations FOR EACH ROW EXECUTE FUNCTION change_prepared_fact()`);
 await createSessionDerivationService(db).runOne();const result=(await db.query('SELECT r.summary,r.id FROM sessions s JOIN session_derivations r ON r.id=s.derived_run_id WHERE s.id=$1',[saved.sessionId])).rows[0]!;
 if(mode==='payload'){assert.equal(result.summary.purpose,'bugfix');assert.equal((await db.query('SELECT prompt_tokens_estimate::text AS tokens FROM session_turns WHERE run_id=$1',[result.id])).rows[0]!.tokens,'4');}
 else{assert.equal(result.summary.prompt_count,0);assert.equal(result.summary.content_tokens_estimate,'2');}
});

test('a fixed restoration cutoff preserves microsecond precision across a session first-event boundary',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2025-09-01Z'),new Date('2025-10-01Z'));const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'cutoff@example.invalid','保留边界')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'边界')",[installation,user,'8'.repeat(64)]);
 let session='';for(const [index,at]of ['2025-09-22T10:00:00.123100Z','2025-09-22T10:00:00.123456Z','2025-09-22T10:00:00.123789Z'].entries()){const event=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'boundary-'+index,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:'boundary',payload:{prompt:'边界事实'}},{admissionEpoch:1,receivedAt:new Date('2026-09-22T10:00:00Z')});if(event.outcome!=='committed')throw new Error('Boundary fixture failed');session=event.sessionId;}
 const worker=createSessionDerivationService(db,{batchSize:1,clock:()=>new Date('2026-09-22T10:00:00Z'),minimumCutoff:'2025-09-22T10:00:00.123456Z'});let count=0;while(await worker.runOne()){assert.ok(++count<8);}const row=(await db.query<{events:number;from_at:string}>("SELECT (r.summary->>'event_count')::int AS events,to_char(r.from_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS from_at FROM sessions s JOIN session_derivations r ON r.id=s.derived_run_id WHERE s.id=$1",[session])).rows[0]!;assert.equal(row.events,2);assert.equal(row.from_at,'2025-09-22T10:00:00.123456Z');
});

test('out-of-order facts rebuild one prompt turn across Stop retries and two business days without duplicating tool steps', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'derive@example.invalid', '合成派生']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '1'.repeat(64), '合成安装']);
  const facts = [
    ['2026-09-22T15:59:59Z', 'UserPromptSubmit', { prompt: '修复这个缺陷' }],
    ['2026-09-22T16:00:00Z', 'PreToolUse', { tool_use_id: 'test-1', tool_name: 'RunCommand', tool_input: { command: 'npm test' } }],
    ['2026-09-22T16:00:01Z', 'PostToolUse', { tool_use_id: 'test-1', tool_name: 'RunCommand', tool_response: { exit_code: 1 } }],
    ['2026-09-22T16:00:02Z', 'Stop', { stop_hook_active: false, last_assistant_message: '第一次停止候选' }],
    ['2026-09-22T16:00:03Z', 'PreToolUse', { tool_use_id: 'write-1', tool_name: 'Write', tool_input: { content: '修复' } }],
    ['2026-09-22T16:00:04Z', 'PostToolUse', { tool_use_id: 'write-1', tool_name: 'Write', tool_response: { success: true } }],
    ['2026-09-22T16:00:05Z', 'Stop', { stop_hook_active: true, last_assistant_message: '最新回复不能被丢掉' }],
    ['2026-09-22T16:00:06Z', 'Notification', { notification_type: 'idle_prompt' }],
  ] as const;
  let sessionId = ''; let responseId = '';
  for (const [i, fact] of [...facts.entries()].reverse()) {
    const [occurred_at, event_type, payload] = fact;
    const result = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: `event-${i}`, occurred_at, event_type, source_session_id: 'session-derive', payload }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23T12:00:00Z') });
    assert.equal(result.outcome, 'committed'); if (result.outcome === 'committed') { sessionId = result.sessionId; if (i === 6) responseId = result.eventId; }
  }
  const worker = createSessionDerivationService(db, { batchSize: 2 });
  let passes = 0; while (await worker.runOne()) { assert.ok(++passes <= 10); }
  assert.ok(passes >= 4, 'bounded work must resume across batches');
  const run = (await db.query('SELECT r.* FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [sessionId])).rows[0]!;
  assert.equal(run.state, 'published'); assert.equal(run.summary.prompt_count, 1); assert.equal(run.summary.tool_event_count, 2); assert.equal(run.summary.step_count, 2); assert.equal(run.summary.error_count, 1); assert.equal(run.summary.purpose, 'bugfix');
  const turns = (await db.query('SELECT * FROM session_turns WHERE run_id=$1 ORDER BY turn_index', [run.id])).rows;
  assert.equal(turns.length, 1); assert.equal(turns[0]?.response_event_id, responseId); assert.equal(turns[0]?.completion_kind, 'idle_prompt');
  const days = (await db.query('SELECT business_date::text AS day,event_count,prompt_count FROM session_days WHERE run_id=$1 ORDER BY business_date', [run.id])).rows;
  assert.deepEqual(days.map(row => [row.day, row.event_count, row.prompt_count]), [['2026-09-22', 1, 1], ['2026-09-23', 7, 0]]);
  const summary = run.summary; await worker.enqueueRebuild(sessionId);
  passes = 0; while (await worker.runOne()) { assert.ok(++passes <= 10); }
  const rebuilt = (await db.query('SELECT r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [sessionId])).rows[0];
  assert.deepEqual(rebuilt?.summary, summary);
  await db.query("UPDATE session_derivations SET retire_after=clock_timestamp()-interval '1 second' WHERE state='superseded'");
  assert.equal(await worker.pruneRetired(), true); assert.equal(await worker.pruneRetired(), false);
  assert.equal((await db.query('SELECT count(*) FROM session_derivations')).rows[0]?.count, '1');
  assert.equal((await db.query('SELECT count(*) FROM session_fragments')).rows[0]?.count, '8');
  assert.equal((await db.query('SELECT count(*) FROM hook_events')).rows[0]?.count, '8');
});

test('an expired lease cannot publish even when it expires during the final database work', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'lease-derive@example.invalid', '租约屏障']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '3'.repeat(64), '合成安装']);
  const result = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'lease-prompt', occurred_at: '2026-09-22T10:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'lease-session', payload: { prompt: '写测试' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  assert.equal(result.outcome, 'committed'); if (result.outcome !== 'committed') return;
  await db.query("CREATE FUNCTION slow_fragment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.12); RETURN NEW; END $$");
  await db.query('CREATE TRIGGER slow_fragment BEFORE INSERT ON session_fragments FOR EACH ROW EXECUTE FUNCTION slow_fragment()');
  await createSessionDerivationService(db, { leaseMs: 50 }).runOne();
  const session = (await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [result.sessionId])).rows[0];
  assert.equal(session?.derived_run_id, null, 'publishing an expired lease must roll back the entire batch');
  assert.equal((await db.query('SELECT count(*) FROM session_derivations')).rows[0]?.count, '0');
  await db.query('DROP TRIGGER slow_fragment ON session_fragments');
  await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE kind='derive_session'");
  await createSessionDerivationService(db).runOne();
  assert.ok((await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [result.sessionId])).rows[0]?.derived_run_id);
});

test('microsecond source timestamps at the session boundary are not skipped during projection', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'micro-derive@example.invalid', '时间边界']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '2'.repeat(64), '合成安装']);
  const result = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'micro-prompt', occurred_at: '2026-09-22T10:00:00.123456Z', event_type: 'UserPromptSubmit', source_session_id: 'micro-session', payload: { prompt: '解释一下' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  assert.equal(result.outcome, 'committed'); if (result.outcome !== 'committed') return;
  const worker = createSessionDerivationService(db); await worker.runOne();
  const row = (await db.query('SELECT r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [result.sessionId])).rows[0];
  assert.equal(row?.summary.prompt_count, 1);
  assert.equal(row?.summary.status, 'unknown', 'absence of a completion marker does not prove ongoing IDE activity');
});

test('new late facts queue a following snapshot and cleanup invalidates an unfinished derivation', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'snapshot@example.invalid', '快照与清理']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '4'.repeat(64), '合成安装']);
  const ingest = (id: string, occurred_at: string, event_type: string, payload: Record<string, unknown>) => db.ingest({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at, event_type, source_session_id: 'snapshot-session', payload }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  const first = await ingest('prompt', '2026-09-22T10:00:00Z', 'UserPromptSubmit', { prompt: '修复这个问题，不应复制到派生表' });
  if (first.outcome !== 'committed') throw new Error('fixture failed');
  await ingest('stop', '2026-09-22T10:00:02Z', 'Stop', { last_assistant_message: '观测到停止', stop_hook_active: false });
  const worker = createSessionDerivationService(db, { batchSize: 1 });
  await worker.runOne();
  assert.equal((await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [first.sessionId])).rows[0]?.derived_run_id, null);
  await ingest('late-tool', '2026-09-22T10:00:01Z', 'PreToolUse', { tool_use_id: 'late', tool_name: 'Read' });
  await worker.runOne();
  const snapshot = (await db.query('SELECT r.source_generation,r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [first.sessionId])).rows[0]!;
  assert.equal(snapshot.source_generation, 2); assert.equal(snapshot.summary.event_count, 2);
  assert.equal((await db.query("SELECT status FROM jobs WHERE kind='derive_session'")).rows[0]?.status, 'queued');
  let loops = 0; while (await worker.runOne()) assert.ok(++loops <= 8);
  await worker.enqueueRebuild(first.sessionId); await worker.runOne();
  await db.transaction(async client => {
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [user]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)', [user, '2026-09-22T10:00:00Z', '2026-09-22T10:00:01Z']);
  });
  await worker.enqueueRebuild(first.sessionId);
  const resumed = createSessionDerivationService(db, { batchSize: 1 });
  loops = 0; while (await resumed.runOne()) assert.ok(++loops <= 8);
  const clean = (await db.query('SELECT r.* FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [first.sessionId])).rows[0]!;
  assert.equal(clean.cleanup_generation, 1); assert.equal(clean.summary.prompt_count, 0); assert.equal(clean.summary.event_count, 2);
  assert.ok(clean.summary.quality.includes('orphan_events'));
  assert.equal((await db.query('SELECT count(*) FROM session_turns WHERE run_id=$1', [clean.id])).rows[0]?.count, '0');
  assert.ok(!JSON.stringify(clean).includes('不应复制到派生表'));
  assert.equal((await db.query("SELECT count(*) FROM session_derivations WHERE state='abandoned'")).rows[0]?.count, '1');
});

test('an expired worker claim resumes its persisted cursor rather than counting the first batch again', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'resume@example.invalid', '断点恢复']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '5'.repeat(64), '合成安装']);
  for (const [i, type] of ['UserPromptSubmit', 'Stop', 'Notification'].entries()) await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: String(i), occurred_at: `2026-09-22T10:00:0${i}Z`, event_type: type, source_session_id: 'resume-session', payload: { prompt: '写文档', notification_type: 'idle_prompt' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  await createSessionDerivationService(db, { batchSize: 1 }).runOne();
  await db.query("UPDATE jobs SET status='running',lease_token=$1,lease_until=clock_timestamp()-interval '1 second' WHERE kind='derive_session'", [randomUUID()]);
  const restarted = createSessionDerivationService(db, { batchSize: 1 }); let loops = 0; while (await restarted.runOne()) assert.ok(++loops < 5);
  const run = (await db.query('SELECT r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id')).rows[0]!;
  assert.equal(run.summary.event_count, 3); assert.equal(run.summary.prompt_count, 1); assert.equal(run.summary.purpose, 'docs');
  assert.equal((await db.query('SELECT count(*) FROM session_fragments')).rows[0]?.count, '3');
});

test('a delayed idle notification without a stop for the current prompt cannot complete that prompt', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'idle-order@example.invalid', '异步通知']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '6'.repeat(64), '合成安装']);
  const facts = [['UserPromptSubmit', { prompt: '第一问' }], ['Stop', { last_assistant_message: '第一问候选回复' }], ['UserPromptSubmit', { prompt: '第二问还没有回复' }], ['Notification', { notification_type: 'idle_prompt' }]] as const;
  for (const [i, [event_type, payload]] of facts.entries()) await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: String(i), occurred_at: `2026-09-22T10:00:0${i}Z`, event_type, source_session_id: 'idle-order', payload }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  await createSessionDerivationService(db).runOne();
  const turns = (await db.query('SELECT completion_kind FROM session_turns ORDER BY turn_index')).rows;
  assert.deepEqual(turns.map(row => row.completion_kind), ['stop_observed', 'missing']);
  const summary = (await db.query("SELECT summary FROM session_derivations WHERE state='published'")).rows[0]!.summary;
  assert.equal(summary.status, 'unknown'); assert.ok(summary.quality.includes('unpaired_completion_notification'));
});

test('a tool return without explicit outcome evidence remains returned rather than a fabricated success', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'tool-outcome@example.invalid', '工具结果']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '7'.repeat(64), '合成安装']);
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'post-only', occurred_at: '2026-09-22T10:00:00Z', event_type: 'PostToolUse', source_session_id: 'tool-outcome', payload: { tool_name: 'Read', tool_use_id: 'unpaired', tool_response: { content: '缺少可验证的结果状态' } } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  await createSessionDerivationService(db).runOne();
  const step = (await db.query('SELECT status,turn_index,duration_ms FROM session_steps')).rows[0];
  assert.equal(step?.status, 'returned'); assert.equal(step?.turn_index, null); assert.equal(step?.duration_ms, null);
});

test('an unfinished snapshot from a different calculation version is rebuilt rather than mixed with new rules', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'version-derive@example.invalid', '计算版本']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '8'.repeat(64), '合成安装']);
  for (const [i, type] of ['UserPromptSubmit', 'Stop'].entries()) await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: String(i), occurred_at: `2026-09-22T10:00:0${i}Z`, event_type: type, source_session_id: 'version-session', payload: { prompt: '新增页面', last_assistant_message: '候选回复' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  const worker = createSessionDerivationService(db, { batchSize: 1 }); await worker.runOne();
  const old = (await db.query("UPDATE session_derivations SET metric_version='previous-rules' WHERE state='building' RETURNING id")).rows[0]!.id;
  let passes = 0; while (await worker.runOne()) assert.ok(++passes < 5);
  const current = (await db.query("SELECT id,metric_version,summary FROM session_derivations WHERE state='published'")).rows[0]!;
  assert.notEqual(current.id, old); assert.equal(current.metric_version, 'session-v9'); assert.equal(current.summary.prompt_count, 1);
});

test('quantum 16 cannot publish when its lease expires during the final database work', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'lease-derive@example.invalid', '租约屏障']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '3'.repeat(64), '合成安装']);
  const result = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'lease-prompt', occurred_at: '2026-09-22T10:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'lease-session', payload: { prompt: '写测试' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  assert.equal(result.outcome, 'committed'); if (result.outcome !== 'committed') return;
  await db.query("CREATE FUNCTION slow_fragment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.12); RETURN NEW; END $$");
  await db.query('CREATE TRIGGER slow_fragment BEFORE INSERT ON session_fragments FOR EACH ROW EXECUTE FUNCTION slow_fragment()');
  await createSessionDerivationService(db, { leaseMs: 50, batchSize: 16 }).runOne();
  const session = (await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [result.sessionId])).rows[0];
  assert.equal(session?.derived_run_id, null, 'publishing an expired lease must roll back the entire batch');
  assert.equal((await db.query('SELECT count(*) FROM session_derivations')).rows[0]?.count, '0');
  await db.query('DROP TRIGGER slow_fragment ON session_fragments');
  await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE kind='derive_session'");
  await createSessionDerivationService(db, { batchSize: 16 }).runOne();
  assert.ok((await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [result.sessionId])).rows[0]?.derived_run_id);
});

test('quantum 16 preserves late-fact generations and abandons a cleanup-invalid unfinished run', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'snapshot@example.invalid', '快照与清理']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '4'.repeat(64), '合成安装']);
  const ingest = (id: string, occurred_at: string, event_type: string, payload: Record<string, unknown>) => db.ingest({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at, event_type, source_session_id: 'snapshot-session', payload }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  const first = await ingest('prompt', '2026-09-22T10:00:00Z', 'UserPromptSubmit', { prompt: '修复这个问题，不应复制到派生表' });
  if (first.outcome !== 'committed') throw new Error('fixture failed');
  for (let n = 0; n < 15; n++) await ingest('quantum-filler-'+n, '2026-09-22T10:00:01Z', 'Notification', { notification_type: 'other' });
  await ingest('stop', '2026-09-22T10:00:02Z', 'Stop', { last_assistant_message: '观测到停止', stop_hook_active: false });
  const worker = createSessionDerivationService(db, { batchSize: 16 });
  await worker.runOne();
  assert.equal((await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [first.sessionId])).rows[0]?.derived_run_id, null);
  await ingest('late-tool', '2026-09-22T10:00:01Z', 'PreToolUse', { tool_use_id: 'late', tool_name: 'Read' });
  await worker.runOne();
  const snapshot = (await db.query('SELECT r.source_generation,r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [first.sessionId])).rows[0]!;
  assert.equal(snapshot.source_generation, 17); assert.equal(snapshot.summary.event_count, 17);
  assert.equal((await db.query("SELECT status FROM jobs WHERE kind='derive_session'")).rows[0]?.status, 'queued');
  let loops = 0; while (await worker.runOne()) assert.ok(++loops <= 8);
  await worker.enqueueRebuild(first.sessionId); await worker.runOne();
  await db.transaction(async client => {
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [user]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)', [user, '2026-09-22T10:00:00Z', '2026-09-22T10:00:01Z']);
  });
  await worker.enqueueRebuild(first.sessionId);
  const resumed = createSessionDerivationService(db, { batchSize: 16 });
  loops = 0; while (await resumed.runOne()) assert.ok(++loops <= 8);
  const clean = (await db.query('SELECT r.* FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id WHERE s.id=$1', [first.sessionId])).rows[0]!;
  assert.equal(clean.cleanup_generation, 1); assert.equal(clean.summary.prompt_count, 0); assert.equal(clean.summary.event_count, 17);
  assert.ok(clean.summary.quality.includes('orphan_events'));
  assert.equal((await db.query('SELECT count(*) FROM session_turns WHERE run_id=$1', [clean.id])).rows[0]?.count, '0');
  assert.ok(!JSON.stringify(clean).includes('不应复制到派生表'));
  assert.equal((await db.query("SELECT count(*) FROM session_derivations WHERE state='abandoned'")).rows[0]?.count, '1');
});

test('quantum 16 reclaims an expired lease without recounting its 16 persisted facts', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'resume@example.invalid', '断点恢复']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '5'.repeat(64), '合成安装']);
  for (const [i, type] of ['UserPromptSubmit', ...Array(15).fill('Stop'), 'Notification'].entries()) await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: String(i), occurred_at: `2026-09-22T10:00:${String(i).padStart(2, '0')}Z`, event_type: type, source_session_id: 'resume-session', payload: { prompt: '写文档', notification_type: 'idle_prompt' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') });
  await createSessionDerivationService(db, { batchSize: 16 }).runOne();
  await db.query("UPDATE jobs SET status='running',lease_token=$1,lease_until=clock_timestamp()-interval '1 second' WHERE kind='derive_session'", [randomUUID()]);
  const restarted = createSessionDerivationService(db, { batchSize: 16 }); let loops = 0; while (await restarted.runOne()) assert.ok(++loops < 5);
  const run = (await db.query('SELECT r.summary FROM session_derivations r JOIN sessions s ON s.derived_run_id=r.id')).rows[0]!;
  assert.equal(run.summary.event_count, 17); assert.equal(run.summary.prompt_count, 1); assert.equal(run.summary.purpose, 'docs');
  assert.equal((await db.query('SELECT count(*) FROM session_fragments')).rows[0]?.count, '17');
});
