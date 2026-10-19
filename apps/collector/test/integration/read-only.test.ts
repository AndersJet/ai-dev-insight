import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {openDatabase} from '../../../../packages/storage/src/index.js';
import {testDatabase,connectionString} from '../../../../packages/storage/test/helpers.js';
import {startDatabaseConsumer} from '../../src/database-consumer.js';
import {createCollector} from '../../src/http.js';
import {until} from '../helpers.js';

test('a read-only PostgreSQL session is not ready for capture and a fresh writable session restores intake',{timeout:30000},async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date();await db.ensurePartitions(new Date(now.getTime()-86400000),new Date(now.getTime()+86400000));
 const role='test_readonly_'+randomUUID().replaceAll('-','');
 const handles:{consumer?:ReturnType<typeof startDatabaseConsumer>;intake?:ReturnType<typeof createCollector>}={};
 t.after(async()=>{
  try{handles.intake?.server.closeAllConnections();handles.intake?.server.close();await handles.consumer?.close();}
  finally{
   // Use a fresh guarded admin connection: testDatabase may already have closed
   // its pool and removed the synthetic schema before this cleanup hook runs.
   const admin=openDatabase({connectionString,schema:db.schema,maxConnections:1});
   try{if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount){await admin.query(`DROP OWNED BY "${role}"`);await admin.query(`DROP ROLE "${role}"`);}}
   finally{await admin.close();}
  }
 });
 const user=randomUUID(),installation=randomUUID(),token='synthetic-readonly-hook';
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'readonly@example.invalid','只读故障夹具')",[user]);
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成设备')",[installation,user,createHash('sha256').update(token).digest('hex')]);
 await db.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-readonly-local-only'`);
 await db.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO "${role}"`);
 await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${db.schema}" TO "${role}"`);
 await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${db.schema}" TO "${role}"`);
 await db.query(`ALTER ROLE "${role}" SET default_transaction_read_only=on`);
 const url=new URL(connectionString);url.username=role;url.password='synthetic-readonly-local-only';
 const probe=openDatabase({connectionString:url.href,schema:db.schema,maxConnections:1});
 try{
  assert.equal((await probe.query('SHOW transaction_read_only')).rows[0]!.transaction_read_only,'on');
  await assert.rejects(probe.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'forbidden-write@example.invalid','不可写入')",[randomUUID()]),{code:'25006'});
 }finally{await probe.close();}
 const current=startDatabaseConsumer({connectionString:url.href,schema:db.schema});handles.consumer=current;
 const intake=createCollector(current.queue,current.policy);handles.intake=intake;const server=intake.server;server.listen(0,'127.0.0.1');await once(server,'listening');
 await until(()=>current.policy()!==null&&current.queue.isReady(),5000);
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 assert.equal((await fetch(base+'/readyz')).status,503,'known read-only storage must not advertise capture readiness');
 const post=async(id:string)=>{const start=performance.now();const response=await fetch(base+'/hooks',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:now.toISOString(),event_type:'UserPromptSubmit',source_session_id:'readonly-session',payload:{prompt:'synthetic'}})});assert.equal(response.status,200);assert.equal(await response.text(),'');assert.ok(performance.now()-start<700,'Hook response must remain bounded by the existing local fault-regression budget');};
 await post('while-readonly');assert.equal(intake.snapshot().filtered,1);assert.equal(current.queue.snapshot().admitted,0);assert.equal(current.queue.snapshot().deliveryUnknown,0);assert.equal(current.queue.snapshot().restarts,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,0);
 await db.query(`ALTER ROLE "${role}" SET default_transaction_read_only=off`);
 const before=current.child.pid;current.child.kill('SIGTERM');
 await until(()=>current.child.pid!==before&&current.queue.isReady()&&current.policy()?.writable===true,6000);
 assert.equal((await fetch(base+'/readyz')).status,200);await post('after-readonly');await until(()=>current.queue.snapshot().persisted===1,5000);
 assert.deepEqual((await db.query('SELECT client_event_id FROM event_keys')).rows.map(row=>row.client_event_id),['after-readonly']);
 const recoveredPid=current.child.pid,restarts=current.queue.snapshot().restarts,expiry=current.policy()!.expiresAt;
 await until(()=>(current.policy()?.expiresAt??0)>expiry,5000);
 assert.equal(current.child.pid,recoveredPid);assert.equal(current.queue.snapshot().restarts,restarts);assert.equal(current.queue.snapshot().deliveryUnknown,0);
});
