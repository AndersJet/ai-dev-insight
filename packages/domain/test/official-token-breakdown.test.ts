import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officialUsageCounters } from '../src/official-token-breakdown.js';
import type { OfficialUsageCountersDto } from '@adi/contracts';
const quantity = (tokens: string | null, known = tokens ?? '0', missing = 0) => ({ tokens, known_tokens: known, missing_token_records: missing });
const group = (input: string): OfficialUsageCountersDto => ({ records: 1, ...quantity(input), calls: '2', known_calls: '2', missing_call_records: 0,
  token_breakdown: { input: quantity(input), output: quantity('0'), cache_read: quantity('0'), cache_creation: quantity('0') } });
test('published quantities sum without precision loss and cache is never added to total', () => {
  const a = group('9007199254740993'), b = group('7');
  a.token_breakdown.cache_read = quantity('9007199254740990');
  const result = officialUsageCounters([a, b]);
  assert.equal(result.tokens, '9007199254741000');assert.equal(result.token_breakdown.input.tokens, result.tokens);
  assert.equal(result.token_breakdown.cache_read.tokens, '9007199254740990');assert.equal(result.calls, '4');
});
test('missing cache keeps known parts while complete output and true zero remain available', () => {
  const a = group('100'), b = group('50');b.token_breakdown.cache_read = quantity(null, '0', 1);a.token_breakdown.cache_read = quantity('60');
  const result = officialUsageCounters([a, b]);
  assert.deepEqual(result.token_breakdown.cache_read, quantity(null, '60', 1));
  assert.equal(result.token_breakdown.output.tokens, '0');assert.equal(result.tokens, '150');
  assert.equal(officialUsageCounters([]).tokens, null);assert.equal(officialUsageCounters([]).calls, null);
});
test('legacy groups preserve totals but missing breakdown is unknown rather than zero', () => {
  const full=group('100');const legacy={records:full.records,tokens:full.tokens,known_tokens:full.known_tokens,missing_token_records:full.missing_token_records,calls:full.calls,known_calls:full.known_calls,missing_call_records:full.missing_call_records};
  const result = officialUsageCounters([legacy]);assert.equal(result.tokens, '100');
  assert.deepEqual(result.token_breakdown.input, quantity(null, '0', 1));
});
