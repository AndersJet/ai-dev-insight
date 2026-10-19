import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { stopUsageFixture } from '../helpers/stop-usage.js';
import { readSessionQuery } from '../../src/session-usage-query.js';

async function published(t: TestContext) {
  const fixture = await stopUsageFixture(t);
  assert.equal((await fixture.run()).status, 'succeeded');
  const { rows } = await fixture.db.query<{ result: { bills: { items: Record<string, unknown>[] }[] } }>(
    'SELECT result FROM session_usage_queries WHERE session_id=$1', [fixture.session],
  );
  const item = rows[0]!.result.bills[0]!.items[0]!;
  return { ...fixture, item };
}

async function replaceItems(f: Awaited<ReturnType<typeof published>>, items: Record<string, unknown>[]) {
  await f.db.query("UPDATE session_usage_queries SET result=jsonb_set(result,'{bills,0,items}',$2::jsonb) WHERE session_id=$1", [f.session, JSON.stringify(items)]);
  return readSessionQuery(f.db, 'stop-test', f.session, f.user, { userId: f.user, super: true });
}

test('Stop detail aggregation preserves exact integers, decimal scale and independently missing quantities', async t => {
  const f = await published(t);
  const maximum = '999999999999999999999999999999';
  const result = await replaceItems(f, [
    { ...f.item, amount: '99999999999999999999.123456789012345678', model_call_count: '9007199254740993',
      usage: { total_tokens: maximum, prompt_tokens: '9007199254740993', completion_tokens: '0', cache_read_input_tokens: '0', cache_creation_input_tokens: null }, quality: [] },
    { ...f.item, amount: '-99999999999999999999.123456789012345677', model_call_count: null,
      usage: { total_tokens: maximum, prompt_tokens: null, completion_tokens: '1', cache_read_input_tokens: null, cache_creation_input_tokens: '5' }, quality: ['tokens_incomplete'] },
  ]);
  assert.equal(result?.state, 'ready');
  assert.equal(result?.groups.length, 1);
  const group = result!.groups[0]!;
  assert.equal(group.tokens, '1999999999999999999999999999998');
  assert.equal(group.calls, null);
  assert.equal(group.known_calls, '9007199254740993');
  assert.equal(group.missing_call_records, 1);
  assert.equal(group.amount, '0.000000000000000001');
  assert.equal(group.known_amount, group.amount);
  assert.equal(group.records, 2);
  assert.equal(group.quality_records, 1);
  assert.deepEqual(group.token_breakdown, {
    input: { tokens: null, known_tokens: '9007199254740993', missing_token_records: 1 },
    output: { tokens: '1', known_tokens: '1', missing_token_records: 0 },
    cache_read: { tokens: null, known_tokens: '0', missing_token_records: 1 },
    cache_creation: { tokens: null, known_tokens: '5', missing_token_records: 1 },
  });
});

test('Stop detail preserves missing amount reasons, zero formatting, currency null ordering and dimension normalization', async t => {
  const f = await published(t);
  const result = await replaceItems(f, [
    ...(['missing', 'null', 'not_priced', null] as const).map(amount_reason => ({ ...f.item, amount: null, amount_reason })),
    { ...f.item, amount: '0.000000', currency: 'USD' },
    { ...f.item, amount: '0.00', currency: '' },
    { ...f.item, amount: null, amount_reason: 'missing', currency: null },
    { ...f.item, model_name: '', client: null, model_source: null, consumption_source: null, amount: null, amount_reason: 'null' },
  ]);
  assert.deepEqual(result?.groups.map(g => [g.model_name, g.currency]), [
    ['MiniMax-M3', 'CNY'], ['MiniMax-M3', 'USD'], ['MiniMax-M3', null], [null, 'CNY'],
  ]);
  assert.deepEqual(result!.groups[0]!.amount_missing_reasons, [
    { reason: 'missing', records: 1 }, { reason: 'null', records: 1 },
    { reason: 'not_priced', records: 1 }, { reason: 'unknown', records: 1 },
  ]);
  assert.equal(result!.groups[0]!.known_amount, null);
  assert.equal(result!.groups[1]!.amount, '0.000000');
  assert.equal(result!.groups[2]!.known_amount, null);
  assert.equal(result!.groups[2]!.unknown_amount_records, 2);
  assert.deepEqual(result!.groups[2]!.amount_missing_reasons, [{ reason: 'missing', records: 1 }, { reason: 'currency_missing', records: 1 }]);
  assert.equal(result!.groups[3]!.client, 'unspecified');
  assert.equal(result!.groups[3]!.model_source, 'unknown');
  assert.equal(result!.groups[3]!.consumption_source, 'unknown');
});

test('Stop detail accepts 200 groups, rejects 201, and retains empty-result semantics', async t => {
  const f = await published(t);
  const items = Array.from({ length: 201 }, (_, i) => ({ ...f.item, model_name: `model-${String(i).padStart(3, '0')}` }));
  assert.equal((await replaceItems(f, items.slice(0, 200)))?.groups.length, 200);
  await assert.rejects(replaceItems(f, items), { code: 'metric_overflow', status: 503 });
  const result = await replaceItems(f, []);
  assert.deepEqual(result?.groups, []);
  assert.equal(result?.state, 'ready');
});
