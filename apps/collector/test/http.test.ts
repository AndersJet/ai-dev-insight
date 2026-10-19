import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCollector, type IntakePolicy } from '../src/http.js';
import { DeliveryQueue } from '../src/delivery.js';
import { startConsumer } from '../src/consumer.js';
import { FakeConsumer, envelope, until } from './helpers.js';

const policy = (): IntakePolicy => ({ expiresAt: Date.now() + 60_000, installations: new Map([['fixture', { tokenHash: createHash('sha256').update('test-only').digest('hex'), enabled: true, admissionEpoch: 1 }]]) });
async function listen(server: ReturnType<typeof createCollector>['server']) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
}
async function post(url: string, value: unknown, authorization = 'Bearer test-only') {
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(value), headers: { authorization } });
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
}
test('invalid identities, shape and policy cannot enter queue; HTTP is empty 200', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); child.emit('message', { kind: 'ready' });
  let current: IntakePolicy | null = policy();
  const intake = createCollector(queue, () => current);
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  const url = await listen(intake.server);
  await post(url, envelope(), 'Bearer wrong'); await post(url, [envelope()]); await post(url, envelope('nested', { data: Array(2049).fill(1) }));
  await post(url, envelope()); assert.equal(queue.snapshot().admitted, 1);
  current = null; await post(url, envelope()); current = { ...policy(), expiresAt: 0 }; await post(url, envelope());
  assert.equal(queue.snapshot().admitted, 1); assert.equal(intake.snapshot().filtered, 3); assert.equal(intake.snapshot().malformed, 1);assert.equal(intake.snapshot().limited_json_budget,1);
  assert.equal(intake.snapshot().readingBytes, 0); assert.equal(intake.snapshot().readers, 0);
  assert.equal(queue.snapshot().persisted, 0);
});

test('legacy Hooks and optional project observations share intake without trusting client-supplied owner fields',async t=>{
  const child=new FakeConsumer(),queue=new DeliveryQueue(child);child.emit('message',{kind:'ready'});
  const intake=createCollector(queue,policy);t.after(()=>{queue.close();intake.server.closeAllConnections();intake.server.close();});
  const url=await listen(intake.server),project={collector_id:'11111111-1111-4111-8111-111111111111',platform:'macos',workspace:'/synthetic/project',unresolved_reason:null,observation:{id:'22222222-2222-4222-8222-222222222222',sequence:'1',observed_at:new Date().toISOString(),state:'no_remote',reason:null,git_root:'/synthetic/project',remotes:[]}};
  await post(url,envelope('legacy'));await post(url,{...envelope('project'),project});assert.equal(queue.snapshot().admitted,2);
  await post(url,{...envelope('spoofed-owner'),project:{...project,user_id:'another-user'}});
  await post(url,{...envelope('invalid-sequence'),project:{...project,observation:{...project.observation,sequence:'0'}}});
  assert.equal(queue.snapshot().admitted,2);assert.equal(intake.snapshot().malformed,2);
});
test('oversized and slow bodies release read budget and complete promptly', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); child.emit('message', { kind: 'ready' });
  const intake = createCollector(queue, policy, { maxBodyBytes: 512, readTimeoutMs: 50 });
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  const url = await listen(intake.server);
  await post(url, envelope('large', { text: 'x'.repeat(1024) }));
  await new Promise<void>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: 'Bearer test-only' } }, res => { assert.equal(res.statusCode, 200); res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.write('{'); // Deliberately never finish body.
  });
  assert.equal(intake.snapshot().limited, 2); assert.equal(intake.snapshot().readingBytes, 0); assert.equal(intake.snapshot().readers, 0);
  assert.equal(intake.snapshot().limited_body_bytes,1);assert.equal(intake.snapshot().limited_read_timeout,1);
});
test('worker event-loop stall does not block subsequent HTTP and simulated commits are distinct', async t => {
  const { queue, child } = startConsumer(new URL('./fixtures/consumer.cjs', import.meta.url));
  let blocked = false;
  child.on('message', message => { if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'blocked') blocked = true; });
  const intake = createCollector(queue, policy);
  t.after(async () => { intake.server.closeAllConnections(); intake.server.close(); const exited = once(child, 'exit'); queue.close(); await exited; });
  await until(() => queue.snapshot().ready);
  const url = await listen(intake.server);
  await post(url, envelope('blocked', { mode: 'block' }));
  await until(() => blocked);
  const start = performance.now(); await post(url, envelope('following'));
  const elapsed = performance.now() - start;
  t.diagnostic(`following HTTP completed in ${elapsed.toFixed(1)}ms during 1500ms worker stall`);
  assert.ok(elapsed < 700, 'HTTP must not wait for 1500ms worker block');
  assert.equal(queue.snapshot().persisted, 0);
  await until(() => queue.snapshot().persisted === 2);
  await post(url, envelope('following')); await until(() => queue.snapshot().duplicate === 1);
});

test('concurrent partial bodies share one bounded byte budget; abort returns credit', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); child.emit('message', { kind: 'ready' });
  const intake = createCollector(queue, policy, { maxReadingBytes: 20, readTimeoutMs: 1000 });
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  const url = await listen(intake.server);
  const first = request(url, { method: 'POST', headers: { authorization: 'Bearer test-only' } });
  first.on('error', () => {}); t.after(() => first.destroy()); first.write('1234567890123456');
  await until(() => intake.snapshot().readingBytes === 16);
  await new Promise<void>((resolve, reject) => {
    const second = request(url, { method: 'POST', headers: { authorization: 'Bearer test-only' } }, res => { assert.equal(res.statusCode, 200); res.resume(); res.on('end', resolve); });
    second.on('error', reject); second.end('12345678');
  });
  assert.equal(intake.snapshot().limited, 1); assert.equal(intake.snapshot().readingBytes, 16);
  assert.equal(intake.snapshot().limited_inflight_bytes,1);
  first.destroy(); await until(() => intake.snapshot().readingBytes === 0 && intake.snapshot().readers === 0);
  assert.equal(intake.snapshot().aborted, 1);
});
test('reader count is bounded and disabled policy is rechecked after upload', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); child.emit('message', { kind: 'ready' });
  let current = policy(); const intake = createCollector(queue, () => current, { maxReaders: 1 });
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  const url = await listen(intake.server); const body = JSON.stringify(envelope());
  let finishUpload: (() => void) | undefined;
  const uploaded = new Promise<void>((resolve, reject) => {
    const first = request(url, { method: 'POST', headers: { authorization: 'Bearer test-only' } }, res => { res.resume(); res.on('end', resolve); });
    first.on('error', reject); first.write(body.slice(0, 20)); finishUpload = () => first.end(body.slice(20));
  });
  await until(() => intake.snapshot().readers === 1);
  await post(url, envelope('second')); assert.equal(intake.snapshot().limited, 1);
  assert.equal(intake.snapshot().limited_readers,1);
  current = { ...current, installations: new Map() }; finishUpload?.(); await uploaded;
  assert.equal(intake.snapshot().filtered, 1); assert.equal(queue.snapshot().admitted, 0);
});
test('worker exit leaves uncertain delivery visible and later requests fail open', async t => {
  const { queue, child } = startConsumer(new URL('./fixtures/consumer.cjs', import.meta.url));
  const intake = createCollector(queue, policy);
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  await until(() => queue.snapshot().ready); const url = await listen(intake.server);
  const exited = once(child, 'exit'); await post(url, envelope('exit', { mode: 'exit' })); await exited;
  await post(url, envelope('after')); assert.equal(queue.snapshot().deliveryUnknown, 1); assert.equal(intake.snapshot().limited, 1);
  assert.equal(intake.snapshot().limited_delivery_capacity,1);
});

test('small exponent-heavy JSON is rejected before admission while quoted exponents and exact integers stay lossless', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); child.emit('message', { kind: 'ready' });
  const intake = createCollector(queue, policy);
  t.after(() => { queue.close(); intake.server.closeAllConnections(); intake.server.close(); });
  const url = await listen(intake.server);
  const source = JSON.stringify(envelope('expansion', { values: 'REPLACE_NUMBERS' })).replace('"REPLACE_NUMBERS"', '[' + Array(50).fill('1e100000').join(',') + ']');
  const rejected = await fetch(url, { method: 'POST', body: source, headers: { authorization: 'Bearer test-only' } });
  assert.equal(rejected.status, 200); assert.equal(await rejected.text(), '');
  assert.equal(queue.snapshot().admitted, 0); assert.equal(intake.snapshot().limited, 1);
  assert.equal(intake.snapshot().limited_json_budget,1);
  const exact = JSON.stringify(envelope('exact', { text: '"1e1000000" is ordinary text', number: 'EXACT_NUMBER' })).replace('"EXACT_NUMBER"', '9007199254740993');
  const accepted = await fetch(url, { method: 'POST', body: exact, headers: { authorization: 'Bearer test-only' } });
  assert.equal(accepted.status, 200); assert.equal(await accepted.text(), ''); assert.equal(queue.snapshot().admitted, 1);
  assert.equal(child.messages[0]?.body, exact);
  assert.equal(intake.snapshot().readingBytes, 0);
});

test('long strings with escaped quotes keep exact bodies while an exponent outside the string is still rejected',async t=>{
 const child=new FakeConsumer(),queue=new DeliveryQueue(child);child.emit('message',{kind:'ready'});const intake=createCollector(queue,policy);t.after(()=>{queue.close();intake.server.closeAllConnections();intake.server.close();});const url=await listen(intake.server);
 for(let slashes=0;slashes<4;slashes++){const text='x'.repeat(262144)+'\\'.repeat(slashes)+'"quoted 1e1000000'+'\\'.repeat(slashes),value=envelope('escaped-'+slashes,{text,n:'OUTSIDE'}),body=JSON.stringify(value);const accepted=await fetch(url,{method:'POST',body,headers:{authorization:'Bearer test-only'}});assert.equal(accepted.status,200);assert.equal(await accepted.text(),'');assert.equal(child.messages.at(-1)?.body,body);const rejected=await fetch(url,{method:'POST',body:body.replace('"OUTSIDE"','1e1000000'),headers:{authorization:'Bearer test-only'}});assert.equal(rejected.status,200);assert.equal(await rejected.text(),'');}
 assert.equal(queue.snapshot().admitted,4);assert.equal(intake.snapshot().limited_json_budget,4);
});

test('readiness checks recent writable policy and worker state without counting health probes as Hooks',async t=>{
 const child=new FakeConsumer(),queue=new DeliveryQueue(child);let current:IntakePolicy|null={...policy(),writable:true};const intake=createCollector(queue,()=>current);t.after(()=>{queue.close();intake.server.closeAllConnections();intake.server.close();});const hook=await listen(intake.server),url=hook.replace('/hooks','/readyz');
 let response=await fetch(url);assert.equal(response.status,503);assert.deepEqual(await response.json(),{ready:false});child.emit('message',{kind:'ready'});response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ready:true});assert.equal(response.headers.get('cache-control'),'no-store');
 current={...policy(),writable:false};assert.equal((await fetch(url)).status,503);await post(hook,envelope('fenced'));assert.equal(queue.snapshot().admitted,0);current={...policy(),writable:true,expiresAt:0};assert.equal((await fetch(url)).status,503);current=null;assert.equal((await fetch(url)).status,503);assert.equal(intake.snapshot().received,1);
});
