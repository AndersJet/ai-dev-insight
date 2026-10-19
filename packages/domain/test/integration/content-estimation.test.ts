import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createAnalyticsService } from '../../src/analytics.js';
import { createSessionDerivationService } from '../../src/session-derivation.js';
import { createSessionReadService } from '../../src/session-reading.js';

test('content estimates follow the selected input/output event across dates and departments without counting a tool input twice', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const clock = () => new Date('2026-09-24T12:00:00Z');
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock });
  const seed = await identity.bootstrap({ email: 'estimate-root@example.invalid', name: '估算超管' });
  const initial = await identity.login('estimate-root@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(initial.token, seed.temporaryPassword, 'estimation-root-password');
  const owner = randomUUID(); const installation = randomUUID(); const a = randomUUID(); const b = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [owner, 'estimation-owner@example.invalid', '估算同事']);
  await db.query('INSERT INTO departments(id,name) VALUES($1,$2),($3,$4)', [a, '估算A', b, '估算B']);
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4),($1,$5,$4,NULL)', [owner, a, '2026-09-01Z', '2026-09-21T16:00:00Z', b]);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, owner, '7'.repeat(64), '估算合成安装']);
  const facts = [
    ['2026-09-21T15:59:57Z', 'UserPromptSubmit', { prompt: 'hello' }],
    ['2026-09-21T15:59:58Z', 'PreToolUse', { tool_use_id: 'pre-input', tool_name: 'Read', tool_input: 'alpha' }],
    ['2026-09-21T15:59:59Z', 'PreToolUse', { tool_use_id: 'post-input', tool_name: 'Read', tool_input: 'alpha beta' }],
    ['2026-09-21T16:00:01Z', 'PostToolUse', { tool_use_id: 'pre-input', tool_name: 'Read', tool_response: 'two words' }],
    ['2026-09-21T16:00:02Z', 'PostToolUse', { tool_use_id: 'post-input', tool_name: 'Read', tool_input: 'override', tool_response: 'x' }],
    ['2026-09-21T16:00:03Z', 'Stop', { last_assistant_message: 'good' }],
  ] as const;
  let sid = ''; const eventIds: string[] = [];
  for (const [i, [occurred_at, event_type, payload]] of facts.entries()) {
    const result = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: `estimate-${i}`, occurred_at, event_type, source_session_id: 'estimate-session', payload }, { admissionEpoch: 1, receivedAt: clock() });
    if (result.outcome !== 'committed') throw new Error('fixture failed'); sid = result.sessionId; eventIds.push(result.eventId);
  }
  const analytics = createAnalyticsService(db, identity, { clock }); const period = { from: '2026-09-20T16:00:00Z', to: '2026-09-22T16:00:00Z' };
  const pending = await analytics.contentEstimate(root.token, period); assert.equal(pending.estimate.tokens, null); assert.equal(pending.estimate.reason, 'projection_pending');
  const worker = createSessionDerivationService(db); while (await worker.runOne()) { /* Publish fixture. */ }
  const total = await analytics.contentEstimate(root.token, period); const first = await analytics.contentEstimate(root.token, { ...period, department_id: a }); const second = await analytics.contentEstimate(root.token, { ...period, department_id: b });
  assert.equal(total.estimate.tokens, '13'); assert.deepEqual(total.estimate.components, { prompt: '2', tool_input: '4', tool_output: '5', assistant: '2' });
  assert.equal(first.estimate.tokens, '4'); assert.equal(second.estimate.tokens, '9');
  assert.equal((await analytics.contentEstimate(root.token, { from: period.from, to: '2026-09-21T16:00:00Z' })).estimate.tokens, '4');
  assert.equal((await analytics.contentEstimate(root.token, { from: '2026-09-21T16:00:00Z', to: period.to })).estimate.tokens, '9');
  assert.ok(!JSON.stringify(total).includes('alpha')); assert.equal(total.estimate.source, 'trae_personal_hooks'); assert.equal(total.estimate.metric_version, 'content-heuristic-v1');
  const own = await analytics.contentEstimate(root.token, { ...period, scope: 'self' }); assert.equal(own.estimate.tokens, '0'); assert.equal(own.estimate.reason, 'no_observations');
  const reader = createSessionReadService(db, identity, { clock });
  const tool = (await reader.fragments(root.token, sid)).items.find(event => event.event_id === eventIds[2]);
  assert.equal(tool?.input_ref?.event_id, eventIds[4]);
  assert.equal((await reader.content(root.token, sid, tool!.input_ref!.event_id, { part: 'tool_input' })).text, '"override"');
  const detail = await reader.detail(root.token, sid); assert.equal(detail.content_estimate.tokens,null);
  // A source outside the selected department can revise the chosen input inside
  // it; any queued session revision must therefore invalidate the old estimate.
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'revise-input', occurred_at: '2026-09-21T16:00:04Z', event_type: 'PostToolUse', source_session_id: 'estimate-session', payload: { tool_use_id: 'pre-input', tool_name: 'Read', tool_input: 'new input', tool_response: 'two words' } }, { admissionEpoch: 1, receivedAt: clock() });
  assert.equal((await analytics.contentEstimate(root.token, { ...period, department_id: a })).estimate.tokens, null);
  while (await worker.runOne()) { /* Publish corrected source attribution. */ }
  assert.equal((await analytics.contentEstimate(root.token, { ...period, department_id: a })).estimate.tokens, '2');
});

test('heuristic decimal weights are rounded once without floating point adding a token at an integer boundary', async t => {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const clock = () => new Date('2026-09-24T12:00:00Z');
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock });
  const seed = await identity.bootstrap({ email: 'rounding@example.invalid', name: '精确权重夹具' });
  const temporary = await identity.login('rounding@example.invalid', seed.temporaryPassword); const actor = await identity.changePassword(temporary.token, seed.temporaryPassword, 'rounding-test-password');
  const installation = randomUUID(); await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, seed.userId, '6'.repeat(64), '合成安装']);
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'decimal-boundary', occurred_at: '2026-09-22T12:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'decimal-boundary', payload: { prompt: '中文 a b c d e f g h i' } }, { admissionEpoch: 1, receivedAt: clock() });
  const worker = createSessionDerivationService(db); while (await worker.runOne()) { /* 2 Chinese characters and 9 words: 1.30 + 11.70 = exactly 13. */ }
  const result = await createAnalyticsService(db, identity, { clock }).contentEstimate(actor.token, { scope: 'self' });
  assert.equal(result.estimate.tokens, '13'); assert.equal(result.estimate.components.prompt, '13');
});
