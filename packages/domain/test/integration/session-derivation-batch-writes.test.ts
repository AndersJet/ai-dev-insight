import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { HookEnvelope } from '@adi/contracts';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createSessionDerivationService } from '../../src/session-derivation.js';

type InputFact = { at: string; type: HookEnvelope['event_type']; payload: HookEnvelope['payload']; department: 'a' | 'b' | null; receivedAt: string };

async function fixture(t: TestContext, facts: InputFact[], batchSize?: number) {
  const db = await testDatabase(t);
  await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(), installation = randomUUID(), departments = { a: randomUUID(), b: randomUUID() };
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'batch-writes@example.invalid','批次写入')", [user]);
  await db.query("INSERT INTO departments(id,name) VALUES($1,'a'),($2,'b')", [departments.a, departments.b]);
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')", [installation, user, 'a'.repeat(64)]);
  let session = '';
  for (const [index, fact] of facts.entries()) {
    const saved = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: String(index), occurred_at: fact.at, event_type: fact.type, source_session_id: 'batch-writes', payload: fact.payload }, { admissionEpoch: 1, receivedAt: new Date(fact.receivedAt) });
    if (saved.outcome !== 'committed') throw new Error('Synthetic fact did not commit');
    session = saved.sessionId;
    // Persist the authoritative microseconds and historical department directly;
    // the ingestion Date boundary cannot represent a sub-millisecond fixture.
    await db.query('UPDATE hook_events SET department_id=$3,received_at=$4::timestamptz WHERE id=$1 AND occurred_at=$2', [saved.eventId, fact.at, fact.department === null ? null : departments[fact.department], fact.receivedAt]);
  }
  const worker = createSessionDerivationService(db, { ...(batchSize === undefined ? {} : { batchSize }), clock: () => new Date('2026-09-23T12:00:01Z') });
  async function days() {
    return (await db.query(`SELECT x.business_date::text AS day,COALESCE(d.name,'-') AS department,
      x.event_count AS events,x.prompt_count AS prompts,x.tool_event_count AS tools
      FROM session_days x LEFT JOIN departments d ON d.id=x.department_id
      WHERE x.session_id=$1 ORDER BY day,department`, [session])).rows;
  }
  async function state() {
    return {
      run: (await db.query(`SELECT id,state,source_generation,cleanup_generation,checkpoint,summary,
        to_char(source_watermark AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS watermark
        FROM session_derivations WHERE session_id=$1`, [session])).rows[0],
      fragments: (await db.query('SELECT ordinal,event_id,hook_model FROM session_fragments WHERE session_id=$1 ORDER BY ordinal', [session])).rows,
      days: await days(),
      published: (await db.query('SELECT derived_run_id FROM sessions WHERE id=$1', [session])).rows[0]?.derived_run_id,
    };
  }
  return { db, session, installation, worker, days, state };
}

test('bounded derivation batches group nullable day keys and preserve models and microsecond watermarks', async t => {
  const maximumModel = 'm'.repeat(256);
  const facts: InputFact[] = [
    { at: '2026-09-22T15:59:59.123450Z', type: 'SessionStart', payload: { model: 'alpha' }, department: null, receivedAt: '2026-09-23T12:00:00.900123Z' },
    { at: '2026-09-22T15:59:59.123451Z', type: 'UserPromptSubmit', payload: { prompt: '修复这个缺陷', model: 'alpha' }, department: null, receivedAt: '2026-09-23T12:00:00.900120Z' },
    { at: '2026-09-22T15:59:59.123452Z', type: 'PreToolUse', payload: { tool_use_id: 'read', tool_name: 'Read', model: maximumModel }, department: 'a', receivedAt: '2026-09-23T12:00:00.800125Z' },
    { at: '2026-09-22T15:59:59.123453Z', type: 'PostToolUse', payload: { tool_use_id: 'read', tool_name: 'Read', tool_response: { success: true }, model: 'm'.repeat(257) }, department: 'a', receivedAt: '2026-09-23T12:00:00.900122Z' },
    { at: '2026-09-22T16:00:00Z', type: 'Stop', payload: { last_assistant_message: '候选回复', model: '' }, department: 'a', receivedAt: '2026-09-23T12:00:00.900010Z' },
    { at: '2026-09-22T16:00:01Z', type: 'Notification', payload: { notification_type: 'idle_prompt', model: 42 }, department: null, receivedAt: '2026-09-23T12:00:00.600002Z' },
    { at: '2026-09-22T16:00:02Z', type: 'UserPromptSubmit', payload: { prompt: '继续修复', model: 'beta' }, department: 'b', receivedAt: '2026-09-23T12:00:00.500001Z' },
    { at: '2026-09-22T16:00:03Z', type: 'Stop', payload: { last_assistant_message: '第二次候选回复', model: 'beta' }, department: 'b', receivedAt: '2026-09-23T12:00:00.400009Z' },
    { at: '2026-09-22T16:00:04Z', type: 'Notification', payload: { notification_type: 'idle_prompt' }, department: 'b', receivedAt: '2026-09-23T12:00:00.900099Z' },
  ];
  const f = await fixture(t, facts);
  // Statement triggers measure actual PostgreSQL writes, without mocking queries.
  await f.db.query(`CREATE TABLE derivation_batch_writes(operation text NOT NULL);
    CREATE FUNCTION record_derivation_batch_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO derivation_batch_writes(operation) VALUES(TG_ARGV[0]); RETURN NULL; END $$;
    CREATE TRIGGER count_day_writes AFTER INSERT ON session_days FOR EACH STATEMENT EXECUTE FUNCTION record_derivation_batch_write('day');
    CREATE TRIGGER count_watermark_writes AFTER UPDATE OF source_watermark ON session_derivations FOR EACH STATEMENT EXECUTE FUNCTION record_derivation_batch_write('watermark');
    CREATE TRIGGER count_model_writes AFTER UPDATE OF hook_model ON session_fragments FOR EACH STATEMENT EXECUTE FUNCTION record_derivation_batch_write('model');`);
  const firstDays = [
    { day: '2026-09-22', department: '-', events: 2, prompts: 1, tools: 0 },
    { day: '2026-09-22', department: 'a', events: 2, prompts: 0, tools: 1 },
    { day: '2026-09-23', department: '-', events: 1, prompts: 0, tools: 0 },
    { day: '2026-09-23', department: 'a', events: 1, prompts: 0, tools: 0 },
    { day: '2026-09-23', department: 'b', events: 2, prompts: 1, tools: 0 },
  ];
  assert.equal(await f.worker.runOne(), true);
  const partial = await f.state();
  assert.equal(partial.run?.state, 'building');
  assert.equal(partial.run?.checkpoint.processed, 8, 'the default batch remains bounded at eight facts');
  assert.equal(partial.run?.watermark, facts[0]!.receivedAt);
  assert.equal(partial.published, null);
  assert.deepEqual(partial.days, firstDays);
  assert.deepEqual(partial.fragments.map(row => row.hook_model), ['alpha', 'alpha', maximumModel, null, null, null, 'beta', 'beta']);
  assert.equal(await f.worker.runOne(), true);
  const final = await f.state();
  assert.equal(final.run?.state, 'published');
  assert.equal(final.run?.checkpoint.processed, 9);
  assert.equal(final.run?.watermark, facts[0]!.receivedAt, 'a later batch cannot lower the previous exact maximum');
  assert.equal(final.run?.source_generation, 9);
  assert.equal(final.run?.summary.event_count, 9);
  assert.equal(final.run?.summary.prompt_count, 2);
  assert.equal(final.run?.summary.tool_event_count, 1);
  assert.equal(final.run?.summary.step_count, 1);
  assert.equal(final.run?.summary.purpose, 'bugfix');
  assert.equal(final.run?.summary.status, 'completed', 'each notification completes only its uniquely pending prompt');
  assert.equal(final.published, final.run?.id);
  assert.deepEqual(final.days, [...firstDays.slice(0, -1), { day: '2026-09-23', department: 'b', events: 3, prompts: 1, tools: 0 }]);
  assert.deepEqual(final.fragments.map(row => row.hook_model), ['alpha', 'alpha', maximumModel, null, null, null, 'beta', 'beta', null]);
  assert.deepEqual((await f.db.query(`SELECT count(*) FILTER(WHERE operation='day')::integer AS day,
    count(*) FILTER(WHERE operation='watermark')::integer AS watermark,
    count(*) FILTER(WHERE operation='model')::integer AS model FROM derivation_batch_writes`)).rows[0], { day: 2, watermark: 2, model: 0 });
});

test('a retryable PostgreSQL failure rolls back a middle batch before resuming its persisted cursor', async t => {
  const facts: InputFact[] = Array.from({ length: 17 }, (_, index) => ({
    at: `2026-09-22T10:00:${String(index).padStart(2, '0')}Z`,
    type: 'UserPromptSubmit', payload: { prompt: '修复这个缺陷', model: `model-${index % 3}` },
    department: index % 3 === 0 ? null : index % 3 === 1 ? 'a' : 'b',
    receivedAt: `2026-09-23T12:00:${String(index).padStart(2, '0')}.123456Z`,
  }));
  const f = await fixture(t, facts);
  assert.equal(await f.worker.runOne(), true);
  const before = await f.state();
  assert.equal(before.run?.checkpoint.processed, 8);
  assert.equal(before.run?.watermark, facts[7]!.receivedAt);
  assert.equal(before.fragments.length, 8);
  await f.db.query(`CREATE FUNCTION reject_batch_watermark() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic retryable batch write failure' USING ERRCODE='40001'; END $$;
    CREATE TRIGGER reject_batch_watermark AFTER UPDATE OF source_watermark ON session_derivations
      FOR EACH ROW EXECUTE FUNCTION reject_batch_watermark();`);
  assert.equal(await f.worker.runOne(), true);
  assert.deepEqual(await f.state(), before, 'fragments, day counters, watermark, checkpoint and publication all roll back together');
  const failed = (await f.db.query("SELECT status,error_code,progress FROM jobs WHERE dedupe_key='derive:'||$1::text", [f.session])).rows[0];
  assert.equal(failed?.status, 'queued');
  assert.equal(failed?.error_code, '40001');
  assert.equal(failed?.progress.run_id, before.run?.id);
  await f.db.query('DROP TRIGGER reject_batch_watermark ON session_derivations');
  await f.db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE dedupe_key='derive:'||$1::text", [f.session]);
  assert.equal(await f.worker.runOne(), true);
  assert.equal((await f.state()).run?.checkpoint.processed, 16);
  assert.equal(await f.worker.runOne(), true);
  const final = await f.state();
  assert.equal(final.run?.id, before.run?.id);
  assert.equal(final.run?.state, 'published');
  assert.equal(final.run?.checkpoint.processed, 17);
  assert.equal(final.run?.source_generation, 17);
  assert.equal(final.run?.summary.event_count, 17);
  assert.equal(final.run?.summary.prompt_count, 17);
  assert.equal(final.run?.summary.tool_event_count, 0);
  assert.equal(final.run?.watermark, facts[16]!.receivedAt);
  assert.equal(final.fragments.length, 17);
  assert.deepEqual(final.fragments.map(row => row.ordinal), Array.from({ length: 17 }, (_, index) => index + 1));
  assert.equal(final.days.reduce((total, row) => total + row.events, 0), 17);
  assert.equal(final.days.reduce((total, row) => total + row.prompts, 0), 17);
  assert.equal(final.published, final.run?.id);
  assert.deepEqual((await f.db.query("SELECT status,error_code,progress FROM jobs WHERE dedupe_key='derive:'||$1::text", [f.session])).rows[0], { status: 'succeeded', error_code: null, progress: {} });
});

test('quantum 16 publishes 17 facts in a 16/1 sequence without changing identities or counters', async t => {
  const facts: InputFact[] = Array.from({ length: 17 }, (_, index) => ({
    at: `2026-09-22T10:00:${String(index).padStart(2, '0')}Z`,
    type: 'UserPromptSubmit', payload: { prompt: '修复这个缺陷', model: `model-${index % 3}` },
    department: index % 3 === 0 ? null : index % 3 === 1 ? 'a' : 'b',
    receivedAt: `2026-09-23T12:00:${String(index).padStart(2, '0')}.123456Z`,
  }));
  const f = await fixture(t, facts, 16);
  assert.equal(await f.worker.runOne(), true);const partial = await f.state();
  assert.equal(partial.run?.state, 'building');assert.equal(partial.run?.checkpoint.processed, 16);assert.equal(partial.fragments.length, 16);assert.equal(partial.published, null);assert.equal(partial.run?.watermark, facts[15]!.receivedAt);
  assert.equal(await f.worker.runOne(), true);const final = await f.state();
  assert.equal(final.run?.id, partial.run?.id);assert.equal(final.run?.state, 'published');assert.equal(final.run?.source_generation, 17);assert.equal(final.run?.checkpoint.processed, 17);assert.equal(final.run?.summary.event_count, 17);assert.equal(final.run?.summary.prompt_count, 17);assert.equal(final.published, final.run?.id);assert.equal(final.run?.watermark, facts[16]!.receivedAt);
  assert.deepEqual(final.fragments.map(row => row.ordinal), Array.from({ length: 17 }, (_, index) => index + 1));assert.equal(final.days.reduce((sum, row) => sum + row.events, 0), 17);assert.equal(final.days.reduce((sum, row) => sum + row.prompts, 0), 17);assert.equal(await f.worker.runOne(), false);
});

test('quantum 16 rolls back an entire second 16-fact batch before retrying its persisted cursor', async t => {
  const facts: InputFact[] = Array.from({ length: 33 }, (_, index) => ({
    at: `2026-09-22T10:00:${String(index).padStart(2, '0')}Z`,
    type: 'UserPromptSubmit', payload: { prompt: '修复这个缺陷', model: `model-${index % 3}` },
    department: index % 3 === 0 ? null : index % 3 === 1 ? 'a' : 'b',
    receivedAt: `2026-09-23T12:00:${String(index).padStart(2, '0')}.123456Z`,
  }));
  const f = await fixture(t, facts, 16);
  assert.equal(await f.worker.runOne(), true);
  const before = await f.state();
  assert.equal(before.run?.checkpoint.processed, 16);
  assert.equal(before.run?.watermark, facts[15]!.receivedAt);
  assert.equal(before.fragments.length, 16);
  await f.db.query(`CREATE FUNCTION reject_batch_watermark() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic retryable batch write failure' USING ERRCODE='40001'; END $$;
    CREATE TRIGGER reject_batch_watermark AFTER UPDATE OF source_watermark ON session_derivations
      FOR EACH ROW EXECUTE FUNCTION reject_batch_watermark();`);
  assert.equal(await f.worker.runOne(), true);
  assert.deepEqual(await f.state(), before, 'fragments, day counters, watermark, checkpoint and publication all roll back together');
  const failed = (await f.db.query("SELECT status,error_code,progress FROM jobs WHERE dedupe_key='derive:'||$1::text", [f.session])).rows[0];
  assert.equal(failed?.status, 'queued');
  assert.equal(failed?.error_code, '40001');
  assert.equal(failed?.progress.run_id, before.run?.id);
  await f.db.query('DROP TRIGGER reject_batch_watermark ON session_derivations');
  await f.db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE dedupe_key='derive:'||$1::text", [f.session]);
  assert.equal(await f.worker.runOne(), true);
  assert.equal((await f.state()).run?.checkpoint.processed, 32);
  assert.equal(await f.worker.runOne(), true);
  const final = await f.state();
  assert.equal(final.run?.id, before.run?.id);
  assert.equal(final.run?.state, 'published');
  assert.equal(final.run?.checkpoint.processed, 33);
  assert.equal(final.run?.source_generation, 33);
  assert.equal(final.run?.summary.event_count, 33);
  assert.equal(final.run?.summary.prompt_count, 33);
  assert.equal(final.run?.summary.tool_event_count, 0);
  assert.equal(final.run?.watermark, facts[32]!.receivedAt);
  assert.equal(final.fragments.length, 33);
  assert.deepEqual(final.fragments.map(row => row.ordinal), Array.from({ length: 33 }, (_, index) => index + 1));
  assert.equal(final.days.reduce((total, row) => total + row.events, 0), 33);
  assert.equal(final.days.reduce((total, row) => total + row.prompts, 0), 33);
  assert.equal(final.published, final.run?.id);
  assert.deepEqual((await f.db.query("SELECT status,error_code,progress FROM jobs WHERE dedupe_key='derive:'||$1::text", [f.session])).rows[0], { status: 'succeeded', error_code: null, progress: {} });
});

test('quantum 16 puts an unfinished long session behind another already-due short session', async t => {
  const facts: InputFact[] = Array.from({ length: 33 }, (_, index) => ({
    at: `2026-09-22T10:00:${String(index).padStart(2, '0')}Z`,
    type: 'UserPromptSubmit', payload: { prompt: '修复这个缺陷', model: `model-${index % 3}` },
    department: index % 3 === 0 ? null : index % 3 === 1 ? 'a' : 'b',
    receivedAt: `2026-09-23T12:00:${String(index).padStart(2, '0')}.123456Z`,
  }));
  const f = await fixture(t, facts, 16);let short = '';
  for (let n = 0; n < 2; n++) {
    const result = await f.db.ingest({ schema_version: 2, installation_id: f.installation, client_event_id: 'short-'+n, occurred_at: `2026-09-22T11:00:0${n}Z`, event_type: 'UserPromptSubmit', source_session_id: 'short-quantum-session', payload: { prompt: '修复普通会话' } }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23T12:00:01Z') });
    if (result.outcome !== 'committed') throw new Error('Synthetic short fact did not commit');short = result.sessionId;
  }
  await f.db.query("UPDATE jobs SET available_at=clock_timestamp()-CASE WHEN payload->>'session_id'=$1 THEN interval '2 seconds' ELSE interval '1 second' END WHERE kind='derive_session'", [f.session]);
  assert.equal(await f.worker.runOne(), true);const first = await f.state();assert.equal(first.run?.checkpoint.processed, 16);assert.equal(first.published, null);
  assert.equal(await f.worker.runOne(), true);const shortRun = (await f.db.query("SELECT r.summary,r.state FROM sessions s JOIN session_derivations r ON r.id=s.derived_run_id WHERE s.id=$1", [short])).rows[0]!;
  assert.equal(shortRun.state, 'published');assert.equal(shortRun.summary.event_count, 2);assert.equal(shortRun.summary.prompt_count, 2);assert.deepEqual(await f.state(), first, 'the ordinary task runs before a second long-session quantum');
  assert.equal(await f.worker.runOne(), true);assert.equal((await f.state()).run?.checkpoint.processed, 32);
  assert.equal(await f.worker.runOne(), true);const final = await f.state();assert.equal(final.run?.checkpoint.processed, 33);assert.equal(final.run?.summary.event_count, 33);assert.equal(final.published, final.run?.id);assert.equal(await f.worker.runOne(), false);
});
