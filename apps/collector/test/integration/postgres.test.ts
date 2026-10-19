import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { testDatabase, connectionString } from '../../../../packages/storage/test/helpers.js';
import { postgresFaultProxy } from '../../../../packages/storage/test/fixtures/pg-fault-proxy.js';
import { startDatabaseConsumer } from '../../src/database-consumer.js';
import { createCollector } from '../../src/http.js';
import { until } from '../helpers.js';
import { setTimeout as delay } from 'node:timers/promises';

test('real readiness turns off during recovery and recovers only after a fresh writable policy',async t=>{
 const db=await testDatabase(t);await db.migrate();const consumer=startDatabaseConsumer({connectionString,schema:db.schema}),intake=createCollector(consumer.queue,consumer.policy);t.after(async()=>{intake.server.closeAllConnections();intake.server.close();await consumer.close();});await until(()=>consumer.queue.isReady()&&consumer.policy()?.writable===true,5000);intake.server.listen(0,'127.0.0.1');await once(intake.server,'listening');const base=`http://127.0.0.1:${(intake.server.address() as AddressInfo).port}`;assert.equal((await fetch(base+'/readyz')).status,200);
 await db.query("WITH r AS (INSERT INTO recovery_runs(id,dataset_id,state) SELECT gen_random_uuid(),dataset_id,'quarantined' FROM data_identity RETURNING id) UPDATE data_identity SET recovery_id=(SELECT id FROM r)");await until(()=>consumer.policy()?.writable===false,5000);assert.equal((await fetch(base+'/readyz')).status,503);const hook=await fetch(base+'/hooks',{method:'POST',body:'{}'});assert.equal(hook.status,200);assert.equal(await hook.text(),'');await db.query('UPDATE data_identity SET recovery_id=NULL');await until(()=>consumer.policy()?.writable===true,5000);assert.equal((await fetch(base+'/readyz')).status,200);assert.equal(intake.snapshot().received,1);
});

test('collector runtime reporting uses the real child and does not wait for a blocked telemetry write',{timeout:15000},async t=>{
 const db=await testDatabase(t);await db.migrate();const consumer=startDatabaseConsumer({connectionString,schema:db.schema});t.after(()=>consumer.close());await until(()=>consumer.queue.snapshot().ready,5000);
 const boot=randomUUID();consumer.reportRuntime({component:'collector',boot_id:boot,sequence:1,state:'running',metrics:{intake_received:3}});
 async function observed(sequence:string){for(let i=0;i<200;i++){if((await db.query('SELECT sequence::text AS sequence FROM runtime_heartbeats WHERE boot_id=$1',[boot])).rows[0]?.sequence===sequence)return;await delay(10);}throw new Error('Runtime observation did not arrive');}
 await observed('1');let release!:()=>void;let locked!:(pid:number)=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<number>(resolve=>{locked=resolve;});const holder=db.transaction(async client=>{await client.query('LOCK TABLE runtime_heartbeats IN ACCESS EXCLUSIVE MODE');locked((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number);await gate;});
 try{
  const blocker=await ready;const started=performance.now();consumer.reportRuntime({component:'collector',boot_id:boot,sequence:2,state:'running',metrics:{intake_received:5}});assert.ok(performance.now()-started<100,'the parent must not await database telemetry');
  let waiting=false;for(let i=0;i<100;i++){waiting=Boolean((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blocker])).rowCount);if(waiting)break;await delay(10);}assert.equal(waiting,true,'observe the real child waiting on PostgreSQL');
 }finally{release();await holder;}
 await observed('2');
});

test('lost database responses preserve fast HTTP admission and recover without success ACKs or uncertain replay',{timeout:30000},async t=>{
  const db=await testDatabase(t);await db.migrate();const now=new Date();await db.ensurePartitions(new Date(now.getTime()-86_400_000),new Date(now.getTime()+86_400_000));
  const user=randomUUID(),installation=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'network@example.invalid','网络故障合成用户']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,user,createHash('sha256').update('integration-only').digest('hex'),'合成设备']);
  const proxy=await postgresFaultProxy(connectionString);const consumer=startDatabaseConsumer({connectionString:proxy.connectionString,schema:db.schema});const intake=createCollector(consumer.queue,consumer.policy);
  t.after(async()=>{intake.server.closeAllConnections();intake.server.close();await proxy.close();await consumer.close();});
  await until(()=>consumer.policy()!==null&&consumer.queue.snapshot().ready,5000);const originalPid=consumer.child.pid;
  intake.server.listen(0,'127.0.0.1');await once(intake.server,'listening');const url=`http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
  const post=async(id:string)=>{const started=performance.now();const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer integration-only'},body:JSON.stringify({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:now.toISOString(),event_type:'Stop',source_session_id:'network-http',payload:{}})});assert.equal(response.status,200);assert.equal(await response.text(),'');assert.ok(performance.now()-started<700,'HTTP admission must not wait for database I/O');};
  proxy.setMode('drop-responses');await post('uncertain-first');await until(()=>proxy.snapshot().droppedBytes>0,3000);await post('uncertain-second');assert.equal(consumer.queue.snapshot().persisted,0);
  await until(()=>consumer.queue.snapshot().deliveryUnknown===2,14000);assert.equal(consumer.queue.snapshot().persisted,0);assert.equal((await db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,0);
  proxy.setMode('healthy');await until(()=>consumer.child.pid!==originalPid&&consumer.policy()!==null&&consumer.queue.snapshot().ready,8000);await post('after-recovery');await until(()=>consumer.queue.snapshot().persisted===1,4000);
  assert.deepEqual((await db.query('SELECT client_event_id FROM event_keys')).rows.map(row=>row.client_event_id),['after-recovery']);assert.equal(consumer.queue.snapshot().deliveryUnknown,2);
});

test('real HTTP admission preserves numeric facts through PostgreSQL and distinguishes replay from conflicting identity', async t => {
  const db = await testDatabase(t); await db.migrate();
  const now = new Date(); await db.ensurePartitions(new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'collector@example.invalid', '合成员工']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, createHash('sha256').update('integration-only').digest('hex'), '合成设备']);
  const consumer = startDatabaseConsumer({ connectionString, schema: db.schema });
  const intake = createCollector(consumer.queue, consumer.policy);
  t.after(async () => { intake.server.closeAllConnections(); intake.server.close(); await consumer.close(); });
  await until(() => consumer.policy() !== null && consumer.queue.snapshot().ready, 5000);
  intake.server.listen(0, '127.0.0.1'); await once(intake.server, 'listening');
  const url = `http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
  const body = JSON.stringify({ schema_version: 2, installation_id: installation, client_event_id: 'replayed', occurred_at: now.toISOString(), timestamp_source: 'client_observed', event_type: 'UserPromptSubmit', source_session_id: 'real-http', payload: { prompt: '合成提示', counter: 'RAW_NUMBER' } }).replace('"RAW_NUMBER"', '9007199254740993');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
  }
  await until(() => consumer.queue.snapshot().persisted === 1 && consumer.queue.snapshot().duplicate === 1, 5000);
  assert.equal((await db.query('SELECT count(*) FROM hook_events')).rows[0]?.count, '1');
  assert.equal((await db.query("SELECT payload->>'counter' AS counter FROM hook_events")).rows[0]?.counter, '9007199254740993');
  assert.equal((await db.query('SELECT timestamp_source FROM hook_events')).rows[0]?.timestamp_source, 'client_observed');
  assert.equal((await db.query("SELECT count(*) FROM jobs WHERE kind='derive_session'")).rows[0]?.count, '1');
  const conflict = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body: body.replace('9007199254740993', '9007199254740992') });
  assert.equal(conflict.status, 200); await conflict.text();
  await until(() => consumer.queue.snapshot().dropped === 1);
  assert.equal(consumer.queue.snapshot().duplicate, 1);
  // Valid JSON can contain a NUL escape, which PostgreSQL jsonb cannot store.
  // This is a definite data rejection, not an ambiguous commit or worker crash.
  const nul = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body: body.replace('replayed', 'nul-event').replace('合成提示', '\\u0000') });
  assert.equal(nul.status, 200); await nul.text();
  await until(() => consumer.queue.snapshot().dropped === 2);
  assert.equal(consumer.queue.snapshot().deliveryUnknown, 0);
  assert.equal(consumer.queue.snapshot().restarts, 0);
  const final = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body: body.replace('replayed', 'before-shutdown') });
  assert.equal(final.status, 200); await final.text();
  await consumer.close();
  assert.equal(consumer.queue.snapshot().persisted, 2, 'shutdown drains admitted work before terminating its worker');
});

test('stale intake policy cannot restore a previous account epoch or a revoked installation token', async t => {
  const db = await testDatabase(t); await db.migrate();
  const now = new Date(); await db.ensurePartitions(new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'epoch@example.invalid', '凭据隔离']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, createHash('sha256').update('integration-only').digest('hex'), '合成设备']);
  const consumer = startDatabaseConsumer({ connectionString, schema: db.schema });
  let cached = consumer.policy();
  const intake = createCollector(consumer.queue, () => cached);
  t.after(async () => { intake.server.closeAllConnections(); intake.server.close(); await consumer.close(); });
  await until(() => consumer.policy() !== null && consumer.queue.snapshot().ready, 5000);
  cached = consumer.policy();
  intake.server.listen(0, '127.0.0.1'); await once(intake.server, 'listening');
  const url = `http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
  await db.query('UPDATE users SET ingest_epoch=2 WHERE id=$1', [user]);
  const body = JSON.stringify({ schema_version: 2, installation_id: installation, client_event_id: 'forged-epoch', occurred_at: now.toISOString(), event_type: 'Stop', source_session_id: 'stale-policy', payload: { admissionEpoch: 2, receivedAt: '2020-01-01T00:00:00Z' } });
  const post = async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
  };
  await post(); await until(() => consumer.queue.snapshot().dropped === 1);
  await until(() => consumer.policy()?.installations.get(installation)?.admissionEpoch === 2, 5000);
  cached = consumer.policy();
  await db.query('UPDATE installations SET token_hash=$2 WHERE id=$1', [installation, createHash('sha256').update('rotated-integration-only').digest('hex')]);
  await post(); await until(() => consumer.queue.snapshot().dropped === 2);
  assert.equal((await db.query('SELECT count(*) FROM hook_events')).rows[0]?.count, '0');
  assert.equal(consumer.queue.snapshot().deliveryUnknown, 0);
});

test('known rollback lock failures leave HTTP responsive and reject only exhausted items without restarting the consumer', async t => {
  const db = await testDatabase(t); await db.migrate();
  const now = new Date(); await db.ensurePartitions(new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
  const user = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'locked@example.invalid', '锁等待合成用户']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, createHash('sha256').update('integration-only').digest('hex'), '合成设备']);
  const consumer = startDatabaseConsumer({ connectionString, schema: db.schema });
  const intake = createCollector(consumer.queue, consumer.policy);
  t.after(async () => { intake.server.closeAllConnections(); intake.server.close(); await consumer.close(); });
  await until(() => consumer.policy() !== null && consumer.queue.snapshot().ready, 5000);
  const originalPid = consumer.child.pid;
  intake.server.listen(0, '127.0.0.1'); await once(intake.server, 'listening');
  const url = `http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
  const body = (id: string) => JSON.stringify({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at: now.toISOString(), event_type: 'Stop', source_session_id: 'lock-http', payload: {} });
  let release!: () => void; let signal!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { signal = resolve; });
  const holder = db.transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
    signal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number); await gate;
  });
  t.after(async () => { release(); await holder; });
  const blocker = await locked;
  const post = async (id: string) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body: body(id) });
    assert.equal(response.status, 200); assert.equal(await response.text(), '');
  };
  await post('blocked');
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) {
    blocked = (await db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blocker])).rowCount !== 0;
    if (!blocked) await delay(10);
  }
  assert.equal(blocked, true, 'must observe an actual PostgreSQL lock wait');
  const started = performance.now(); await post('following');
  assert.ok(performance.now() - started < 700, 'HTTP must not await the 1s database lock timeout');
  assert.equal(consumer.queue.snapshot().persisted, 0);
  await until(() => consumer.queue.snapshot().dropped === 2, 6000);
  assert.equal(consumer.child.pid, originalPid);assert.equal(consumer.queue.snapshot().restarts, 0);assert.equal(consumer.queue.snapshot().deliveryUnknown, 0);
  release(); await holder;
  await post('after-recovery'); await until(() => consumer.queue.snapshot().persisted === 1, 4000);
  assert.equal((await db.query('SELECT count(*) FROM hook_events')).rows[0]?.count, '1');
  assert.equal(consumer.queue.snapshot().deliveryUnknown, 0);assert.equal(consumer.queue.snapshot().duplicate, 0);assert.equal(consumer.queue.snapshot().dropped, 2);
});

test('a committed fact whose IPC acknowledgement is lost survives consumer restart and a client retry without duplication', { timeout: 20000 }, async t => {
  const db = await testDatabase(t); await db.migrate(); const now = new Date();
  await db.ensurePartitions(new Date(now.getTime() - 86400000), new Date(now.getTime() + 86400000));
  const user = randomUUID(), installation = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'lost-ack@example.invalid','回执丢失验收')", [user]);
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')", [installation, user, createHash('sha256').update('integration-only').digest('hex')]);
  const consumer = startDatabaseConsumer({ connectionString, schema: db.schema }, { maxAgeMs: 1500 });
  const intake = createCollector(consumer.queue, consumer.policy);
  t.after(async () => { intake.server.closeAllConnections(); intake.server.close(); await consumer.close(); });
  await until(() => consumer.policy() !== null && consumer.queue.isReady(), 5000);
  const original = consumer.child, originalPid = original.pid, emit = original.emit;
  let discardedCommitAcks = 0;
  // Fault at the public IPC boundary: real child, real PostgreSQL COMMIT, only
  // its successful delivery acknowledgement is withheld from the parent.
  original.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0];
    if (event === 'message' && message && typeof message === 'object' && 'kind' in message && message.kind === 'result' && 'outcome' in message && message.outcome === 'committed') {
      discardedCommitAcks++; return true;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  intake.server.listen(0, '127.0.0.1'); await once(intake.server, 'listening');
  const url = `http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
  const body = JSON.stringify({ schema_version: 2, installation_id: installation, client_event_id: 'same-client-event', occurred_at: now.toISOString(), event_type: 'UserPromptSubmit', source_session_id: 'same-session', payload: { prompt: '修复回执丢失' } });
  const post = async () => { const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer integration-only' }, body }); assert.equal(response.status, 200); assert.equal(await response.text(), ''); };
  await post(); await until(() => discardedCommitAcks === 1, 5000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]?.n, 1);
  assert.equal(consumer.queue.snapshot().persisted, 0, 'the parent cannot invent confirmation for a committed fact');
  await until(() => consumer.child.pid !== originalPid && consumer.policy() !== null && consumer.queue.isReady(), 7000);
  assert.equal(consumer.queue.snapshot().deliveryUnknown, 1);
  assert.equal(consumer.queue.snapshot().admitted, 1, 'restart must not silently replay an uncertain request');
  await post(); await until(() => consumer.queue.snapshot().duplicate === 1, 5000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]?.n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM event_keys')).rows[0]?.n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='derive_session'")).rows[0]?.n, 1);
  const { createSessionDerivationService } = await import('../../../../packages/domain/src/session-derivation.js');
  const derivation = createSessionDerivationService(db); assert.equal(await derivation.runOne(), true); assert.equal(await derivation.runOne(), false);
  const result = (await db.query('SELECT d.summary FROM sessions s JOIN session_derivations d ON d.id=s.derived_run_id')).rows;
  assert.equal(result.length, 1); assert.equal(result[0]?.summary.prompt_count, 1);
  assert.equal(consumer.queue.snapshot().deliveryUnknown, 1, 'later deduplication does not erase the original observation gap');
});
