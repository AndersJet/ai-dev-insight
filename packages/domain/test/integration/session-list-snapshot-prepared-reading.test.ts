import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@adi/storage';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { createSessionReadService } from '../../src/session-reading.js';
import { createSessionListSnapshotPublisher } from '../../src/session-list-snapshot-publisher.js';
import { createSessionListSnapshotReader } from '../../src/session-list-snapshot-reading.js';

type Observation = { text: string; values: unknown[]; entries: string[]; safe: boolean | undefined };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  // This is a deadlock guard for an intentionally held delivery, not a latency
  // assertion and not a change to any PostgreSQL/application deadline.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Prepared snapshot gate did not progress: ' + label)), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function valueOf<T>(promise: Promise<Outcome<T>>, label: string): Promise<T> {
  const result = await bounded(promise, label);
  if (!result.ok) throw result.error;
  return result.value;
}
function gate(matches: (observation: Observation) => boolean) {
  let release!: () => void, entered!: (observation: Observation) => void, claimed = false;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<Observation>(resolve => { entered = resolve; });
  return {
    reached, release,
    async after(observation: Observation) {
      if (claimed || !matches(observation)) return;
      claimed = true; entered(observation); await delivery;
    },
  };
}
const payloadSql = (text: string) => text.includes('FROM session_list_snapshot_entries') && text.includes('payload');
const fenceSql = (observation: Observation, snapshot: string) => observation.text.includes('SELECT d.recovery_id') && observation.values[0] === snapshot && observation.values[2] === null;

async function preparedFixture(t: TestContext) {
  const f = await stopUsageFixture(t), other = randomUUID(), installation = randomUUID();
  await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,$2,'稳定的另一用户')", [other, 'prepared-' + other + '@example.invalid']);
  await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'稳定合成安装')", [installation, other, 'b'.repeat(64)]);
  const otherEvent = await f.db.ingest({ schema_version: 2, installation_id: installation, client_event_id: randomUUID(), source_session_id: 'prepared-stable-owner', event_type: 'UserPromptSubmit', occurred_at: new Date(f.start.getTime() + 1).toISOString(), payload: { prompt: '稳定用户的合成提示' } }, { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(otherEvent.outcome, 'committed');
  // Keep clock advances away from Beijing midnight; raw facts remain in the
  // real loader's common 45/7-day windows and identity uses its real clock.
  let time = Math.floor((f.at.getTime() + 28_800_000) / 86_400_000) * 86_400_000 - 28_800_000 + 43_200_000;
  const clock = () => new Date(time), options = { providerAccount: 'stop-test', stopWindowEnabled: false, clock };
  const observations: Observation[] = [], gates: ReturnType<typeof gate>[] = [];
  function trace<T extends Transaction>(target: T): T {
    return new Proxy(target, { get(sql, property, receiver) {
      if (property !== 'query') return Reflect.get(sql, property, receiver);
      return async (text: string, values?: unknown[]) => {
        const result = await sql.query(text, values);
        const observation: Observation = { text, values: values ?? [], entries: payloadSql(text) ? result.rows.map(row => String(row.id)) : [], safe: typeof result.rows[0]?.safe === 'boolean' ? result.rows[0].safe : undefined };
        observations.push(observation);
        // Every result is produced by real PostgreSQL and returned unchanged.
        // Only delivery to the reader is held; no pool connection is held here.
        for (const hold of gates) await hold.after(observation);
        return result;
      };
    } });
  }
  const db = new Proxy(f.db, { get(target, property, receiver) {
    if (property === 'query') return trace(target).query;
    if (property === 'transaction') return (action: (sql: Transaction) => Promise<unknown>) => target.transaction(sql => action(trace(sql)));
    return Reflect.get(target, property, receiver);
  } });
  const publisher = createSessionListSnapshotPublisher(f.db, options), snapshots = createSessionListSnapshotReader(db, options);
  let readStarted: (() => void) | null = null;
  const observedSnapshots = new Proxy(snapshots, { get(target, property, receiver) {
    if (property !== 'read') return Reflect.get(target, property, receiver);
    return (...args: Parameters<typeof target.read>) => {
      const pending = target.read(...args);
      const notify = readStarted; readStarted = null; notify?.();
      return pending;
    };
  } });
  const reader = createSessionReadService(db, f.identity, { ...options, snapshots: observedSnapshots });
  assert.equal(await publisher.runOne(true), true);
  const initial = (await publisher.latest())!;
  assert.equal(await bounded(snapshots.warm(), 'initial complete preparation'), initial.id);
  async function add(source: string) {
    const saved = await f.db.ingest({ schema_version: 2, installation_id: f.installation, client_event_id: randomUUID(), source_session_id: source, event_type: 'UserPromptSubmit', occurred_at: new Date(f.start.getTime() + 2000).toISOString(), payload: { prompt: source } }, { admissionEpoch: 1, receivedAt: f.at });
    assert.equal(saved.outcome, 'committed');
    if (saved.outcome !== 'committed') throw new Error('Synthetic ordinary addition did not commit');
    time += 1000;
    assert.equal(await publisher.runOne(true), true);
    return { publication: (await publisher.latest())!, session: saved.sessionId };
  }
  async function clearWithCleanup() {
    await f.db.transaction(async sql => {
      await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [f.user]);
      await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) SELECT id,$2,$3,cleanup_generation FROM users WHERE id=$1', [f.user, f.start, new Date(f.start.getTime() + 3000)]);
    });
    await assert.rejects(bounded(reader.listAll(f.login.token, {}), 'real foreground cleanup fence'), error => ['content_changed', 'session_snapshot_pending'].includes(errorCode(error)));
  }
  async function publishCurrent() {
    time += 1000;
    assert.equal(await publisher.runOne(true), true);
    return (await publisher.latest())!;
  }
  function nextReadStart() {
    assert.equal(readStarted, null);
    return new Promise<void>(resolve => { readStarted = resolve; });
  }
  return { f, other, clock, advance: (milliseconds: number) => { time += milliseconds; }, publisher, snapshots, reader, initial, observations, gates, add, clearWithCleanup, publishCurrent, nextReadStart, releaseAll: () => { for (const hold of gates) hold.release(); } };
}

test('ordinary reads use complete prepared A while only the dirty owner of published B is loading', async t => {
  const x = await preparedFixture(t);
  const allA = await x.reader.listAll(x.f.login.token, {}), firstA = await x.reader.listAll(x.f.login.token, { limit: 1 });
  assert.equal(allA.total, 2); assert.ok(firstA.next_cursor);
  await bounded(x.snapshots.warm(), 'settle initial ready flight');
  const start = x.observations.length, b = await x.add('PREPARED_ORDINARY_B');
  assert.notEqual(b.publication.owner_entries[x.f.user], x.initial.owner_entries[x.f.user]);
  assert.equal(b.publication.owner_entries[x.other], x.initial.owner_entries[x.other]);
  const hold = gate(observation => observation.entries.includes(b.publication.owner_entries[x.f.user]!));
  x.gates.push(hold);
  const warming = settle(x.snapshots.warm());
  try {
    await bounded(hold.reached, 'published B actual payload delivery');
    const during = await bounded(x.reader.listAll(x.f.login.token, {}), 'ordinary read must not wait for B delivery');
    assert.deepEqual(during.items, allA.items); assert.equal(during.total, allA.total);
    assert.equal(during.snapshot?.id, x.initial.id); assert.equal(during.snapshot?.as_of, x.initial.as_of.toISOString());
    assert.equal(during.snapshot?.expires_at, x.initial.expires_at.toISOString()); assert.equal(during.snapshot?.updating, true);
    const pinned = await bounded(x.reader.listAll(x.f.login.token, { limit: 1, cursor: firstA.next_cursor! }), 'signed A page while B is blocked');
    assert.equal(pinned.snapshot?.id, x.initial.id); assert.equal(pinned.total, allA.total); assert.equal(pinned.items[0]?.id, allA.items[1]?.id);
    assert.deepEqual(x.observations.slice(start).flatMap(observation => observation.entries), [b.publication.owner_entries[x.f.user]]);
    assert.equal(x.observations.slice(start).filter(observation => observation.text.includes('FROM hook_events')).length, 0, 'background metadata must not prewarm body searches');
    hold.release();
    assert.equal(await valueOf(warming, 'B complete atomic preparation'), b.publication.id);
    const current = await x.reader.listAll(x.f.login.token, {});
    assert.equal(current.snapshot?.id, b.publication.id); assert.equal(current.total, allA.total + 1);
    assert.ok(current.items.some(row => row.id === b.session));
    const oldPage = await x.reader.listAll(x.f.login.token, { limit: 1, cursor: firstA.next_cursor! });
    assert.equal(oldPage.snapshot?.id, x.initial.id); assert.equal(oldPage.total, allA.total); assert.equal(oldPage.snapshot?.updating, true);
  } finally { x.releaseAll(); await bounded(warming, 'release B after assertion failure'); }
});

for (const stage of ['entry', 'final fence'] as const) test('a late ' + stage + ' delivery cannot repopulate or supersede the post-cleanup C flight', async t => {
  const x = await preparedFixture(t), b = await x.add('PREPARED_PRIVATE_B');
  const bEntry = b.publication.owner_entries[x.f.user]!;
  const old = gate(observation => stage === 'entry' ? observation.entries.includes(bEntry) : fenceSql(observation, b.publication.id) && observation.safe === true && x.observations.some(seen => seen.entries.includes(bEntry)));
  x.gates.push(old);
  const oldFlight = settle(x.snapshots.warm());
  let firstCurrent: Promise<Outcome<string>> | undefined, secondCurrent: Promise<Outcome<string>> | undefined;
  try {
    await bounded(old.reached, 'B ' + stage + ' actual result');
    await x.clearWithCleanup();
    const c = await x.publishCurrent(), cEntries = Object.values(c.owner_entries), currentStart = x.observations.length;
    const current = gate(observation => observation.entries.some(id => cEntries.includes(id)));
    x.gates.push(current);
    firstCurrent = settle(x.snapshots.warm());
    await bounded(current.reached, 'new epoch C actual payload delivery');
    old.release();
    await bounded(oldFlight, 'late B finishes while C is still blocked');
    const readStart = x.nextReadStart(), during = settle(x.reader.listAll(x.f.login.token, {}));
    await bounded(readStart, 'post-clear foreground enters the actual snapshot reader');
    // A stale completion must neither promote B nor clear C's single-flight
    // token. A second explicit warm joins C rather than fetching it again.
    secondCurrent = settle(x.snapshots.warm());
    current.release();
    assert.equal(await valueOf(firstCurrent, 'first post-cleanup C preparation'), c.id);
    assert.equal(await valueOf(secondCurrent, 'same-slot C join'), c.id);
    const duringPage = await valueOf(during, 'foreground joins C without observing late B');
    assert.equal(duringPage.snapshot?.id, c.id);
    assert.deepEqual(x.observations.slice(currentStart).flatMap(observation => observation.entries).sort(), [...cEntries].sort(), 'C owner payloads are loaded once in the new epoch');
    const page = await x.reader.listAll(x.f.login.token, {});
    assert.equal(page.snapshot?.id, c.id); assert.ok(!page.items.some(row => row.id === b.session));
    assert.ok(!page.items.some(row => row.title.includes('PREPARED_PRIVATE_B')));
    assert.equal((await x.f.db.query('SELECT count(*)::integer AS n FROM hook_events WHERE session_id=$1', [b.session])).rows[0]!.n, 1, 'fence rejection and epoch invalidation precede physical removal');
  } finally {
    x.releaseAll(); await bounded(oldFlight, 'release stale B after assertion failure');
    if (firstCurrent) await bounded(firstCurrent, 'release first C after assertion failure');
    if (secondCurrent) await bounded(secondCurrent, 'release joined C after assertion failure');
  }
});

test('prepared renewals reuse stable payloads and candidate expiry never renews old snapshots or cursors', async t => {
  const x = await preparedFixture(t), firstA = await x.reader.listAll(x.f.login.token, { limit: 1 });
  assert.ok(firstA.next_cursor); await bounded(x.snapshots.warm(), 'settle A before renewal');
  const payloads = x.observations.flatMap(observation => observation.entries).length;
  x.advance(20_000);
  assert.equal(await x.publisher.runOne(true), true);
  const b = (await x.publisher.latest())!;
  assert.notEqual(b.id, x.initial.id); assert.deepEqual(b.owner_entries, x.initial.owner_entries);
  assert.equal(await bounded(x.snapshots.warm(), 'stable renewed B'), b.id);
  assert.equal(x.observations.flatMap(observation => observation.entries).length, payloads, 'a new UUID with unchanged owner references requires no payload reads');
  const readyB = await x.reader.listAll(x.f.login.token, { limit: 1 });
  assert.equal(readyB.snapshot?.id, b.id); assert.equal(readyB.snapshot?.as_of, b.as_of.toISOString());
  assert.equal(readyB.snapshot?.expires_at, b.expires_at.toISOString());
  assert.equal(b.expires_at.getTime() - b.as_of.getTime(), 60_000);
  await bounded(x.snapshots.warm(), 'settle B before expiring candidate');
  const c = await x.add('PREPARED_EXPIRED_C'), hold = gate(observation => observation.entries.includes(c.publication.owner_entries[x.f.user]!));
  x.gates.push(hold);
  const warming = settle(x.snapshots.warm());
  try {
    await bounded(hold.reached, 'expiring candidate C actual payload');
    x.advance(60_001);
    assert.ok(x.clock().getTime() > c.publication.expires_at.getTime());
    await assert.rejects(bounded(x.reader.listAll(x.f.login.token, { limit: 1, cursor: firstA.next_cursor! }), 'expired signed A cursor'), { code: 'session_snapshot_expired', status: 409 });
    hold.release();
    const expired = await bounded(warming, 'expired candidate completion');
    assert.equal(expired.ok, false, 'an expired candidate cannot become prepared ready');
    await assert.rejects(bounded(x.reader.listAll(x.f.login.token, {}), 'no unexpired ready or published candidate'), { code: 'session_snapshot_pending', status: 503 });
    assert.equal((await x.f.db.query('SELECT as_of,expires_at FROM session_list_snapshots WHERE id=$1', [c.publication.id])).rows[0]!.expires_at.getTime(), c.publication.expires_at.getTime(), 'the stored publication lifetime is never extended');
    const d = await x.publishCurrent();
    assert.equal(await bounded(x.snapshots.warm(), 'new genuine publication after expiry'), d.id);
    const fresh = await x.reader.listAll(x.f.login.token, {});
    assert.equal(fresh.snapshot?.id, d.id); assert.equal(fresh.snapshot?.as_of, d.as_of.toISOString());
    assert.equal(fresh.snapshot?.expires_at, d.expires_at.toISOString());
  } finally { x.releaseAll(); await bounded(warming, 'release expired candidate after assertion failure'); }
});
