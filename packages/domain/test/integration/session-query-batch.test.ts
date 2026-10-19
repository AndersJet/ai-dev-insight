import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../../storage/src/index.js';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { readSessionQuery, type SessionQueryResult } from '../../src/session-usage-query.js';

async function fixture(t: TestContext, count: number, basis: 'single_hook_query' | 'stop_window' = 'stop_window') {
  const f = await stopUsageFixture(t);
  assert.equal((await f.run()).status, 'succeeded');
  const original = (await f.db.query<{ result: SessionQueryResult }>('SELECT result FROM session_usage_queries WHERE session_id=$1', [f.session])).rows[0]!.result;
  const first = original.bills[0]!;
  const bills = Array.from({ length: count }, (_, i) => ({ ...first, id: `bill-${i}`, basis, items: first.items.map(item => ({ ...item, billing_session_id: `bill-${i}` })) }));
  const windows = bills.map(bill => ({ ...original.windows[0]!, ids: [bill.id] }));
  const result = { ...original, bills, windows };
  const save = () => f.db.query('UPDATE session_usage_queries SET result=$2 WHERE session_id=$1', [f.session, result]);
  await save();
  const read = () => readSessionQuery(f.db, 'stop-test', f.session, f.user, { userId: f.user, super: true });
  return { ...f, result, save, read };
}

async function competitor(f: Awaited<ReturnType<typeof fixture>>, at: Date, installation = f.installation) {
  await f.db.ensurePartitions(new Date(at.getTime() - 1000), f.at);
  const id = randomUUID();
  const saved = await f.db.ingest({ schema_version: 2, installation_id: installation, client_event_id: id,
    source_session_id: id, event_type: 'UserPromptSubmit', occurred_at: at.toISOString(), payload: { prompt: 'Synthetic competitor' } },
  { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(saved.outcome, 'committed');
  if (saved.outcome !== 'committed') throw new Error('Competitor must persist');
  return saved.sessionId;
}

async function claim(f: Awaited<ReturnType<typeof fixture>>, session: string, bill: string, account = 'stop-test') {
  await f.db.query(`INSERT INTO session_usage_queries(provider_account,session_id,user_id,provider_user_id,cleanup_generation,ingest_epoch,hook_key,observed_at,result)
    SELECT $3,s.id,s.user_id,q.provider_user_id,u.cleanup_generation,u.ingest_epoch,q.hook_key,q.observed_at,$4
    FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN session_usage_queries q
    WHERE s.id=$1 AND q.session_id=$2 AND q.provider_account='stop-test'`,
  [session, f.session, account, { bills: [{ id: bill }], windows: [], reasons: [] }]);
}

test('bill checks are bounded batches on one repeatable-read backend, with no bill truncation', async t => {
  const f = await fixture(t, 129);
  const queries: string[] = [], backends = new Set<number>();
  const monitored = { ...f.db, transaction: <T>(action: (sql: Transaction) => Promise<T>) => f.db.transaction(sql => action({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => {
      if (text.startsWith('SELECT target.id')) {
        const state = (await sql.query<{ isolation: string; pid: number; jit: string }>("SELECT current_setting('transaction_isolation') AS isolation,pg_backend_pid() AS pid,current_setting('jit') AS jit")).rows[0]!;
        assert.equal(state.isolation, 'repeatable read');
        assert.equal(state.jit, 'off');
        backends.add(state.pid); queries.push(text);
      }
      return sql.query<Row>(text, values);
    },
  })) };
  const result = await readSessionQuery(monitored, 'stop-test', f.session, f.user, { userId: f.user, super: true });
  assert.deepEqual(result?.billing_ids, f.result.bills.map(b => b.id));
  assert.equal(result?.groups[0]?.records, 129);
  assert.equal(queries.length, 4, '129 bills require two claim and two window batches, not 258 round trips');
  assert.equal(backends.size, 1);
});

test('batch results keep each bill window bound to its ID and only withdraw inferred bills for time competition', async t => {
  const f = await fixture(t, 5);
  const second = Math.floor(f.stop.getTime() / 1000);
  f.result.windows.forEach((window, i) => { window.start_seconds = i === 4 ? [] : [second + i]; });
  f.result.bills[3]!.basis = 'single_hook_query';
  f.result.bills.push({ ...f.result.bills[1]!, basis: 'single_hook_query' });
  await f.save();
  const claimed = await competitor(f, new Date(f.start.getTime() - 3600000));
  await claim(f, claimed, 'bill-0');
  await competitor(f, new Date((second + 1) * 1000 + 999));
  const result = await f.read();
  assert.deepEqual(result?.billing_ids, ['bill-2', 'bill-3', 'bill-4', 'bill-1']);
  assert.equal(result?.state, 'partial');
  assert.deepEqual(result?.reasons, ['competing_hook_sessions']);
});

test('claims preserve owner, account, cleanup and ingest generations and history visibility', async t => {
  const f = await fixture(t, 7, 'single_hook_query');
  const other = randomUUID(), installation = randomUUID();
  await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'other-batch@example.invalid','Other batch owner')", [other]);
  await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'Other synthetic installation')", [installation, other, 'b'.repeat(64)]);
  const sessions: string[] = [];
  for (let i = 0; i < 7; i++) sessions.push(await competitor(f, new Date(f.start.getTime() - 3600000 + i * 10000), i === 3 ? installation : f.installation));
  for (let i = 0; i < 7; i++) await claim(f, sessions[i]!, `bill-${i}`, i === 0 ? 'other-account' : 'stop-test');
  await f.db.query('UPDATE session_usage_queries SET cleanup_generation=cleanup_generation+1 WHERE session_id=$1', [sessions[1]]);
  await f.db.query('UPDATE session_usage_queries SET ingest_epoch=ingest_epoch+1 WHERE session_id=$1', [sessions[2]]);
  await f.db.query('UPDATE sessions SET history_redacted=true WHERE id=$1', [sessions[4]]);
  await f.db.query(`INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation)
    SELECT user_id,first_at,last_at+interval '1 second',1 FROM sessions WHERE id=$1`, [sessions[5]]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0', 'bill-1', 'bill-2', 'bill-3', 'bill-4', 'bill-5']);
  await f.db.query('UPDATE sessions SET history_expired=true WHERE id=$1', [sessions[6]]);
  assert.deepEqual((await f.read())?.billing_ids, f.result.bills.map(b => b.id));
});

test('time competition requires a retained, uncleared Hook and a visible session', async t => {
  const f = await fixture(t, 1);
  const old = new Date(f.start.getTime() - 3600000);
  const session = await competitor(f, old);
  await f.db.query('UPDATE sessions SET last_at=$2 WHERE id=$1', [session, f.stop]);
  assert.deepEqual((await f.read())?.billing_ids, []);
  await f.db.query('UPDATE sessions SET history_redacted=true WHERE id=$1', [session]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
  await f.db.query('UPDATE sessions SET history_redacted=false,history_expired=true WHERE id=$1', [session]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
  await f.db.query('UPDATE sessions SET history_expired=false WHERE id=$1', [session]);
  await f.db.query('UPDATE data_identity SET retention_cutoff=$1', [f.start]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
  await f.db.query('UPDATE data_identity SET retention_cutoff=NULL');
  await f.db.query("INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)", [f.user, old, new Date(old.getTime() + 1000)]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
  await f.db.query('DELETE FROM cleanup_tombstones');
  await f.db.query('DELETE FROM hook_events WHERE session_id=$1', [session]);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
});

test('a concurrent competitor change does not mix snapshots between the two batch queries', async t => {
  const f = await fixture(t, 1);
  const session = await competitor(f, f.stop);
  let changed = false;
  const monitored = { ...f.db, transaction: <T>(action: (sql: Transaction) => Promise<T>) => f.db.transaction(sql => action({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => {
      const result = await sql.query<Row>(text, values);
      if (!changed && text.startsWith('SELECT target.id FROM unnest')) {
        changed = true;
        await f.db.query('UPDATE sessions SET history_redacted=true WHERE id=$1', [session]);
      }
      return result;
    },
  })) };
  assert.deepEqual((await readSessionQuery(monitored, 'stop-test', f.session, f.user, { userId: f.user, super: true }))?.billing_ids, []);
  assert.equal(changed, true);
  assert.deepEqual((await f.read())?.billing_ids, ['bill-0']);
});
