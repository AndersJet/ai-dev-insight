import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createAnalyticsService } from '../../src/analytics.js';
import { createSessionReadService } from '../../src/session-reading.js';
import { createUsageSnapshotStore } from '../../src/usage-snapshots.js';
import { createUsageAttributionService } from '../../src/usage-attribution.js';
import type { ProviderUsageItem } from '../../src/usage-provider.js';

const clock = () => new Date('2026-09-24T12:00:00Z');
const period = { from: '2026-09-22T16:00:00Z', to: '2026-09-23T16:00:00Z' };
test('official organization, model and session aggregates preserve missing amount reasons without treating zero as unknown', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date(period.from), new Date(period.to));
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock });
  const seed = await identity.bootstrap({ email: 'amount@example.invalid', name: '金额来源验证' });
  const initial = await identity.login('amount@example.invalid', seed.temporaryPassword);
  const actor = await identity.changePassword(initial.token, seed.temporaryPassword, 'synthetic-amount-password');
  const installation = randomUUID();
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')", [installation, seed.userId, 'd'.repeat(64)]);
  const saved = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'amount-hook', occurred_at: '2026-09-23T01:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'amount-session', payload: { prompt: 'Synthetic amount evidence' } }, { admissionEpoch: 1, receivedAt: clock() });
  assert.equal(saved.outcome, 'committed'); if (saved.outcome !== 'committed') throw new Error('Fixture must persist');
  const make = (id: string, extra: Partial<ProviderUsageItem> = {}): ProviderUsageItem => ({
    billing_session_id: id, provider_user_id: 'amount-provider', email: 'amount@example.invalid', start_time: String(Date.parse('2026-09-23T01:00:00Z') / 1000),
    client: 'ide', scene: 'Chat', model_name: 'Amount Model', model_type: 'Chat', model_source: 'Trae', consumption_source: 'basic', model_call_count: '1', departments: [],
    usage: { prompt_tokens: '100', completion_tokens: '0', total_tokens: '100', cache_creation_input_tokens: '0', cache_read_input_tokens: '0' },
    amount: '0.000000', amount_reason: null, currency: 'CNY', quality: [], token_basis: 'provider_reported', ...extra,
  });
  const rows = [make('zero'), make('missing', { amount: null, amount_reason: 'missing' }), make('null', { amount: null, amount_reason: 'null' }),
    make('unpriced', { amount: null, amount_reason: 'not_priced' }), make('legacy-unknown', { amount: null }),
    make('both-missing', { amount: null, amount_reason: 'missing', currency: null }), make('unitless', { amount: '2.000000', currency: null })];
  const store = createUsageSnapshotStore(db, { providerAccount: 'amount-test', clock });
  const draft = await store.begin(seed.userId, '2026-09-23');
  await store.stage(draft, 0, { items: rows, pagination: { page: 1, page_size: 200, total: rows.length, total_pages: 1 }, request_id: 'synthetic', observed_at: clock().toISOString(), response_hash: 'e'.repeat(64), query: { endpoint: 'user_usage_detail', parameters: draft.parts[0]!.query } });
  await store.publish(draft);
  const attribution = createUsageAttributionService(db, { providerAccount: 'amount-test', clock, provider: { getSessionUsage: async hook => ({ items: rows, pagination: null, request_id: 'synthetic-probe', observed_at: clock().toISOString(), response_hash: 'f'.repeat(64), query: { endpoint: 'session_usage_detail', parameters: { session_ids: [hook] } } }) } });
  await attribution.probe(saved.sessionId);
  const analytics = createAnalyticsService(db, identity, { clock, providerAccount: 'amount-test' });
  const reader = createSessionReadService(db, identity, { clock, providerAccount: 'amount-test' });
  const expected = [
    { currency: 'CNY', reasons: [{ reason: 'missing', records: 1 }, { reason: 'null', records: 1 }, { reason: 'not_priced', records: 1 }, { reason: 'unknown', records: 1 }] },
    { currency: null, reasons: [{ reason: 'missing', records: 1 }, { reason: 'currency_missing', records: 1 }] },
  ];
  const organization = await analytics.officialUsage(actor.token, period);
  assert.deepEqual(organization.groups.map(row => ({ currency: row.currency, reasons: row.amount_missing_reasons })), expected);
  assert.equal(organization.groups.find(row => row.currency === 'CNY')?.known_amount, '0.000000');
  assert.equal(organization.groups.reduce((sum, row) => sum + row.unknown_amount_records, 0), 6);
  const models = await analytics.models(actor.token, { ...period, scope: 'self' });
  assert.deepEqual(models.items[0]!.costs.map(row => ({ currency: row.currency, reasons: row.amount_missing_reasons })), expected);
  const session = await reader.officialUsage(actor.token, saved.sessionId, period);
  assert.deepEqual(session.groups.map(row => ({ currency: row.currency, reasons: row.amount_missing_reasons })), expected);
  assert.equal(session.groups.reduce((sum, row) => sum + BigInt(row.known_tokens), 0n), 700n);
});
