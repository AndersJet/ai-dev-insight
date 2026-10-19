import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { testDatabase } from './helpers.js';

test('out-of-order consumer commits cannot move an installation last-received time backwards', async t => {
  const db = await testDatabase(t); await db.migrate();
  const latest = new Date(); const earlier = new Date(latest.getTime() - 1000);
  await db.ensurePartitions(new Date(latest.getTime() - 86_400_000), new Date(latest.getTime() + 86_400_000));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'seen@example.invalid', '乱序接收时间']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '8'.repeat(64), '合成设备']);
  const envelope = { schema_version: 2 as const, installation_id: installation, occurred_at: earlier.toISOString(), event_type: 'Stop', source_session_id: 'last-seen', payload: {} };
  await db.ingest({ ...envelope, client_event_id: 'received-later' }, { admissionEpoch: 1, receivedAt: latest });
  await db.ingest({ ...envelope, client_event_id: 'received-earlier' }, { admissionEpoch: 1, receivedAt: earlier });
  assert.equal((await db.query<{ last_seen: Date }>('SELECT last_seen FROM installations WHERE id=$1', [installation])).rows[0]?.last_seen.toISOString(), latest.toISOString());
});

test('concurrent replay commits a fact once and conflicting event identity cannot enter a different month', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-08-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'ingest@example.invalid', '摄入测试']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'b'.repeat(64), '合成设备']);
  const envelope = { schema_version: 2 as const, installation_id: installation, client_event_id: 'stable-event', occurred_at: '2026-08-31T23:59:00Z', event_type: 'UserPromptSubmit', source_session_id: 'session-1', payload: { prompt: '合成内容' } };
  const options = { admissionEpoch: 1, receivedAt: new Date('2026-09-23T00:00:00Z') };
  const outcomes = await Promise.all([db.ingest(envelope, options), db.ingest(envelope, options)]);
  assert.deepEqual(outcomes.map(result => result.outcome).sort(), ['committed', 'duplicate']);
  const conflict = await db.ingest({ ...envelope, occurred_at: '2026-09-01T00:00:00Z' }, options);
  assert.deepEqual(conflict, { outcome: 'rejected', reason: 'event_id_conflict' });
  const facts = await db.query<{ count: string }>('SELECT count(*) FROM hook_events');
  const jobs = await db.query<{ count: string }>('SELECT count(*) FROM jobs WHERE kind=$1', ['derive_session']);
  assert.equal(facts.rows[0]?.count, '1'); assert.equal(jobs.rows[0]?.count, '1');
});
test('the same event remains a duplicate across workers with different operating-system locales', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'locale@example.invalid', '跨环境去重']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '2'.repeat(64), '合成设备']);
  const input = { schema: db.schema, receivedAt: '2026-09-23T00:00:00Z', envelope: { schema_version: 2, installation_id: installation, client_event_id: 'locale-event', occurred_at: '2026-09-22T12:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'locale-session', payload: { ä: '值1', z: '值2' } } };
  const run = promisify(execFile); const fixture = fileURLToPath(new URL('./fixtures/locale-ingest.ts', import.meta.url));
  const first = await run(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(input)], { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  const replay = await run(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(input)], { env: { ...process.env, LANG: 'sv_SE.UTF-8', LC_ALL: 'sv_SE.UTF-8' } });
  assert.equal(JSON.parse(first.stdout).outcome, 'committed'); assert.equal(JSON.parse(replay.stdout).outcome, 'duplicate');
});
test('an in-flight ingest observes the committed suspension after the user lock is released', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'race@example.invalid', '并发停用']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '1'.repeat(64), '合成设备']);
  let unlock: (() => void) | undefined; let signalLocked: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { signalLocked = resolve; });
  const suspension = db.transaction(async client => {
    await client.query("UPDATE users SET status='suspended',ingest_epoch=ingest_epoch+1 WHERE id=$1", [user]);
    signalLocked?.(); await gate;
  });
  try {
    await Promise.race([locked, suspension]);
    let settled = false;
    const result = db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'in-flight', occurred_at: '2026-09-22T12:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'race-session', payload: {} }, { admissionEpoch: 1, receivedAt: new Date('2026-09-23T00:00:00Z') }).then(value => { settled = true; return value; });
    await delay(25); const wasWaiting = !settled; unlock?.(); await suspension;
    assert.deepEqual(await result, { outcome: 'rejected', reason: 'account_disabled' });
    assert.equal(wasWaiting, true);
  } finally { unlock?.(); }
});
test('cleanup barriers reject new event IDs in the cleared range while future collection continues', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'clear@example.invalid', '清理屏障']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'f'.repeat(64), '合成设备']);
  await db.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,$4)', [user, '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 1]);
  const envelope = { schema_version: 2 as const, installation_id: installation, client_event_id: 'new-id-for-cleared-data', occurred_at: '2026-09-10T00:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'clean-session', payload: { prompt: '旧原文不能复活' } };
  const options = { admissionEpoch: 1, receivedAt: new Date('2026-09-23T00:00:00Z') };
  assert.deepEqual(await db.ingest(envelope, options), { outcome: 'rejected', reason: 'data_cleared' });
  assert.equal((await db.ingest({ ...envelope, client_event_id: 'future', occurred_at: '2026-09-20T00:00:00Z' }, options)).outcome, 'committed');
  const count = await db.query<{ count: string }>('SELECT count(*) FROM hook_events'); assert.equal(count.rows[0]?.count, '1');
});
test('retention and future-time validation reject before creating any identity or payload', async t => {
  const db = await testDatabase(t); await db.migrate();
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'time@example.invalid', '时间边界']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'e'.repeat(64), '合成设备']);
  const envelope = { schema_version: 2 as const, installation_id: installation, client_event_id: 'old', occurred_at: '2025-09-22T23:59:59Z', event_type: 'UserPromptSubmit', source_session_id: 'time-session', payload: { prompt: '不应保存' } };
  const options = { admissionEpoch: 1, receivedAt: new Date('2026-09-23T00:00:00Z') };
  assert.deepEqual(await db.ingest(envelope, options), { outcome: 'rejected', reason: 'expired' });
  assert.deepEqual(await db.ingest({ ...envelope, occurred_at: '2026-09-24T00:00:00Z' }, options), { outcome: 'rejected', reason: 'future_timestamp' });
  assert.deepEqual(await db.ingest({ ...envelope, occurred_at: 'invalid' }, options), { outcome: 'rejected', reason: 'invalid_timestamp' });
  const count = await db.query<{ count: string }>('SELECT count(*) FROM event_keys'); assert.equal(count.rows[0]?.count, '0');
});
test('missing monthly partition rolls back identity, facts and derived work together', async t => {
  const db = await testDatabase(t); await db.migrate();
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'rollback@example.invalid', '事务回滚']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'd'.repeat(64), '合成设备']);
  const envelope = { schema_version: 2 as const, installation_id: installation, client_event_id: 'retry-after-maintenance', occurred_at: '2026-09-22T12:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'atomic-session', payload: { prompt: '原子事实' } };
  const options = { admissionEpoch: 1, receivedAt: new Date('2026-09-23T00:00:00Z') };
  await assert.rejects(db.ingest(envelope, options), { code: '23514' });
  for (const table of ['event_keys', 'sessions', 'hook_events', 'jobs']) {
    const count = await db.query<{ count: string }>(`SELECT count(*) FROM ${table}`); assert.equal(count.rows[0]?.count, '0', table);
  }
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  assert.equal((await db.ingest(envelope, options)).outcome, 'committed');
});
test('suspension and reactivation do not allow buffered events from an old collection epoch', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name,status,ingest_epoch) VALUES($1,$2,$3,$4,$5)', [user, 'suspended@example.invalid', '停用测试', 'suspended', 2]);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'c'.repeat(64), '合成设备']);
  const envelope = { schema_version: 2 as const, installation_id: installation, client_event_id: 'held-event', occurred_at: '2026-09-22T12:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'held-session', payload: { prompt: '不应保存的旧缓冲' } };
  const receivedAt = new Date('2026-09-23T00:00:00Z');
  assert.deepEqual(await db.ingest(envelope, { admissionEpoch: 1, receivedAt }), { outcome: 'rejected', reason: 'account_disabled' });
  await db.query("UPDATE users SET status='active',ingest_epoch=3 WHERE id=$1", [user]);
  assert.deepEqual(await db.ingest(envelope, { admissionEpoch: 1, receivedAt }), { outcome: 'rejected', reason: 'stale_epoch' });
  assert.equal((await db.ingest(envelope, { admissionEpoch: 3, receivedAt })).outcome, 'committed');
  await db.query('UPDATE installations SET enabled=false WHERE id=$1', [installation]);
  assert.deepEqual(await db.ingest({ ...envelope, client_event_id: 'new-event' }, { admissionEpoch: 3, receivedAt }), { outcome: 'rejected', reason: 'installation_disabled' });
  const count = await db.query<{ count: string }>('SELECT count(*) FROM hook_events');
  assert.equal(count.rows[0]?.count, '1');
});

test('storage rejects over-budget JSON before numeric conversion and keeps healthy exact values available afterwards', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'json-budget@example.invalid', '数值预算']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, '9'.repeat(64), '合成设备']);
  const raw = (id: string, payload: string) => `{"schema_version":2,"installation_id":"${installation}","client_event_id":"${id}","occurred_at":"2026-09-22T12:00:00Z","event_type":"UserPromptSubmit","source_session_id":"numeric-session","payload":${payload}}`;
  const options = { admissionEpoch: 1, receivedAt: new Date('2026-09-23Z') };
  assert.deepEqual(await db.ingestJson(raw('numeric-range', '{"number":1e999999999}'), options), { outcome: 'rejected', reason: 'json_budget_exceeded' });
  assert.deepEqual(await db.ingestJson(raw('expansion', '{"values":[' + Array(50).fill('1e100000').join(',') + ']}'), options), { outcome: 'rejected', reason: 'json_budget_exceeded' });
  assert.deepEqual(await db.ingestJson(raw('negative-scale', '{"number":1e-99999}'), options), { outcome: 'rejected', reason: 'json_budget_exceeded' });
  assert.deepEqual(await db.ingestJson('{broken JSON', options), { outcome: 'rejected', reason: 'invalid_json' });
  const healthy = await db.ingestJson(raw('healthy', '{"prompt":"1e999999999 in text","integer":9007199254740993,"tiny":1.230e-5,"scaled":2.10e3}'), options);
  assert.equal(healthy.outcome, 'committed');
  const rows = (await db.query<{ body: string }>('SELECT payload::text AS body FROM hook_events')).rows;
  assert.equal(rows.length, 1); assert.ok(rows[0]!.body.includes('9007199254740993')); assert.ok(rows[0]!.body.includes('0.00001230')); assert.ok(rows[0]!.body.includes('2100'));
  assert.equal((await db.query('SELECT count(*) FROM event_keys')).rows[0]?.count, '1');
});
