import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseError as PostgresError } from 'pg';
import { DatabaseIoTimeout, ingestFailureProof, openDatabase, type Database, type IngestOptions } from '../src/index.js';
import { connectionString, testDatabase } from './helpers.js';
import { postgresFaultProxy } from './fixtures/pg-fault-proxy.js';

async function fixture(t: TestContext) {
  const db = await testDatabase(t); await db.migrate();
  const receivedAt = new Date();
  await db.ensurePartitions(new Date(receivedAt.getTime() - 86_400_000), new Date(receivedAt.getTime() + 86_400_000));
  const user = randomUUID(), installation = randomUUID(), tokenHash = 'e'.repeat(64);
  await db.query('INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,$2,$3,$4)', [user, 'abort-proof@example.invalid', 'Synthetic ingest proof', receivedAt]);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, tokenHash, 'Synthetic device']);
  const options: IngestOptions = { admissionEpoch: 1, receivedAt, tokenHash };
  const body = (id: string) => JSON.stringify({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at: receivedAt.toISOString(), event_type: 'UserPromptSubmit', source_session_id: 'ingest-proof', payload: { prompt: 'Synthetic fact' } });
  return { db, user, installation, options, body };
}

async function rejected(pending: Promise<unknown>): Promise<Error> {
  try { await pending; } catch (error) { assert.ok(error instanceof Error); return error; }
  assert.fail('Expected the database operation to reject');
}

function postgresCause(error: Error): PostgresError {
  const cause = error instanceof DatabaseIoTimeout ? error.cause : error;
  assert.ok(cause instanceof PostgresError, 'the failure must originate in a PostgreSQL server response');
  return cause;
}

async function assertCounts(db: Database, count: number) {
  const row = (await db.query<{ facts: number; keys: number; sessions: number; jobs: number }>(`SELECT
    (SELECT count(*)::int FROM hook_events) AS facts,
    (SELECT count(*)::int FROM event_keys) AS keys,
    (SELECT count(*)::int FROM sessions) AS sessions,
    (SELECT count(*)::int FROM jobs WHERE kind='derive_session') AS jobs`)).rows[0];
  assert.deepEqual(row, { facts: count, keys: count, sessions: count, jobs: count });
}

async function assertOriginalReceipt(db: Database, receivedAt: Date) {
  const rows = (await db.query<{ received_at: Date; first_seen: Date }>('SELECT h.received_at,k.first_seen FROM hook_events h JOIN event_keys k ON k.event_id=h.id')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.received_at.toISOString(), receivedAt.toISOString());
  assert.equal(rows[0]!.first_seen.toISOString(), receivedAt.toISOString());
}

test('only eligible native server aborts before private ingest COMMIT receive server_abort proof', async t => {
  for (const code of ['55P03', '57014', '40001', '40P01', '23514']) {
    await t.test(code, async sub => {
      const { db, body, options } = await fixture(sub);
      await db.query(`CREATE FUNCTION fail_hook_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE=TG_ARGV[0], MESSAGE='Synthetic native ingest abort'; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER fail_hook_insert BEFORE INSERT ON hook_events FOR EACH ROW EXECUTE FUNCTION fail_hook_insert('${code}')`);
      const error = await rejected(db.ingestJson(body('aborted'), options));
      assert.equal(postgresCause(error).code, code);
      assert.equal(ingestFailureProof(error), code === '23514' ? null : 'server_abort');
      assert.equal(ingestFailureProof(new Error('cause alone is not proof', { cause: error })), null);
      assert.equal(ingestFailureProof({ ...error }), null);
      await assertCounts(db, 0);
      await db.query('DROP TRIGGER fail_hook_insert ON hook_events');
      assert.equal((await db.ingestJson(body('aborted'), options)).outcome, 'committed');
      await assertCounts(db, 1); await assertOriginalReceipt(db, options.receivedAt);
    });
  }
});

test('the actual five-second statement timeout proves abort and a manual retry commits once', { timeout: 20000 }, async t => {
  const { db, body, options } = await fixture(t);
  await db.query('CREATE SEQUENCE first_insert_attempt');
  await db.query(`CREATE FUNCTION sleep_first_hook_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF nextval(TG_TABLE_SCHEMA||'.first_insert_attempt')=1 THEN PERFORM pg_sleep(8); END IF;
    RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER sleep_first_hook_insert BEFORE INSERT ON hook_events FOR EACH ROW EXECUTE FUNCTION sleep_first_hook_insert()');
  const error = await rejected(db.ingestJson(body('server-timeout'), options));
  assert.ok(error instanceof DatabaseIoTimeout);
  assert.equal(postgresCause(error).code, '57014');
  assert.match(postgresCause(error).message, /statement timeout/);
  assert.equal(ingestFailureProof(error), 'server_abort');
  assert.deepEqual((await db.query('SELECT last_value::int,is_called FROM first_insert_attempt')).rows, [{ last_value: 1, is_called: true }]);
  await assertCounts(db, 0);
  assert.equal((await db.ingestJson(body('server-timeout'), options)).outcome, 'committed');
  assert.equal((await db.query('SELECT last_value::int FROM first_insert_attempt')).rows[0]?.last_value, 2);
  await assertCounts(db, 1); await assertOriginalReceipt(db, options.receivedAt);
});

test('a public callback that manually commits cannot obtain ingest proof from a later native server abort', async t => {
  const db = await testDatabase(t); await db.migrate(); const department = randomUUID();
  const error = await rejected(db.transaction(async client => {
    await client.query('INSERT INTO departments(id,name) VALUES($1,$2)', [department, 'Committed public callback']);
    await client.query('COMMIT');
    await client.query(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='Synthetic post-commit abort'; END $$`);
  }));
  assert.equal(postgresCause(error).code, '55P03'); assert.equal(ingestFailureProof(error), null);
  assert.equal((await db.query('SELECT id FROM departments WHERE id=$1', [department])).rows[0]?.id, department);
});

test('private ingest with a lost actual COMMIT reply remains unproved although its fact committed', { timeout: 20000 }, async t => {
  const { db: baseline, body, options } = await fixture(t);
  await baseline.query('CREATE SEQUENCE commit_attempt');
  await baseline.query(`CREATE FUNCTION sleep_ingest_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.client_event_id='ambiguous-commit' THEN
      PERFORM nextval(TG_TABLE_SCHEMA||'.commit_attempt'); PERFORM pg_sleep(3);
    END IF;
    RETURN NEW; END $$`);
  await baseline.query('CREATE CONSTRAINT TRIGGER sleep_ingest_commit AFTER INSERT ON event_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sleep_ingest_commit()');
  const proxy = await postgresFaultProxy(connectionString);
  const db = openDatabase({ connectionString: proxy.connectionString, schema: baseline.schema, maxConnections: 1 });
  try {
    const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const pending = rejected(db.ingestJson(body('ambiguous-commit'), options));
    let observedCommit = false; const until = Date.now() + 2500;
    while (Date.now() < until) {
      const marker = (await baseline.query<{ is_called: boolean }>('SELECT is_called FROM commit_attempt')).rows[0]?.is_called;
      const activity = (await baseline.query<{ query: string; wait_event: string | null }>('SELECT query,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      if (marker && activity?.query === 'COMMIT' && activity.wait_event === 'PgSleep') { observedCommit = true; break; }
      await delay(10);
    }
    assert.equal(observedCommit, true, 'the fault must start during the actual deferred COMMIT trigger');
    proxy.setMode('drop-responses');
    const error = await pending;
    assert.ok(error instanceof DatabaseIoTimeout); assert.equal(ingestFailureProof(error), null);
    assert.ok(proxy.snapshot().droppedBytes > 0);
    await assertCounts(baseline, 1); await assertOriginalReceipt(baseline, options.receivedAt);
    proxy.setMode('healthy');
    assert.equal((await db.query('SELECT 3 AS marker')).rows[0]?.marker, 3);
    assert.deepEqual(await db.ingestJson(body('ambiguous-commit'), options), { outcome: 'duplicate' });
    await assertCounts(baseline, 1);
    assert.equal((await baseline.query('SELECT last_value::int FROM commit_attempt')).rows[0]?.last_value, 1, 'uncertain ingest must not be automatically replayed');
  } finally { proxy.setMode('healthy'); await proxy.close(); await db.close(); }
});

test('a private ingest client read timeout carries no server-abort or confirmed-rollback proof', { timeout: 15000 }, async t => {
  const { db: baseline, body, options } = await fixture(t);
  const proxy = await postgresFaultProxy(connectionString);
  const db = openDatabase({ connectionString: proxy.connectionString, schema: baseline.schema, maxConnections: 1 });
  try {
    await db.query('SELECT 1'); proxy.setMode('drop-responses');
    const error = await rejected(db.ingestJson(body('silent-begin'), options));
    assert.ok(error instanceof DatabaseIoTimeout); assert.equal(ingestFailureProof(error), null);
    assert.ok(proxy.snapshot().droppedBytes > 0);
    proxy.setMode('healthy');
    assert.equal((await db.ingestJson(body('after-silent-begin'), options)).outcome, 'committed');
    await assertCounts(baseline, 1);
  } finally { proxy.setMode('healthy'); await proxy.close(); await db.close(); }
});

test('pool checkout consumes the retry deadline and confirmed rollback rejects only the expired ingest', async t => {
  const { db: baseline, body, options } = await fixture(t);
  const db = openDatabase({ connectionString, schema: baseline.schema, maxConnections: 1 });
  let unlock: (() => void) | undefined, signalEntered: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const holder = db.transaction(async client => { await client.query('SELECT 1'); signalEntered?.(); await gate; });
  try {
    await Promise.race([entered, holder]);
    const pending = rejected(db.ingestJson(body('expired-in-pool'), options, Date.now() + 100));
    await delay(200); unlock?.(); await holder;
    const error = await pending;
    assert.ok(error instanceof DatabaseIoTimeout); assert.equal(ingestFailureProof(error), 'deadline_rollback');
    await assertCounts(baseline, 0);
    assert.equal((await db.ingestJson(body('after-pool-deadline'), options)).outcome, 'committed');
    await assertCounts(baseline, 1);
    assert.equal((await db.query("SELECT current_setting('statement_timeout') AS timeout")).rows[0]?.timeout, '5s');
  } finally { unlock?.(); await holder.catch(() => {}); await db.close(); }
});

test('the retry deadline also fences COMMIT after individually successful statements exceed the total budget', { timeout: 10000 }, async t => {
  const { db: baseline, body, options } = await fixture(t);
  const db = openDatabase({ connectionString, schema: baseline.schema, maxConnections: 1 });
  try {
    await baseline.query(`CREATE FUNCTION sleep_ingest_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NULL; END $$`);
    await baseline.query('CREATE TRIGGER sleep_event_key_statement BEFORE INSERT ON event_keys FOR EACH STATEMENT EXECUTE FUNCTION sleep_ingest_statement()');
    await baseline.query('CREATE TRIGGER sleep_hook_statement BEFORE INSERT ON hook_events FOR EACH STATEMENT EXECUTE FUNCTION sleep_ingest_statement()');
    await db.query('SELECT 1');
    const error = await rejected(db.ingestJson(body('expired-before-commit'), options, Date.now() + 500));
    assert.ok(error instanceof DatabaseIoTimeout); assert.equal(ingestFailureProof(error), 'deadline_rollback');
    assert.equal(error.cause, undefined, 'two successful sub-budget statements must reach the private pre-COMMIT deadline check');
    await assertCounts(baseline, 0);
    assert.equal((await db.query("SELECT current_setting('statement_timeout') AS timeout")).rows[0]?.timeout, '5s');
    await baseline.query('DROP TRIGGER sleep_event_key_statement ON event_keys');
    await baseline.query('DROP TRIGGER sleep_hook_statement ON hook_events');
    assert.equal((await db.ingestJson(body('after-commit-deadline'), options)).outcome, 'committed');
    await assertCounts(baseline, 1); await assertOriginalReceipt(baseline, options.receivedAt);
  } finally { await db.close(); }
});
