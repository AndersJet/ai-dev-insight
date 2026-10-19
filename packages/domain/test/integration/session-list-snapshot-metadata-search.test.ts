import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { createSessionReadService } from '../../src/session-reading.js';
import { createSessionListSnapshotPublisher } from '../../src/session-list-snapshot-publisher.js';
import { createSessionListSnapshotReader } from '../../src/session-list-snapshot-reading.js';

test('ASCII searches on Unicode snapshot metadata preserve PostgreSQL ILIKE semantics', async t => {
  const f = await stopUsageFixture(t);
  const source = 'snapshot-İA-unique';
  const search = 'snapshot-ia-';
  const saved = await f.db.ingest({
    schema_version: 2,
    installation_id: f.installation,
    client_event_id: randomUUID(),
    source_session_id: source,
    event_type: 'UserPromptSubmit',
    occurred_at: f.at.toISOString(),
    payload: { prompt: 'Prompt deliberately omits the metadata search phrase' },
  }, { admissionEpoch: 1, receivedAt: f.at });
  assert.equal(saved.outcome, 'committed');
  if (saved.outcome !== 'committed') throw new Error('Synthetic metadata search event did not commit');

  // The source is allowed to contain Unicode even when the needle is ASCII.
  // JavaScript lowercase expands U+0130 to i + combining dot; the database
  // default en_US.utf8 lowercase maps it to i. Needle-only routing is unsafe.
  const native = (await f.db.query<{ matches: boolean; lowered: string }>(
    'SELECT $1::text ILIKE $2::text AS matches,lower($1::text) AS lowered',
    [source, '%' + search + '%'],
  )).rows[0]!;
  const options = { providerAccount: 'stop-test', stopWindowEnabled: false, clock: () => f.at };
  const publisher = createSessionListSnapshotPublisher(f.db, options);
  const snapshots = createSessionListSnapshotReader(f.db, options);
  const current = createSessionReadService(f.db, f.identity, { ...options, snapshots });
  const legacy = createSessionReadService(f.db, f.identity, options);
  assert.equal(await publisher.runOne(true), true);

  for (const all of [false, true]) {
    const query = { search, limit: 100 };
    const expected = await (all ? legacy.listAll(f.login.token, query) : legacy.listMine(f.login.token, query));
    const actual = await (all ? current.listAll(f.login.token, query) : current.listMine(f.login.token, query));
    assert.equal(expected.items.some(item => item.id === saved.sessionId), native.matches);
    assert.deepEqual(actual.items, expected.items, 'snapshot metadata must retain native ILIKE results for every needle');
    assert.equal(actual.total, expected.total);
  }
  t.diagnostic(`Native metadata lower=${JSON.stringify(native.lowered)}, ILIKE=${native.matches}; JavaScript includes=${source.toLowerCase().includes(search)}.`);
});
