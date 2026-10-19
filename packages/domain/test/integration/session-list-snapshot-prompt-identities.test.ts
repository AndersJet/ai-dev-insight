import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SessionListDto } from '@adi/contracts';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { createSessionReadService, type AllSessionQuery } from '../../src/session-reading.js';
import { createSessionListSnapshotPublisher } from '../../src/session-list-snapshot-publisher.js';
import { createSessionListSnapshotReader } from '../../src/session-list-snapshot-reading.js';

const comparable = (page: SessionListDto) => ({
  period: page.period, items: page.items, total: page.total, has_more: page.has_more,
  channel_available: page.channel_available, available_channels: page.available_channels,
});

test('captured search identities retain same-microsecond UUID order, repeated UUID microseconds and null/A/B departments', async t => {
  const f = await stopUsageFixture(t);
  const a = randomUUID(), b = randomUUID();
  await f.db.query("INSERT INTO departments(id,name) VALUES($1,'Identity department A'),($2,'Identity department B')", [a, b]);
  const low = '00000000-0000-4000-8000-000000000010';
  const middle = '00000000-0000-4000-8000-000000000020';
  const high = '00000000-0000-4000-8000-000000000030';
  const gap = '00000000-0000-4000-8000-000000000015';
  const prefix = new Date(f.start.getTime() + 2000).toISOString().slice(0, 19);
  const at = (microsecond: number) => prefix + '.' + String(microsecond).padStart(6, '0') + 'Z';
  type Fact = { id: string; at: string; department: string | null; prompt: string };
  async function put(facts: Fact[]) {
    await f.db.transaction(async client => {
      const generation = (await client.query<{ generation: number }>(
        "UPDATE jobs SET generation=generation+1 WHERE dedupe_key='derive:'||$1::text RETURNING generation", [f.session],
      )).rows[0]!.generation;
      await client.query(`INSERT INTO hook_events(id,occurred_at,user_id,department_id,installation_id,session_id,event_type,payload,capture_generation)
        SELECT r.id,r.at,$2,r.department,$3,$4,'UserPromptSubmit',jsonb_build_object('prompt',r.prompt),$5
        FROM jsonb_to_recordset($1::jsonb) r(id uuid,at timestamptz,department uuid,prompt text)`,
      [JSON.stringify(facts), f.user, f.installation, f.session, generation]);
    });
  }
  // Deliberately use a different insertion order from the loader's timestamp /
  // UUID order. Stored facts have valid foreign keys and exact timestamp µs.
  await put([
    { id: high, at: at(123456), department: a, prompt: 'IDENTITY_HIGH_A_ONLY' },
    { id: middle, at: at(123457), department: a, prompt: 'IDENTITY_NEXT_MICRO_A_ONLY' },
    { id: low, at: at(123456), department: null, prompt: 'IDENTITY_LOW_NULL_ONLY' },
    { id: middle, at: at(123456), department: b, prompt: 'IDENTITY_MIDDLE_B_ONLY' },
  ]);
  let time = f.at.getTime();
  const options = { providerAccount: 'stop-test', stopWindowEnabled: false, clock: () => new Date(time) };
  const publisher = createSessionListSnapshotPublisher(f.db, options);
  const snapshots = createSessionListSnapshotReader(f.db, options);
  const current = createSessionReadService(f.db, f.identity, { ...options, snapshots });
  const legacy = createSessionReadService(f.db, f.identity, options);
  assert.equal(await publisher.runOne(true), true);
  const initial = await current.listAll(f.login.token, {});
  assert.equal(initial.items[0]!.prompt_turns, 5);
  assert.equal(initial.items[0]!.title, 'Stop用量测试', 'global title remains the first original prompt');

  const cases = [
    { search: 'IDENTITY_HIGH_A_ONLY', department: a },
    { search: 'IDENTITY_MIDDLE_B_ONLY', department: b },
    { search: 'IDENTITY_NEXT_MICRO_A_ONLY', department: a },
    { search: 'IDENTITY_LOW_NULL_ONLY', department: null },
  ];
  for (const item of cases) {
    for (const department_id of [undefined, a, b]) {
      const input: AllSessionQuery = { search: item.search, limit: 100, ...(department_id ? { department_id } : {}) };
      for (const user_id of [undefined, f.user]) {
        const query = { ...input, ...(user_id ? { user_id } : {}) };
        const actual = await current.listAll(f.login.token, query);
        assert.deepEqual(comparable(actual), comparable(await legacy.listAll(f.login.token, query)),
          `full identity and department must match the live reader: ${item.search}`);
        assert.equal(actual.total, department_id === undefined || department_id === item.department ? 1 : 0);
      }
    }
    assert.deepEqual(comparable(await current.listMine(f.login.token, { search: item.search })),
      comparable(await legacy.listMine(f.login.token, { search: item.search })));
  }
  const scoped = await current.listAll(f.login.token, { search: 'IDENTITY_HIGH_A_ONLY', department_id: a });
  assert.equal(scoped.items[0]!.first_at, at(123456));
  assert.equal(scoped.items[0]!.last_at, at(123457));
  assert.equal(scoped.items[0]!.title, 'IDENTITY_HIGH_A_ONLY');

  await put([
    { id: middle, at: at(123458), department: b, prompt: 'IDENTITY_LATE_SAME_UUID_ONLY' },
    { id: gap, at: at(123456), department: a, prompt: 'IDENTITY_LATE_SAME_MICRO_ONLY' },
  ]);
  const late = [
    { search: 'IDENTITY_LATE_SAME_UUID_ONLY', department: b },
    { search: 'IDENTITY_LATE_SAME_MICRO_ONLY', department: a },
  ];
  for (const item of late) {
    assert.equal((await current.listMine(f.login.token, { search: item.search })).total, 0);
    for (const department_id of [undefined, a, b]) {
      const page = await current.listAll(f.login.token, { search: item.search, ...(department_id ? { department_id } : {}) });
      assert.equal(page.total, 0, 'neither a timestamp match nor a UUID match alone may borrow an uncaptured prompt');
      assert.equal(page.snapshot!.id, initial.snapshot!.id);
    }
    assert.equal((await legacy.listAll(f.login.token, { search: item.search })).total, 1, 'the new complete fact really exists in storage');
  }
  time += 1000;
  assert.equal(await publisher.runOne(true), true);
  await snapshots.warm();
  for (const item of late) {
    for (const department_id of [undefined, a, b]) {
      const query = { search: item.search, ...(department_id ? { department_id } : {}) };
      const page = await current.listAll(f.login.token, query);
      assert.deepEqual(comparable(page), comparable(await legacy.listAll(f.login.token, query)));
      assert.equal(page.total, department_id === undefined || department_id === item.department ? 1 : 0);
      assert.notEqual(page.snapshot!.id, initial.snapshot!.id);
    }
  }
  await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [f.user]);
  await assert.rejects(current.listAll(f.login.token, { search: 'IDENTITY_HIGH_A_ONLY' }), { code: 'content_changed' });
  await assert.rejects(current.listMine(f.login.token, { search: 'IDENTITY_LOW_NULL_ONLY' }), { code: 'content_changed' });
  t.diagnostic('Real loader and body searches preserve full UUID/microsecond identity in both routes; null department is a real global hit, missing identity is excluded, later facts require a complete new snapshot, and cleanup still blocks warm hits.');
});
