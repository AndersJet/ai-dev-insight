import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createUsageAttributionService } from '../../src/usage-attribution.js';
import { createTraeUsageProvider, type ProviderUsageItem, type ProviderUsagePage } from '../../src/usage-provider.js';

const clock = () => new Date('2026-09-24T12:00:00Z');
function item(id: string, owner = 'external-person'): ProviderUsageItem {
  return { billing_session_id: id, provider_user_id: owner, email: 'attribution@example.invalid',
    start_time: '1790233200', client: 'ide', scene: 'Chat', model_name: 'synthetic-model', model_type: 'Chat', model_source: 'Trae', consumption_source: 'basic',
    model_call_count: '1', departments: [], usage: { total_tokens: '100', prompt_tokens: '80', completion_tokens: '20', cache_creation_input_tokens: '0', cache_read_input_tokens: '0' },
    amount: '0', amount_reason: null, currency: 'CNY', quality: [], token_basis: 'provider_reported' };
}
function response(hook: string, items: ProviderUsageItem[]): ProviderUsagePage {
  return { items, pagination: null, request_id: 'synthetic-request', observed_at: clock().toISOString(), response_hash: 'a'.repeat(64), query: { endpoint: 'session_usage_detail', parameters: { session_ids: [hook] } } };
}
test('explicit single-Hook evidence retains multiple billing IDs and empty probes never imply personal models or zero usage', async t => {
  const db = await testDatabase(t); await db.migrate();
  const user = randomUUID(); const session = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'attribution@example.invalid','归因夹具')", [user]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-a','2026-09-23Z','2026-09-24Z')", [session,user]);
  await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('attribution-test',$1,'external-person','attribution@example.invalid')", [user]);
  let rows = [item('billing-a'), item('billing-b')];
  const service = createUsageAttributionService(db, { providerAccount: 'attribution-test', clock, provider: { getSessionUsage: async hook => response(hook, rows) } });
  await service.probe(session);
  let evidence = await service.read(session);
  assert.equal(evidence.probe_state, 'observed'); assert.deepEqual(evidence.links.map(row => row.billing_session_id), ['billing-a','billing-b']);
  assert.ok(evidence.links.every(row => row.state === 'linked' && row.evidence === 'single_hook_query'));
  assert.ok(!JSON.stringify(evidence).includes('total_tokens')); assert.ok(!JSON.stringify(evidence).includes('model_name'));
  rows = []; await service.probe(session); evidence = await service.read(session);
  assert.equal(evidence.probe_state, 'empty'); assert.equal(evidence.links.length, 2);
  rows = [item('billing-c')]; await service.probe(session); assert.equal((await service.read(session)).links.length, 3);
  rows = [item('billing-a')]; await service.probe(session); assert.equal((await service.read(session)).links.length, 3);
  rows = [item('wrong-person', 'someone-else')];
  await assert.rejects(service.probe(session), { code: 'usage_evidence_owner_mismatch' });
  assert.deepEqual((await service.read(session)).links.map(row => row.billing_session_id), ['billing-a','billing-b','billing-c']);
  const otherSession = randomUUID();
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-b','2026-09-23Z','2026-09-24Z')", [otherSession,user]);
  rows = [item('billing-a')]; await service.probe(otherSession);
  assert.equal((await service.read(session)).links[0]?.state, 'conflict');
  assert.equal((await service.read(otherSession)).links[0]?.state, 'conflict');
  await db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [user]);
  assert.equal((await service.read(session)).links.length, 0);
  assert.equal((await service.read(otherSession)).links.length, 0);
  const refreshedAt='2026-09-24T13:00:00.000Z';
  const refreshed=createUsageAttributionService(db,{providerAccount:'attribution-test',clock:()=>new Date(refreshedAt),provider:{getSessionUsage:async hook=>({...response(hook,[item('billing-a')]),observed_at:refreshedAt})}});
  await refreshed.probe(session);const renewed=(await refreshed.read(session)).links;
  assert.equal(renewed.length,1);assert.equal(renewed[0]?.first_seen_at,refreshedAt,'new evidence after cleanup must not revive its previously cleared observation timestamp');assert.equal(renewed[0]?.state,'linked');
});

test('in-flight probes hold no user lock and an older response cannot publish after replacement or cleanup', async t => {
  const db = await testDatabase(t); await db.migrate(); const user = randomUUID(); const session = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'attribution@example.invalid','归因并发夹具')", [user]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-race','2026-09-23Z','2026-09-24Z')", [session,user]);
  await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('attribution-race',$1,'external-person','attribution@example.invalid')", [user]);
  let release!: (value: ProviderUsagePage) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<ProviderUsagePage>(resolve => { release = resolve; });
  const slow = createUsageAttributionService(db, { providerAccount: 'attribution-race', clock, provider: { getSessionUsage: async () => { entered(); return held; } } });
  const old = slow.probe(session); const rejected = assert.rejects(old, { code: 'stale_usage_evidence' }); await started;
  // This write uses the same lock needed by collection/administration. It must
  // complete while the source call is still deliberately held.
  await db.transaction(client => client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]));
  const fast = createUsageAttributionService(db, { providerAccount: 'attribution-race', clock, provider: { getSessionUsage: async hook => response(hook, [item('new-billing')]) } });
  await fast.probe(session); release(response('hook-race', [item('old-billing')])); await rejected;
  assert.deepEqual((await fast.read(session)).links.map(row => row.billing_session_id), ['new-billing']);
  const cleaning = createUsageAttributionService(db, { providerAccount: 'attribution-race', clock, provider: { getSessionUsage: async hook => {
    await db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [user]); return response(hook, [item('cleared-billing')]);
  } } });
  await assert.rejects(cleaning.probe(session), { code: 'usage_owner_changed' }); assert.equal((await fast.read(session)).links.length, 0);
});

test('the real HTTP provider records only same-person Chat association evidence and partial or wrong-scope responses fail closed', async t => {
  const db = await testDatabase(t); await db.migrate(); const user = randomUUID(); const session = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'attribution@example.invalid','归因HTTP夹具')", [user]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'http-hook','2026-09-23Z','2026-09-24Z')", [session,user]);
  await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('attribution-http',$1,'external-person','attribution@example.invalid')", [user]);
  const server = createServer(async (request, reply) => {
    let body = ''; for await (const chunk of request) body += chunk;
    reply.setHeader('Content-Type', 'application/json');
    if (request.url === '/openapi/v1/auth/token') { reply.end(JSON.stringify({ code: 0, data: { access_token: 'synthetic-token', expire: 7200 } })); return; }
    if (request.url !== '/openapi/v1/statistics/session_usage_detail' || JSON.parse(body).session_ids?.[0] !== 'http-hook') { reply.writeHead(400); reply.end('{}'); return; }
    const raw = { session_id: 'http-billing', user_id: 'external-person', email: 'attribution@example.invalid', start_time: 1790233200, client: 'ide', scene: 'Chat', model_name: 'test', model_type: 'Chat', model_source: 'Trae', consumption_source: 'pay_go', model_call_count: 1, usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, total_cost: '0.123456', total_cost_currency: 'CNY' };
    reply.end(JSON.stringify({ code: 0, request_id: 'local-http', data: { items: [raw, { ...raw, session_id: 'cue', scene: 'CUE' }, { ...raw, session_id: 'cli', client: 'cli' }] } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const provider = createTraeUsageProvider({ baseUrl: `http://127.0.0.1:${address.port}`, appId: 'synthetic-app', appSecret: 'synthetic-secret', clock: () => clock().getTime() });
  const service = createUsageAttributionService(db, { providerAccount: 'attribution-http', clock, provider });
  await service.probe(session); assert.deepEqual((await service.read(session)).links.map(row => row.billing_session_id), ['http-billing']);
  const wrong = createUsageAttributionService(db, { providerAccount: 'attribution-http', clock, provider: { getSessionUsage: async () => response('different-hook', [item('wrong-link')]) } });
  await assert.rejects(wrong.probe(session), { code: 'usage_evidence_scope_mismatch' });
  const partial = createUsageAttributionService(db, { providerAccount: 'attribution-http', clock, provider: { getSessionUsage: async hook => ({ ...response(hook, [item('partial-link')]), pagination: { page: 1, page_size: 1, total: 2, total_pages: 2 } }) } });
  await assert.rejects(partial.probe(session), { code: 'usage_evidence_partial' }); assert.deepEqual((await service.read(session)).links.map(row => row.billing_session_id), ['http-billing']);
});
