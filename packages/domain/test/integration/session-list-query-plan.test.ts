import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Database, type Transaction } from '../../../storage/src/index.js';
import { connectionString } from '../../../storage/test/helpers.js';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { createSessionReadService } from '../../src/session-reading.js';
import { createSessionPersonalModelService } from '../../src/session-personal-models.js';

type Fixture = Awaited<ReturnType<typeof stopUsageFixture>>;
type Plan = { JIT?: { Functions: number }; Settings?: Record<string, string> };
type Statement = { sql: string; values: unknown[] | undefined; jit: string; pid: number; plan: Plan };

// Observe the real query on its checked-out connection. This is neither a
// substitute Database nor a test that merely asserts the SET statement text.
function observeList(db: Database, statements: Statement[]) {
  function observed(client: Transaction) {
    return new Proxy(client, {
      get(target, key, receiver) {
        if (key === 'query') return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql.startsWith('WITH visible AS MATERIALIZED')) {
            const state = (await target.query<{ jit: string; pid: number }>("SELECT current_setting('jit') AS jit,pg_backend_pid() AS pid")).rows[0]!;
            const explained = await target.query<{ 'QUERY PLAN': Plan[] }>(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${sql}`, values);
            statements.push({ sql, values, ...state, plan: explained.rows[0]!['QUERY PLAN'][0]! });
          }
          return result;
        };
        return Reflect.get(target, key, receiver);
      },
    });
  }
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'transaction') return <T>(action: (client: Transaction) => Promise<T>) => target.transaction(client => action(observed(client)));
      if (key === 'query') return observed(target).query;
      return Reflect.get(target, key, receiver);
    },
  });
}

async function put(f: Fixture, source: string, at: Date, event_type: 'UserPromptSubmit' | 'Stop' = 'UserPromptSubmit') {
  const saved = await f.db.ingest({
    schema_version: 2, installation_id: f.installation, client_event_id: randomUUID(), source_session_id: source,
    event_type, occurred_at: at.toISOString(), payload: event_type === 'Stop' ? { last_assistant_message: source } : { prompt: source },
  }, { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(saved.outcome, 'committed');
  if (saved.outcome !== 'committed') throw new Error('Synthetic list fixture did not commit');
  return saved.sessionId;
}

async function publish(f: Fixture, session: string) {
  const job = await f.jobs.enqueue(session);
  for (let batch = 0; batch < 20; batch++) {
    assert.equal(await f.jobs.runOne(), true);
    const state = await f.jobs.status(job);
    assert.equal(state.error_code, null);
    if (state.status === 'succeeded') return;
  }
  throw new Error('Synthetic list fixture exceeded its bounded worker batches');
}

async function otherOwner(f: Fixture) {
  const user = randomUUID(), installation = randomUUID(), email = `list-other-${randomUUID()}@example.invalid`;
  await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, email, '另一位本人']);
  const issued = await f.identity.resetPassword(f.login.token, user, 1);
  const initial = await f.identity.login(email, issued.temporaryPassword);
  const login = await f.identity.changePassword(initial.token, issued.temporaryPassword, 'list-other-synthetic-password');
  await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'列表其他安装')", [installation, user, 'b'.repeat(64)]);
  const saved = await f.db.ingest({ schema_version: 2, installation_id: installation, client_event_id: randomUUID(), source_session_id: 'other-owner', event_type: 'UserPromptSubmit', occurred_at: f.at.toISOString(), payload: { prompt: 'PRIVATE_OTHER_OWNER' } }, { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(saved.outcome, 'committed');
  if (saved.outcome !== 'committed') throw new Error('Synthetic other owner did not commit');
  return { user, login, session: saved.sessionId };
}

test('the real Stop-enabled mine and organization list plans disable JIT locally and restore the reused connection', async t => {
  const f = await stopUsageFixture(t);
  assert.equal((await f.run()).status, 'succeeded');
  const published = (await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM session_usage_queries WHERE session_id=$1 AND jsonb_array_length(result->'bills')>0", [f.session])).rows[0]!;
  assert.equal(published.n, 1, 'the expensive official query branch must contain a valid published Stop result');
  const db = openDatabase({ connectionString, schema: f.db.schema, maxConnections: 1 });
  t.after(() => db.close());
  // Force an eligible, cheap JIT baseline independently of changing estimates.
  // Inlining/optimization are excluded to keep this regression deterministic.
  await db.query('SET jit=on');
  await db.query('SET jit_above_cost=0');
  await db.query('SET jit_inline_above_cost=1000000000');
  await db.query('SET jit_optimize_above_cost=1000000000');
  const before = (await db.query<{ jit: string; pid: number }>("SELECT current_setting('jit') AS jit,pg_backend_pid() AS pid")).rows[0]!;
  assert.equal(before.jit, 'on');
  const statements: Statement[] = [];
  const reader = createSessionReadService(observeList(db, statements), f.identity, { providerAccount: 'stop-test', stopWindowEnabled: true });
  for (const result of [await reader.listMine(f.login.token, { channel: 'official' }), await reader.listAll(f.login.token, { channel: 'all' })]) {
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.official_tokens, '176004');
    assert.equal(result.items[0]?.official_records, 1);
  }
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.equal(statement.jit, 'off');
    assert.equal(statement.pid, before.pid);
    assert.equal(statement.plan.JIT, undefined, 'EXPLAIN ANALYZE must show no generated JIT functions');
    assert.equal(statement.plan.Settings?.jit, 'off');
  }
  // The exact same real SQL, outside the list's transaction-local guard, must
  // generate JIT code with this connection's original planner settings.
  const baseline = (await db.query<{ 'QUERY PLAN': Plan[] }>(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${statements[0]!.sql}`, statements[0]!.values)).rows[0]!['QUERY PLAN'][0]!;
  assert.ok((baseline.JIT?.Functions ?? 0) > 0, 'the unguarded baseline must actually compile JIT functions');
  const after = (await db.query<{ jit: string; pid: number }>("SELECT current_setting('jit') AS jit,pg_backend_pid() AS pid")).rows[0]!;
  assert.deepEqual(after, before, 'a subsequent query on the same backend must retain its original JIT setting');
  t.diagnostic(`Actual Stop-enabled list EXPLAIN ANALYZE: unguarded baseline compiles ${baseline.JIT!.Functions} JIT functions; guarded reads compile none; the same pooled backend remains jit=on after both reads.`);
});

test('Stop-enabled list classification keeps precise totals, search, owner boundaries and pagination for all four filters', async t => {
  const f = await stopUsageFixture(t);
  await f.run();
  const mixed = await put(f, 'list-mixed', new Date(f.start.getTime() - 120000));
  await put(f, 'list-mixed', new Date(f.start.getTime() - 60000), 'Stop');
  f.control.ids = ['mixed-bill']; f.control.tokens = 42;
  await publish(f, mixed);
  const custom = await put(f, 'list-custom', new Date(f.start.getTime() - 180000));
  const pending = await put(f, 'list-pending', new Date(f.start.getTime() - 240000));
  const unknown = await put(f, 'list-unknown', new Date(f.start.getTime() - 300000));
  const laterPrompt = await f.db.ingest({ schema_version: 2, installation_id: f.installation, client_event_id: randomUUID(), source_session_id: 'list-unknown', event_type: 'UserPromptSubmit', occurred_at: new Date(f.start.getTime() - 299000).toISOString(), payload: { prompt: 'LATE_SEARCH_NEEDLE' } }, { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(laterPrompt.outcome, 'committed');
  const declarations = createSessionPersonalModelService(f.db, f.identity);
  for (const session of [mixed, custom]) await declarations.replace(f.login.token, session, { version: 0, cleanup_generation: 0, models: ['Owner supplied model'] });
  await f.jobs.enqueue(pending);
  const other = await otherOwner(f);
  const departments = (await f.db.query<{ id: string }>("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'列表部门一'),(gen_random_uuid(),'列表部门二') RETURNING id")).rows;
  await f.db.query('UPDATE hook_events SET department_id=$1 WHERE user_id=$2', [departments[0]!.id, f.user]);
  await f.db.query('UPDATE hook_events SET department_id=$1 WHERE user_id=$2', [departments[1]!.id, other.user]);
  const expected = { all: [f.session, mixed, custom, pending, unknown], official: [f.session, mixed], pending: [pending], custom: [custom, mixed] };
  for (const channel of ['all', 'official', 'pending', 'custom'] as const) {
    const page = await f.reader.listMine(f.login.token, { channel, limit: 1 });
    assert.equal(page.total, expected[channel].length);
    assert.equal(page.items.length, 1);
    const seen = page.items.map(row => row.id);
    let cursor = page.next_cursor;
    while (cursor) {
      const next = await f.reader.listMine(f.login.token, { channel, limit: 1, cursor });
      assert.equal(next.total, expected[channel].length);
      seen.push(...next.items.map(row => row.id)); cursor = next.next_cursor;
      assert.ok(seen.length <= expected[channel].length);
    }
    assert.deepEqual([...new Set(seen)].sort(), [...expected[channel]].sort());
    assert.ok(!seen.includes(other.session));
  }
  const all = await f.reader.listMine(f.login.token, {});
  assert.equal(all.items.find(row => row.id === mixed)?.channel, 'mixed');
  assert.equal(all.items.find(row => row.id === mixed)?.official_tokens, '42');
  assert.equal(all.items.find(row => row.id === custom)?.channel, 'custom');
  assert.equal(all.items.find(row => row.id === pending)?.channel, 'pending');
  assert.equal(all.items.find(row => row.id === unknown)?.channel, 'unknown');
  const searched = await f.reader.listMine(f.login.token, { search: 'LATE_SEARCH_NEEDLE', limit: 1 });
  assert.equal(searched.total, 1); assert.equal(searched.items[0]?.id, unknown);
  assert.equal(searched.items[0]?.title, 'list-unknown', 'search must include later prompts outside the first unfiltered page');
  assert.equal((await f.reader.listAll(f.login.token, {})).total, 6);
  assert.equal((await f.reader.listAll(f.login.token, { department_id: departments[0]!.id })).total, 5);
  assert.equal((await f.reader.listAll(f.login.token, { department_id: departments[1]!.id })).total, 1);
  assert.equal((await f.reader.listMine(f.login.token, { search: 'PRIVATE_OTHER_OWNER' })).total, 0);
  assert.equal((await f.reader.listAll(f.login.token, { search: 'PRIVATE_OTHER_OWNER' })).total, 1);
  assert.equal((await f.reader.listMine(other.login.token, {})).total, 1);
  await assert.rejects(f.reader.listAll(other.login.token, {}), { code: 'forbidden' });
});

test('a competing Hook outside the returned page and search scope withdraws inferred official quantities', async t => {
  const f = await stopUsageFixture(t);
  await put(f, 'synthetic-hook', new Date(f.stop.getTime() + 3000), 'Stop');
  await f.run();
  assert.equal((await f.reader.listMine(f.login.token, { limit: 1 })).items[0]?.official_tokens, '176004');
  const competitor = await put(f, 'OUT_OF_PAGE_COMPETITOR', new Date(Math.floor(f.stop.getTime() / 1000) * 1000));
  const first = await f.reader.listMine(f.login.token, { limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.items[0]?.id, f.session);
  assert.equal(first.items[0]?.official_tokens, null); assert.equal(first.items[0]?.official_records, 0);
  const searched = await f.reader.listMine(f.login.token, { search: 'Stop用量测试', limit: 1 });
  assert.equal(searched.total, 1); assert.equal(searched.items[0]?.id, f.session);
  assert.equal(searched.items[0]?.official_tokens, null);
  assert.equal((await f.reader.listMine(f.login.token, { channel: 'official' })).total, 0);
  await f.db.query('UPDATE sessions SET history_redacted=true WHERE id=$1', [competitor]);
  assert.equal((await f.reader.listMine(f.login.token, { channel: 'official' })).items[0]?.official_tokens, '176004');
});

test('provider ownership, new Hook signatures and cleanup fences still invalidate Stop-enabled list quantities', async t => {
  const f = await stopUsageFixture(t); await f.run();
  const other = await otherOwner(f);
  await f.db.query("UPDATE session_usage_queries SET provider_user_id='incorrect-owner' WHERE session_id=$1", [f.session]);
  assert.equal((await f.reader.listMine(f.login.token, {})).items[0]?.official_tokens, null);
  assert.equal((await f.reader.listMine(f.login.token, { channel: 'official' })).total, 0);
  await f.run();
  assert.equal((await f.reader.listMine(f.login.token, {})).items[0]?.official_tokens, '176004');
  await put(f, 'synthetic-hook', new Date(f.at.getTime() - 3000));
  assert.equal((await f.reader.listMine(f.login.token, {})).items[0]?.official_tokens, null);
  await f.run();
  assert.equal((await f.reader.listMine(f.login.token, {})).items[0]?.official_tokens, '176004');
  await f.db.transaction(async client => {
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [f.user]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)', [f.user, f.start, new Date(f.at.getTime() + 1000)]);
  });
  assert.equal((await f.reader.listMine(f.login.token, {})).total, 0);
  const remaining = await f.reader.listAll(f.login.token, {});
  assert.equal(remaining.total, 1); assert.equal(remaining.items[0]?.id, other.session);
});

test('a competing historical Hook outside the selected period still fences a visible continuing session', async t => {
  const f = await stopUsageFixture(t);
  const historicalStop = new Date(f.stop.getTime() - 86400000);
  await f.db.ensurePartitions(historicalStop, new Date(f.at.getTime() + 1000));
  await put(f, 'synthetic-hook', historicalStop, 'Stop');
  await put(f, 'synthetic-hook', f.at);
  await f.run();
  const from = new Date(Math.floor((f.at.getTime() + 28800000) / 86400000) * 86400000 - 28800000);
  const period = { from: from.toISOString(), to: new Date(from.getTime() + 86400000).toISOString() };
  assert.equal((await f.reader.listMine(f.login.token, period)).items[0]?.official_tokens, '176004');
  const competitor = await put(f, 'OUT_OF_PERIOD_COMPETITOR', new Date(Math.floor(historicalStop.getTime() / 1000) * 1000));
  const page = await f.reader.listMine(f.login.token, { ...period, limit: 1 });
  assert.equal(page.total, 1); assert.equal(page.items[0]?.id, f.session);
  assert.equal(page.items[0]?.official_tokens, null);
  assert.equal((await f.reader.listMine(f.login.token, { ...period, channel: 'official' })).total, 0);
  await f.db.query('UPDATE sessions SET history_redacted=true WHERE id=$1', [competitor]);
  assert.equal((await f.reader.listMine(f.login.token, { ...period, channel: 'official' })).items[0]?.official_tokens, '176004');
});
