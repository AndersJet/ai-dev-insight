import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTraeUsageProvider } from '../src/usage-provider.js';
async function server(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const instance = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handle(request, response, JSON.parse(Buffer.concat(chunks).toString() || '{}'));
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
const config = { appId: 'synthetic-id', appSecret: 'SYNTHETIC_SECRET' };
const token = (response: ServerResponse, value = 'synthetic-token') => response.end(JSON.stringify({ code: 0, data: { access_token: value, expire: 7200, token_type: 'Bearer' } }));
const item = '{"session_id":"billing-segment","user_id":"provider-person","email":"Person@Example.Invalid","client":"ide","scene":"Chat","start_time":1780012345,"model_name":"model-a","model_source":"Trae","model_type":"Chat","consumption_source":"mixed","model_call_count":3,"usage":{"prompt_tokens":9007199254740993,"completion_tokens":7,"total_tokens":9007199254741000,"cache_read_input_tokens":0},"total_cost":"0.123919","total_cost_currency":"CNY","departments":[{"department_id":"dept-at-use","name":"名称可以变化","full_path":"企业/部门"}]}';

test('the Usage adapter preserves exact quantities and source dimensions through real HTTP without treating billing IDs as IDE IDs', async t => {
  const requests: { url: string; body: Record<string, unknown>; authorization: string | undefined }[] = [];
  const baseUrl = await server(t, (req, res, body) => {
    requests.push({ url: req.url!, body, authorization: req.headers.authorization });
    if (req.url!.endsWith('/auth/token')) { token(res); return; }
    res.end(`{"code":0,"request_id":"synthetic-request","data":{"items":[${item}],"pagination":{"page":1,"page_size":200,"total":1,"total_pages":1}}}`);
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  const page = await provider.getSessionUsage('ide-session'); const row = page.items[0]!;
  assert.equal(row.billing_session_id, 'billing-segment'); assert.equal(row.usage.prompt_tokens, '9007199254740993'); assert.equal(row.usage.total_tokens, '9007199254741000');
  assert.equal(row.usage.cache_read_input_tokens, '0'); assert.equal(row.usage.cache_creation_input_tokens, null);
  assert.equal(row.amount, '0.123919'); assert.equal(row.currency, 'CNY'); assert.equal(row.consumption_source, 'mixed'); assert.equal(row.model_source, 'Trae');
  assert.equal(row.email, 'person@example.invalid'); assert.equal(row.departments?.[0]?.id, 'dept-at-use');
  assert.deepEqual(requests[1]!.body, { session_ids: ['ide-session'] });
  const members = await provider.getMemberUsage({ start_time: 1780000000, end_time: 1780600000, emails: ['person@example.invalid'], page: 1, page_size: 200 });
  assert.equal(members.pagination?.total_pages, 1); assert.equal(requests.filter(request => request.url.endsWith('/auth/token')).length, 1);
  assert.equal(requests[2]?.authorization, 'Bearer synthetic-token'); assert.ok(!JSON.stringify(page).includes(config.appSecret));
});

test('an expired provider token refreshes once and repeated expiry fails without leaking provider messages', async t => {
  let auth = 0; let usage = 0; let permanent = false;
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res, `token-${++auth}`); return; }
    usage++;
    if (req.headers.authorization === 'Bearer token-1' || permanent) res.end(JSON.stringify({ code: 1002, message: 'SYNTHETIC_SECRET must not be logged', data: null }));
    else res.end('{"code":0,"data":{"items":[]}}');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  assert.equal((await provider.getSessionUsage('expired-once')).items.length, 0); assert.equal(auth, 2); assert.equal(usage, 2);
  permanent = true;
  await assert.rejects(provider.getSessionUsage('still-expired'), error => error instanceof Error && 'code' in error && error.code === 'provider_auth_failed' && !error.message.includes('SECRET'));
  assert.equal(auth, 3); assert.equal(usage, 4);
});

test('rate limits expose retry timing without replaying a query or returning provider error text', async t => {
  let calls = 0; let mode = 'http';
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; } calls++;
    if (mode === 'http') { res.writeHead(429, { 'Retry-After': '120' }); res.end('SYNTHETIC_SECRET'); }
    else res.end('{"code":64290,"message":"SYNTHETIC_SECRET"}');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  await assert.rejects(provider.getSessionUsage('limited'), { code: 'provider_rate_limited', retryAfterSeconds: 120 }); assert.equal(calls, 1);
  mode = 'json'; await assert.rejects(provider.getSessionUsage('limited-again'), { code: 'provider_rate_limited', providerCode: 64290 }); assert.equal(calls, 2);
});

test('unknown cost, true zero, absent usage and empty CUE identifiers remain distinct without inferring personal BYOK', async t => {
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; }
    res.end(JSON.stringify({ code: 0, data: { items: [
      { session_id: 'enterprise', model_source: 'Custom', consumption_source: 'enterprise_builtin', client: '', total_cost: '-', usage: { total_tokens: 0 } },
      { session_id: '', scene: 'CUE', consumption_source: 'basic', total_cost: '0.000000', usage: { total_tokens: 0 } },
      { session_id: '', scene: 'CUE', consumption_source: 'basic', total_cost: '0.000000', usage: { total_tokens: 0 } },
      { session_id: 'future', model_source: 'FutureProvider', consumption_source: 'future_source', total_cost: null },
      { session_id: 'missing' },
    ] } }));
  });
  const rows = (await createTraeUsageProvider({ ...config, baseUrl }).getSessionUsage('observed')).items;
  assert.equal(rows.length, 5); assert.equal(rows[0]?.amount, null); assert.equal(rows[0]?.amount_reason, 'not_priced'); assert.equal(rows[0]?.model_source, 'Custom');
  assert.equal(rows[1]?.amount, '0.000000'); assert.equal(rows[1]?.usage.total_tokens, '0'); assert.equal(rows[1]?.billing_session_id, ''); assert.equal(rows[2]?.billing_session_id, '');
  assert.equal(rows[3]?.consumption_source, 'future_source'); assert.equal(rows[3]?.usage.total_tokens, null); assert.equal(rows[3]?.amount_reason, 'null'); assert.equal(rows[4]?.amount_reason, 'missing');
});

test('response limits, invalid payloads and incomplete pagination fail instead of becoming successful empty usage', { timeout: 5000 }, async t => {
  let mode = 'oversized';
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; }
    if (mode === 'oversized') res.end('{"code":0,"padding":"'+'x'.repeat(2000)+'"}');
    else if (mode === 'bad-json') res.end('{ broken JSON');
    else if (mode === 'invalid-utf8') res.end(Buffer.from([0xff, 0xfe]));
    else if (mode === 'negative') res.end('{"code":0,"data":{"items":[{"usage":{"total_tokens":-1}}]}}');
    else if (mode === 'no-pagination') res.end('{"code":0,"data":{"items":[]}}');
    else if (mode === 'inconsistent-pagination') res.end('{"code":0,"data":{"items":[],"pagination":{"page":1,"page_size":200,"total":10,"total_pages":1}}}');
    else if (mode === 'redirect') { res.writeHead(302, { Location: '/never-follow' }); res.end(); }
    // stalled intentionally has no response; the caller's deadline must end it.
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl, maxResponseBytes: 1024, timeoutMs: 100 });
  await assert.rejects(provider.getSessionUsage('too-large'), { code: 'provider_response_limit' });
  for (mode of ['bad-json', 'invalid-utf8', 'negative']) await assert.rejects(provider.getSessionUsage(mode), { code: 'invalid_provider_response' });
  for (mode of ['no-pagination','inconsistent-pagination']) await assert.rejects(provider.getMemberUsage({ start_time: 1780000000, end_time: 1780000000, emails: ['person@example.invalid'] }), { code: 'invalid_provider_response' });
  mode = 'redirect'; await assert.rejects(provider.getSessionUsage('redirect'), { code: 'provider_unavailable' });
  mode = 'stalled'; const start = performance.now(); await assert.rejects(provider.getSessionUsage('stalled'), { code: 'provider_timeout' }); assert.ok(performance.now() - start < 1500);
});

test('concurrent reads share authentication and cached credentials refresh before their expiry', async t => {
  let auth = 0; let clock = Date.now(); const seen: string[] = [];
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { const number = ++auth; setTimeout(() => token(res, `shared-${number}`), 25); return; }
    seen.push(req.headers.authorization ?? ''); res.end('{"code":0,"data":{"items":[]}}');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl, clock: () => clock });
  await Promise.all([provider.getSessionUsage('one'), provider.getSessionUsage('two')]);
  assert.equal(auth, 1); assert.deepEqual(seen, ['Bearer shared-1','Bearer shared-1']);
  clock += 7000 * 1000; await provider.getSessionUsage('later'); assert.equal(auth, 2); assert.equal(seen.at(-1), 'Bearer shared-2');
});

test('inclusive provider second ranges are preserved and unsafe query or endpoint configuration is rejected before HTTP', async t => {
  let calls = 0; let observed: Record<string,unknown> = {};
  const baseUrl = await server(t, (req,res,body) => {
    calls++; if (req.url!.endsWith('/auth/token')) { token(res); return; } observed = body;
    res.end('{"code":0,"data":{"items":[],"pagination":{"page":1,"page_size":200,"total":0,"total_pages":1}}}');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  await provider.getMemberUsage({ start_time: 1780000000, end_time: 1780000000, emails: ['PERSON@example.invalid','person@example.invalid'] });
  assert.deepEqual(observed, { start_time: 1780000000, end_time: 1780000000, emails: ['person@example.invalid'], page: 1, page_size: 200 });
  assert.equal(calls, 2);
  await assert.rejects(provider.getMemberUsage({ start_time: 10, end_time: 9, emails: ['person@example.invalid'] }), { code: 'invalid_provider_query' });
  await assert.rejects(provider.getMemberUsage({ start_time: 1, end_time: 180 * 86400 + 2, emails: ['person@example.invalid'] }), { code: 'invalid_provider_query' });
  await assert.rejects(provider.getMemberUsage({ start_time: 1, end_time: 2, emails: [] }), { code: 'invalid_provider_query' });
  await assert.rejects(provider.getSessionUsage(''), { code: 'invalid_provider_query' }); assert.equal(calls, 2);
  for (const url of ['http://external.example.invalid','https://user:pass@example.invalid','https://example.invalid/?token=x','https://example.invalid/other']) assert.throws(() => createTraeUsageProvider({ ...config, baseUrl: url }), { code: 'invalid_provider_config' });
});

test('permission and invalid-request HTTP failures are distinct from temporary provider outages', async t => {
  let status = 403;
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; }
    res.writeHead(status); res.end('SYNTHETIC_SECRET and private provider message');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  await assert.rejects(provider.getSessionUsage('denied'), { code: 'provider_auth_failed', httpStatus: 403 });
  status = 400; await assert.rejects(provider.getSessionUsage('bad-query'), { code: 'provider_rejected', httpStatus: 400 });
  status = 503; await assert.rejects(provider.getSessionUsage('unavailable'), { code: 'provider_unavailable', httpStatus: 503 });
});

test('inconsistent provider quantities remain reported values with visible quality flags instead of being recomputed', async t => {
  const baseUrl = await server(t, (req,res) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; }
    res.end('{"code":0,"data":{"items":[{"session_id":"quality","model_source":"FutureModelSource","consumption_source":"future_source","total_cost":"1.200000","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":99,"cache_read_input_tokens":11,"cache_creation_input_tokens":0}}]}}');
  });
  const value = (await createTraeUsageProvider({ ...config, baseUrl }).getSessionUsage('quality')).items[0]!;
  assert.equal(value.usage.total_tokens, '99'); assert.equal(value.amount, '1.200000'); assert.equal(value.currency, null);
  for (const flag of ['token_sum_mismatch','cache_exceeds_input','amount_currency_missing','model_source_unknown','consumption_source_unknown']) assert.ok(value.quality.includes(flag), flag);
});

test('member reads can use a verified provider identity after a local email correction', async t => {
  let observed: Record<string,unknown> = {};
  const baseUrl = await server(t, (req,res,body) => {
    if (req.url!.endsWith('/auth/token')) { token(res); return; } observed = body;
    res.end('{"code":0,"data":{"items":[],"pagination":{"page":1,"page_size":200,"total":0,"total_pages":1}}}');
  });
  const provider = createTraeUsageProvider({ ...config, baseUrl });
  await provider.getMemberUsage({ start_time: 1780000000, end_time: 1780000001, user_ids: ['provider-person'] });
  assert.deepEqual(observed, { start_time: 1780000000, end_time: 1780000001, user_ids: ['provider-person'], page: 1, page_size: 200 });
  await assert.rejects(provider.getMemberUsage({ start_time: 1, end_time: 2, emails: Array.from({length: 100}, (_,i) => `person-${i}@example.invalid`), user_ids: ['one-more'] }), { code: 'invalid_provider_query' });
});

test('request gating covers authentication and refresh, and a stalled gate obeys the total call deadline',async t=>{
 let requests=0;let gates=0;
 const baseUrl=await server(t,(req,res)=>{requests++;if(req.url!.endsWith('/auth/token'))token(res);else if(requests===2)res.end('{"code":1002}');else res.end('{"code":0,"data":{"items":[]}}');});
 const provider=createTraeUsageProvider({...config,baseUrl,beforeRequest:async()=>{gates++;}});
 await provider.getSessionUsage('gated');assert.equal(gates,4);assert.equal(requests,4);
 const blocked=createTraeUsageProvider({...config,baseUrl,timeoutMs:50,beforeRequest:()=>new Promise<void>(()=>{})});
 const start=performance.now();await assert.rejects(blocked.getSessionUsage('blocked'),{code:'provider_timeout'});assert.ok(performance.now()-start<1000);assert.equal(requests,4);
});

test('model summaries use their own endpoint and exact Token fields without inventing client or billing dimensions',async t=>{
 const requests:{url:string;body:Record<string,unknown>}[]=[];
 const baseUrl=await server(t,(req,res,body)=>{requests.push({url:req.url!,body});if(req.url!.endsWith('/auth/token')){token(res);return;}
  res.end('{"code":0,"request_id":"summary-test","data":{"items":[{"user_id":"provider-person","email":"Person@Example.Invalid","model_usage":[{"model_name":"MiniMax-M3","model_type":"Chat","model_source":"Trae","usage":{"input_tokens":9007199254740993,"output_tokens":7}},{"model_name":"AI/GLM-5.1|openai","model_type":"Chat","model_source":"Custom","usage":{"input_tokens":0,"output_tokens":0}}]}]}}');});
 const provider=createTraeUsageProvider({...config,baseUrl});const result=await provider.getMemberModelUsage({start_time:1780000000,end_time:1780600000,emails:[' Person@Example.Invalid ']});
 assert.equal(requests[1]?.url,'/openapi/v1/statistics/user-model-usage');assert.deepEqual(requests[1]?.body,{start_time:1780000000,end_time:1780600000,emails:['person@example.invalid']});
 assert.equal(result.query.endpoint,'user-model-usage');assert.equal(result.items[0]?.provider_user_id,'provider-person');assert.equal(result.items[0]?.email,'person@example.invalid');
 assert.equal(result.items[0]?.model_usage[0]?.usage.input_tokens,'9007199254740993');assert.equal(result.items[0]?.model_usage[1]?.usage.input_tokens,'0');
 assert.equal(Object.hasOwn(result.items[0]!.model_usage[0]!,'client'),false);assert.equal(Object.hasOwn(result.items[0]!.model_usage[0]!,'consumption_source'),false);assert.ok(!JSON.stringify(result).includes(config.appSecret));
});

test('a model summary cannot silently accept a partial paginated response or replace missing quantities with zero',async t=>{
 let partial=true;const baseUrl=await server(t,(req,res)=>{if(req.url!.endsWith('/auth/token')){token(res);return;}
  res.end(JSON.stringify({code:0,data:{items:[{user_id:'provider-person',model_usage:[{model_name:'synthetic',model_type:'Chat',model_source:'Trae',usage:{output_tokens:0}}]}],...(partial?{pagination:{page:1,page_size:1,total:2,total_pages:2}}:{})}}));});
 const provider=createTraeUsageProvider({...config,baseUrl}),query={start_time:1780000000,end_time:1780600000,user_ids:['provider-person']};
 await assert.rejects(provider.getMemberModelUsage(query),{code:'invalid_provider_response'});
 partial=false;const row=(await provider.getMemberModelUsage(query)).items[0]!.model_usage[0]!;assert.equal(row.usage.input_tokens,null);assert.equal(row.usage.output_tokens,'0');
});
