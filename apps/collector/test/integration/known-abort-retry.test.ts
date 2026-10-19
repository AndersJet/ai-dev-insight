import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {testDatabase,connectionString} from '../../../../packages/storage/test/helpers.js';
import {startDatabaseConsumer} from '../../src/database-consumer.js';
import {createCollector} from '../../src/http.js';
import {until} from '../helpers.js';

async function fixture(t:TestContext){
 const db=await testDatabase(t);await db.migrate();const at=new Date();await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(at.getTime()+86400000));
 const user=randomUUID(),installation=randomUUID(),tokenHash=createHash('sha256').update('known-abort-only').digest('hex');
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'known-abort@example.invalid','已回滚重试')",[user]);
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成重试安装')",[installation,user,tokenHash]);
 const consumer=startDatabaseConsumer({connectionString,schema:db.schema}),intake=createCollector(consumer.queue,consumer.policy);
 t.after(async()=>{intake.server.closeAllConnections();intake.server.close();await consumer.close();});
 await until(()=>consumer.policy()?.writable===true&&consumer.queue.isReady(),5000);intake.server.listen(0,'127.0.0.1');await once(intake.server,'listening');
 const url=`http://127.0.0.1:${(intake.server.address() as AddressInfo).port}/hooks`;
 const post=async(id:string)=>{const before=Date.now(),body=JSON.stringify({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:at.toISOString(),event_type:'UserPromptSubmit',source_session_id:'known-abort-source',payload:{prompt:'合成已回滚重试'}}),response=await fetch(url,{method:'POST',headers:{authorization:'Bearer known-abort-only'},body});assert.equal(response.status,200);assert.equal(await response.text(),'');const after=Date.now();assert.ok(after-before<700,'HTTP admission still must not await database work');return {before,after};};
 return {db,at,user,installation,consumer,intake,post};
}
async function holdUser(t:TestContext,f:Awaited<ReturnType<typeof fixture>>,change?:(sql:Parameters<Parameters<typeof f.db.transaction>[0]>[0])=>Promise<void>){
 let release!:()=>void,locked!:(pid:number)=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>(resolve=>{locked=resolve;});
 const holder=f.db.transaction(async sql=>{await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.user]);locked((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);await gate;await change?.(sql);});
 t.after(async()=>{release();await holder;});return {pid:await ready,release,holder};
}
async function ingestWait(f:Awaited<ReturnType<typeof fixture>>,blocker:number,after:string|null=null){
 let start:string|undefined;
 await until(async()=>{start=(await f.db.query<{started:string}>("SELECT query_start::text AS started FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT status,ingest_epoch,cleanup_generation FROM users%' AND ($2::timestamptz IS NULL OR query_start>$2::timestamptz) ORDER BY query_start LIMIT 1",[blocker,after])).rows[0]?.started;return !!start;},2500);
 return start!;
}

test('one actual five-second server abort retries the same event while the next queued event survives',{timeout:15000},async t=>{
 const f=await fixture(t),pid=f.consumer.child.pid;
 await f.db.query("CREATE SEQUENCE ingest_attempts; CREATE FUNCTION first_ingest_times_out() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('ingest_attempts')=1 THEN PERFORM pg_sleep(8); END IF; RETURN NEW; END $$; CREATE TRIGGER first_ingest_timeout BEFORE INSERT ON hook_events FOR EACH ROW EXECUTE FUNCTION first_ingest_times_out();");
 const first=await f.post('first'),second=await f.post('second');await until(()=>f.consumer.queue.snapshot().persisted===2,9000);
 const state=f.consumer.queue.snapshot();assert.equal(f.consumer.child.pid,pid);assert.equal(state.restarts,0);assert.equal(state.deliveryUnknown,0);assert.equal(state.dropped,0);assert.equal(state.duplicate,0);assert.equal(state.pending,0);
 assert.equal((await f.db.query('SELECT last_value::int AS n FROM ingest_attempts')).rows[0]!.n,3,'only the first event receives one extra attempt');
 const rows=(await f.db.query<{id:string;received_at:Date;first_seen:Date}>('SELECT k.client_event_id AS id,e.received_at,k.first_seen FROM event_keys k JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at ORDER BY k.client_event_id')).rows;
 assert.equal(rows.length,2);for(const [index,row]of rows.entries()){const sent=index===0?first:second;assert.equal(row.received_at.getTime(),row.first_seen.getTime());assert.ok(row.first_seen.getTime()>=sent.before&&row.first_seen.getTime()<=sent.after,'a retry preserves the original HTTP admission time');}
 assert.equal((await f.db.query("SELECT generation FROM jobs WHERE kind='derive_session'")).rows[0]!.generation,2,'the aborted attempt cannot inflate accepted Hook generations');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM event_keys')).rows[0]!.n,2);assert.equal(f.intake.snapshot().filtered,0);
});

test('a real one-second lock abort retries without restarting or losing the following queued event',{timeout:12000},async t=>{
 const f=await fixture(t),pid=f.consumer.child.pid,lock=await holdUser(t,f);await f.post('first');const firstWait=await ingestWait(f,lock.pid);await f.post('second');
 // Seeing a later actual wait proves the first lock attempt timed out and the
 // same delivery reached its sole retry; release only after that boundary.
 await ingestWait(f,lock.pid,firstWait);lock.release();await lock.holder;await until(()=>f.consumer.queue.snapshot().persisted===2,5000);
 const state=f.consumer.queue.snapshot();assert.equal(f.consumer.child.pid,pid);assert.equal(state.restarts,0);assert.equal(state.deliveryUnknown,0);assert.equal(state.dropped,0);assert.equal(state.duplicate,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,2);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM event_keys')).rows[0]!.n,2);assert.equal((await f.db.query("SELECT generation FROM jobs WHERE kind='derive_session'")).rows[0]!.generation,2);
});

for(const changed of ['epoch','cleanup','token'] as const)test('a safe retry rechecks the committed '+changed+' fence using its original admission identity',{timeout:12000},async t=>{
 const f=await fixture(t),pid=f.consumer.child.pid,lock=await holdUser(t,f,async sql=>{
  if(changed==='epoch')await sql.query('UPDATE users SET ingest_epoch=ingest_epoch+1 WHERE id=$1',[f.user]);
  else if(changed==='token')await sql.query('UPDATE installations SET token_hash=$2 WHERE id=$1',[f.installation,createHash('sha256').update('rotated-known-abort-only').digest('hex')]);
  else{await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.user,f.at,new Date(f.at.getTime()+1000)]);}
 });
 await f.post('fenced');const firstWait=await ingestWait(f,lock.pid);await ingestWait(f,lock.pid,firstWait);lock.release();await lock.holder;await until(()=>f.consumer.queue.snapshot().dropped===1,5000);
 assert.equal(f.consumer.child.pid,pid);assert.equal(f.consumer.queue.snapshot().restarts,0);assert.equal(f.consumer.queue.snapshot().deliveryUnknown,0);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,0);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM event_keys')).rows[0]!.n,0);assert.equal((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='derive_session'")).rows[0]!.n,0);
});
