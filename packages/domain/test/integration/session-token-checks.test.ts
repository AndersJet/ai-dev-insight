import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Transaction} from '../../../storage/src/index.js';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createSessionDerivationService} from '../../src/session-derivation.js';
import {createSessionTokenChecks} from '../../src/session-token-checks.js';

test('daily token checks persist insufficient evidence and reuse unchanged results without treating scenario tokens as verified predictions',async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date(),at=new Date(now.getTime()-86400000);await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(now.getTime()+86400000));
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-check@example.invalid','合成检查')",[user]);await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,user,'d'.repeat(64),'合成']);
 const event=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'1',occurred_at:at.toISOString(),event_type:'UserPromptSubmit',source_session_id:'synthetic-token-check',payload:{prompt:'PRIVATE_SYNTHETIC_TEXT',model:'Synthetic Model'}},{admissionEpoch:1,receivedAt:now});assert.equal(event.outcome,'committed');if(event.outcome!=='committed')return;
 const derivation=createSessionDerivationService(db);while(await derivation.runOne()){/* Publish the synthetic projection. */}
 let time=now;const checks=createSessionTokenChecks(db,{clock:()=>time});assert.equal((await checks.read(event.sessionId)).state,'not_checked');
 const job=await checks.enqueue(event.sessionId);assert.equal(await checks.runOne(),true);assert.equal((await checks.status(job)).status,'succeeded');
 const first=await checks.read(event.sessionId);assert.equal(first.state,'current');assert.equal(first.result?.verdict,'insufficient_data');assert.equal(first.result?.eligible,false);assert.ok(first.result?.reasons.includes('prediction_not_validated'));assert.ok(first.result?.reasons.includes('session_coverage_unknown'));assert.ok(first.result?.reasons.includes('official_source_unconfigured'));assert.doesNotMatch(JSON.stringify(first),/PRIVATE_SYNTHETIC_TEXT|24000|normal|fraud/);
 assert.equal(await checks.runOne(),false,'successful daily checks cannot run in a busy loop');
 time=new Date(now.getTime()+60000);await checks.enqueue(event.sessionId);await checks.runOne();assert.equal((await checks.read(event.sessionId)).checked_at,first.checked_at,'unchanged source reuses its original computation');
 const restarted=createSessionTokenChecks(db,{clock:()=>time});assert.deepEqual(await restarted.read(event.sessionId),await checks.read(event.sessionId));
});

test('a worker account containing an underscore cannot claim a different official account task',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),at=new Date();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-account@example.invalid','合成账号')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'account-scope',$3,$3)",[session,user,at]);
 const target=createSessionTokenChecks(db,{providerAccount:'sourceXa'}),other=createSessionTokenChecks(db,{providerAccount:'source_a'});const id=await target.enqueue(session);
 assert.equal(await other.runOne(),false);await assert.rejects(other.status(id),{code:'not_found'});assert.equal(await target.runOne(),true);assert.equal((await target.status(id)).status,'succeeded');
});

test('actual official revisions invalidate daily results but unchanged verification does not retrain or recalculate them',async t=>{
 const {createUsageSnapshotStore}=await import('../../src/usage-snapshots.js');
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),now=new Date(),at=new Date(now.getTime()-86400000);let time=now;
 const date=new Date(at.getTime()+28800000).toISOString().slice(0,10),email='token-revision@example.invalid';await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,email,'合成修订']);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'revision-scope',$3,$3)",[session,user,at]);
 const store=createUsageSnapshotStore(db,{providerAccount:'revisions',clock:()=>time});
 async function publish(tokens:string){const draft=await store.begin(user,date),query=draft.parts[0]!.query;await store.stage(draft,0,{items:[{billing_session_id:'synthetic-bill',provider_user_id:'synthetic-provider',email,start_time:String(query.start_time+3600),client:'ide',scene:'Chat',model_name:'Synthetic',model_source:'Trae',model_type:'Chat',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens,completion_tokens:'2',total_tokens:String(BigInt(tokens)+2n),cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:'CNY',quality:[],token_basis:'provider_reported'}],pagination:{page:1,page_size:200,total:1,total_pages:1},request_id:'synthetic',observed_at:time.toISOString(),response_hash:'f'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...query,page:1}}});await store.publish(draft);}
 await publish('100');const checks=createSessionTokenChecks(db,{providerAccount:'revisions',clock:()=>time});await checks.enqueue(session);await checks.runOne();const original=await checks.read(session);assert.equal(original.state,'current');
 time=new Date(now.getTime()+60000);await publish('100');assert.equal((await checks.read(session)).state,'current');await checks.enqueue(session);await checks.runOne();assert.equal((await checks.read(session)).checked_at,original.checked_at);
 time=new Date(now.getTime()+120000);await publish('80');const stale=await checks.read(session);assert.equal(stale.state,'stale');assert.equal(stale.result,null);await checks.enqueue(session);await checks.runOne();const revised=await checks.read(session);assert.equal(revised.state,'current');assert.notEqual(revised.source_version,original.source_version);assert.equal(revised.checked_at,time.toISOString());assert.equal(revised.result?.verdict,'insufficient_data');
});

test('a logical cleanup outside the session still invalidates its shared official day before physical deletion',async t=>{
 const {createUsageSnapshotStore}=await import('../../src/usage-snapshots.js');const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),now=new Date(),day=Math.floor((now.getTime()+28800000)/86400000)*86400000-28800000-86400000,at=new Date(day+12*3600000),date=new Date(day+28800000).toISOString().slice(0,10);
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-clean@example.invalid','合成清理')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'cleanup-scope',$3,$3)",[session,user,at]);
 const store=createUsageSnapshotStore(db,{providerAccount:'clean-check'}),draft=await store.begin(user,date);await store.stage(draft,0,{items:[],pagination:{page:1,page_size:200,total:0,total_pages:0},request_id:'synthetic',observed_at:now.toISOString(),response_hash:'f'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...draft.parts[0]!.query,page:1}}});await store.publish(draft);
 const checks=createSessionTokenChecks(db,{providerAccount:'clean-check'});await checks.enqueue(session);await checks.runOne();assert.ok(!(await checks.read(session)).result?.reasons.includes('official_source_incomplete'));
 await db.transaction(async sql=>{await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[user]);await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[user,new Date(day+3600000),new Date(day+7200000)]);});
 assert.equal((await checks.read(session)).state,'stale');await checks.enqueue(session);await checks.runOne();const after=await checks.read(session);assert.ok(after.result?.reasons.includes('official_source_incomplete'));assert.ok(!after.result?.reasons.includes('trace_partial'),'the removed time was outside this session');
});

test('unrelated session attribution revisions do not invalidate a result with unchanged relevant evidence',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),now=new Date();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-links@example.invalid','合成关系')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'link-scope',$3,$3)",[session,user,now]);
 const checks=createSessionTokenChecks(db,{providerAccount:'links'});await checks.enqueue(session);await checks.runOne();const before=await checks.read(session);
 await db.query("INSERT INTO usage_attribution_revisions(provider_account,user_id,revision) VALUES('links',$1,1)",[user]);
 assert.equal((await checks.read(session)).state,'current');await checks.enqueue(session);await checks.runOne();assert.equal((await checks.read(session)).checked_at,before.checked_at);
});

test('a disabled owner cannot publish a new daily result, and reactivation permits a retry',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),now=new Date();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-disabled@example.invalid','停用合成账号')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'disabled-scope',$3,$3)",[session,user,now]);
 const checks=createSessionTokenChecks(db);const job=await checks.enqueue(session);await db.query("UPDATE users SET status='suspended' WHERE id=$1",[user]);await checks.runOne();assert.equal((await checks.status(job)).error_code,'account_inactive');assert.equal((await checks.read(session)).result,null);
 await db.query("UPDATE users SET status='active' WHERE id=$1",[user]);await checks.enqueue(session);await checks.runOne();assert.equal((await checks.read(session)).state,'current');
});

async function concurrencyFixture(t:import('node:test').TestContext){
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID(),now=new Date();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'token-concurrency@example.invalid','并发合成账号')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'concurrent-scope',$3,$3)",[session,user,now]);return {db,user,session,now};
}
async function blockedBy(db:Awaited<ReturnType<typeof testDatabase>>,pid:number){
 const {setTimeout:delay}=await import('node:timers/promises');const until=Date.now()+2000;
 while(Date.now()<until){if((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount)return;await delay(10);}assert.fail('worker must reach the real PostgreSQL publication lock');
}

test('a source revision committed while a check waits to publish cannot be saved as current, and retry uses the new source',async t=>{
 const f=await concurrencyFixture(t),checks=createSessionTokenChecks(f.db);const job=await checks.enqueue(f.session);let release!:()=>void,locked!:(pid:number)=>void;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<number>(r=>{locked=r;});
 const gate=f.db.transaction(async sql=>{await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.user]);locked((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);await held;await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);});const pid=await ready,running=checks.runOne();
 try{await blockedBy(f.db,pid);}finally{release();await gate;await running;}
 assert.equal((await checks.status(job)).error_code,'content_changed');assert.equal((await checks.read(f.session)).result,null);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[f.session])).rows[0]!.n,0);
 await checks.enqueue(f.session);await checks.runOne();assert.equal((await checks.read(f.session)).state,'current');assert.equal((await checks.status(job)).status,'succeeded');
});

test('an expired check lease can be reclaimed and the old worker cannot publish or overwrite the replacement result',async t=>{
 const f=await concurrencyFixture(t),old=createSessionTokenChecks(f.db,{clock:()=>f.now}),replacementAt=new Date(f.now.getTime()+60000),replacement=createSessionTokenChecks(f.db,{clock:()=>replacementAt});const job=await old.enqueue(f.session);let release!:()=>void,locked!:(pid:number)=>void;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<number>(r=>{locked=r;});
 const gate=f.db.transaction(async sql=>{await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.user]);locked((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);await held;});const pid=await ready,running=old.runOne();let reclaimed:Promise<boolean>|undefined;
 try{await blockedBy(f.db,pid);await f.db.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running'",[job]);reclaimed=replacement.runOne();
  const {setTimeout:delay}=await import('node:timers/promises');const until=Date.now()+1500;let claimed=false;while(Date.now()<until){claimed=(await f.db.query<{live:boolean}>('SELECT lease_until>clock_timestamp() AS live FROM jobs WHERE id=$1',[job])).rows[0]!.live;if(claimed)break;await delay(10);}assert.equal(claimed,true,'the replacement must claim the expired lease before release');
 }finally{release();await gate;await running;await reclaimed;}
 const result=await replacement.read(f.session);assert.equal(result.state,'current');assert.equal(result.checked_at,replacementAt.toISOString());assert.equal((await replacement.status(job)).status,'succeeded');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[f.session])).rows[0]!.n,1);
});

test('a persisted retention boundary invalidates a shared official scope before its rows are physically pruned',async t=>{
 const {createUsageSnapshotStore}=await import('../../src/usage-snapshots.js');const f=await concurrencyFixture(t),day=Math.floor((f.now.getTime()+28800000)/86400000)*86400000-28800000-86400000,at=new Date(day+12*3600000),date=new Date(day+28800000).toISOString().slice(0,10);await f.db.query('UPDATE sessions SET first_at=$2,last_at=$2 WHERE id=$1',[f.session,at]);
 const store=createUsageSnapshotStore(f.db,{providerAccount:'retention-check'}),draft=await store.begin(f.user,date);await store.stage(draft,0,{items:[],pagination:{page:1,page_size:200,total:0,total_pages:0},request_id:'synthetic',observed_at:f.now.toISOString(),response_hash:'c'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...draft.parts[0]!.query,page:1}}});await store.publish(draft);
 const checks=createSessionTokenChecks(f.db,{providerAccount:'retention-check'});await checks.enqueue(f.session);await checks.runOne();const before=await checks.read(f.session);assert.equal(before.state,'current');assert.ok(!before.result?.reasons.includes('official_source_incomplete'));
 await f.db.query('UPDATE data_identity SET retention_cutoff=$1 WHERE singleton=true',[new Date(day+3600000)]);
 assert.equal((await checks.read(f.session)).state,'stale');await checks.enqueue(f.session);await checks.runOne();const after=await checks.read(f.session);assert.ok(after.result?.reasons.includes('official_source_incomplete'));assert.ok(!after.result?.reasons.includes('trace_partial'),'the session itself is after the cutoff');
});

async function changedProjection(t:import('node:test').TestContext){
 const f=await concurrencyFixture(t),installation=randomUUID();await f.db.ensurePartitions(new Date(f.now.getTime()-86400000),new Date(f.now.getTime()+86400000));await f.db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,f.user,'b'.repeat(64),'每日重查合成安装']);
 const event=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:'daily-source',occurred_at:f.now.toISOString(),event_type:'UserPromptSubmit',source_session_id:'concurrent-scope',payload:{prompt:'合成提示',model:'Synthetic'}},{admissionEpoch:1,receivedAt:f.now});assert.equal(event.outcome,'committed');
 const checks=createSessionTokenChecks(f.db,{clock:()=>f.now}),job=await checks.enqueue(f.session);await checks.runOne();const first=await checks.read(f.session);assert.ok(first.result?.reasons.includes('trace_pending'));assert.ok(Date.parse((await checks.status(job)).available_at)>Date.now()+23*3600000);
 assert.equal(await checks.runOne(),false,'the unchanged daily cooldown is respected');
 const derivations=createSessionDerivationService(f.db);while(await derivations.runOne()){/* Complete the real projection after the earlier quality observation. */}
 assert.equal((await checks.read(f.session)).state,'stale');return {...f,checks,job,first};
}

test('a completed projection automatically requeues its stale daily check while unchanged runs retain the daily cooldown',async t=>{
 const f=await changedProjection(t),at=new Date(f.now.getTime()+60000),checks=createSessionTokenChecks(f.db,{clock:()=>at});
 assert.equal(await checks.discoverRecent(),1);assert.equal((await checks.status(f.job)).status,'queued');
 assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),0,'repeated discovery cannot keep replacing a queued check');
 assert.equal(await checks.runOne(),true);const refreshed=await checks.read(f.session);assert.equal(refreshed.state,'current');assert.ok(!refreshed.result?.reasons.includes('trace_pending'));assert.notEqual(refreshed.source_version,f.first.source_version);assert.equal(refreshed.checked_at,at.toISOString());assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[f.session])).rows[0]!.n,1);assert.ok(Date.parse((await checks.status(f.job)).available_at)>Date.now()+23*3600000);
 const completed=(await f.db.query('SELECT generation,status,available_at FROM jobs WHERE id=$1',[f.job])).rows[0];
 assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),0,'the same published run must not reset its daily plan');assert.equal(await checks.runOne(),false,'successful unchanged daily checks cannot run in a busy loop');
 assert.deepEqual((await f.db.query('SELECT generation,status,available_at FROM jobs WHERE id=$1',[f.job])).rows[0],completed);
});

test('changed-run discovery preserves queued and running jobs including their generation and live leases',async t=>{
 const f=await changedProjection(t);
 for(const status of ['queued','running','failed','cancelled']){
  const lease=status==='running'?randomUUID():null;
  await f.db.query("UPDATE jobs SET status=$2,generation=9,attempt=2,error_code=$3,lease_token=$4,lease_until=CASE WHEN $4::uuid IS NULL THEN NULL ELSE clock_timestamp()+interval '1 minute' END,available_at=clock_timestamp()+interval '1 day' WHERE id=$1",[f.job,status,status==='cancelled'?'session_cleared':null,lease]);
  const before=(await f.db.query('SELECT generation,status,attempt,error_code,lease_token,lease_until,available_at FROM jobs WHERE id=$1',[f.job])).rows[0];
  assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),0,status+' must not be rescheduled by a stale checked run');
  assert.deepEqual((await f.db.query('SELECT generation,status,attempt,error_code,lease_token,lease_until,available_at FROM jobs WHERE id=$1',[f.job])).rows[0],before);
 }
});

test('changed-run discovery cannot replace a real check completion committed while its conflict row is locked',async t=>{
 const f=await changedProjection(t),at=new Date(f.now.getTime()+60000);let release!:()=>void,locked!:(pid:number)=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>(resolve=>{locked=resolve;});t.after(()=>release());
 const completion=f.db.transaction(async sql=>{
  await sql.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[f.job]);locked((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);await held;
  // Run the actual claim/source/publication code on the held connection, so its
  // successful result and job update commit together ahead of the waiting INSERT.
  await sql.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job]);
  const db=new Proxy(f.db,{get(target,key,receiver){if(key==='query')return sql.query.bind(sql);if(key==='transaction')return <T>(work:(client:Transaction)=>Promise<T>)=>work(sql);return Reflect.get(target,key,receiver);}});
  assert.equal(await createSessionTokenChecks(db,{clock:()=>at}).runOne(),true);
 });
 const pid=await ready,discovery=createSessionTokenChecks(f.db).discoverRecent();void discovery.catch(()=>{});
 try{await blockedBy(f.db,pid);}finally{release();await completion;}
 assert.equal(await discovery,0,'the observed xmin cannot authorize rescheduling a newer completion');
 const checked=await f.checks.read(f.session);assert.equal(checked.state,'current');assert.equal(checked.checked_at,at.toISOString());assert.notEqual(checked.source_version,f.first.source_version);
 assert.equal((await f.checks.status(f.job)).status,'succeeded');assert.ok(Date.parse((await f.checks.status(f.job)).available_at)>Date.now()+23*3600000);assert.equal((await f.db.query<{generation:number}>('SELECT generation FROM jobs WHERE id=$1',[f.job])).rows[0]!.generation,1);
 assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),0,'a repeated discovery sees the completed matching run');
});

test('changed-run discovery requires a valid current cleanup generation and preserves other account jobs',async t=>{
 const f=await changedProjection(t),before=(await f.db.query('SELECT generation,status,available_at FROM jobs WHERE id=$1',[f.job])).rows[0];
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);
 assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),0,'a prior-cleanup published run cannot reactivate the daily check');
 assert.deepEqual((await f.db.query('SELECT generation,status,available_at FROM jobs WHERE id=$1',[f.job])).rows[0],before);
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation-1 WHERE id=$1',[f.user]);
 const other=createSessionTokenChecks(f.db,{providerAccount:'other-account'});assert.equal(await other.discoverRecent(),1,'a different account discovers only its own new task');
 assert.deepEqual((await f.db.query('SELECT generation,status,available_at FROM jobs WHERE id=$1',[f.job])).rows[0],before);
 assert.equal(await createSessionTokenChecks(f.db).discoverRecent(),1);assert.equal((await f.checks.status(f.job)).status,'queued');
 const foreign=(await f.db.query<{status:string;generation:number;provider:string}>("SELECT status,generation,payload->>'provider_account' AS provider FROM jobs WHERE dedupe_key=$1",['token-check:other-account:'+f.session])).rows[0]!;assert.equal(foreign.status,'queued');assert.equal(foreign.generation,1);assert.equal(foreign.provider,'other-account');
});

test('a resumed old conversation is automatically checked again after expiry',async t=>{
 const db=await testDatabase(t);await db.migrate();const today=new Date(),old=new Date(today.getTime()-46*86400000);
 await db.ensurePartitions(old,new Date(today.getTime()+86400000));
 const user=randomUUID(),installation=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'review-expiry@example.invalid','Review fixture')",[user]);
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'Review fixture')",[installation,user,'e'.repeat(64)]);
 const put=(id:string,at:Date)=>db.ingest({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:at.toISOString(),event_type:'UserPromptSubmit',source_session_id:'review-same-conversation',payload:{prompt:'synthetic'}},{admissionEpoch:1,receivedAt:at});
 const first=await put('first',old);assert.equal(first.outcome,'committed');if(first.outcome!=='committed')return;
 let clock=old;const checks=createSessionTokenChecks(db,{clock:()=>clock});const job=await checks.enqueue(first.sessionId);
 assert.equal(await checks.runOne(),true);assert.equal((await checks.status(job)).status,'succeeded');
 clock=today;await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);
 assert.equal(await checks.runOne(),true);assert.equal((await checks.status(job)).status,'cancelled');assert.equal((await checks.status(job)).error_code,'token_check_expired');
 const resumed=await put('resumed',today);assert.equal(resumed.outcome,'committed');if(resumed.outcome!=='committed')return;assert.equal(resumed.sessionId,first.sessionId);
 const restarted=createSessionTokenChecks(db,{clock:()=>today});const discovered=await restarted.discoverRecent();const worked=await restarted.runOne();const status=await restarted.status(job);const result=await restarted.read(first.sessionId);
 assert.equal(discovered,1);assert.equal(worked,true);assert.equal(result.state,'current');assert.ok(result.next_check_at);
 assert.equal(await createSessionTokenChecks(db,{clock:()=>today}).discoverRecent(),0,'repeated discovery does not requeue a successful task');
 assert.equal(status.status,'succeeded','a recent resumed conversation must recover its automatically cancelled quality check');
});

for(const reason of ['session_cleared','inactive_owner','still_expired'] as const)test(`automatic discovery does not revive a cancelled token check for ${reason}`,async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date(),old=new Date(now.getTime()-46*86400000),user=randomUUID(),session=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'cancel-guard@example.invalid','取消保护')",[user]);
 await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'cancel-guard',$3,$3)",[session,user,old]);
 const checks=createSessionTokenChecks(db,{clock:()=>old}),job=await checks.enqueue(session);
 await db.query("UPDATE jobs SET status='cancelled',error_code=$2,available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job,reason==='session_cleared'?'session_cleared':'token_check_expired']);
 if(reason!=='still_expired')await db.query('UPDATE sessions SET last_at=$2 WHERE id=$1',[session,now]);
 if(reason==='inactive_owner')await db.query("UPDATE users SET status='suspended' WHERE id=$1",[user]);
 const current=createSessionTokenChecks(db,{clock:()=>now});assert.equal(await current.discoverRecent(),0);assert.equal(await current.runOne(),false);assert.equal((await current.status(job)).status,'cancelled');
});

test('a result invalidated by a completed projection refreshes when its daily task becomes due without a manual requeue',async t=>{
 const f=await concurrencyFixture(t),installation=randomUUID();await f.db.ensurePartitions(new Date(f.now.getTime()-86400000),new Date(f.now.getTime()+86400000));await f.db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,f.user,'b'.repeat(64),'每日重查合成安装']);
 const event=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:'daily-source',occurred_at:f.now.toISOString(),event_type:'UserPromptSubmit',source_session_id:'concurrent-scope',payload:{prompt:'合成提示',model:'Synthetic'}},{admissionEpoch:1,receivedAt:f.now});assert.equal(event.outcome,'committed');
 let at=f.now;const checks=createSessionTokenChecks(f.db,{clock:()=>at}),job=await checks.enqueue(f.session);await checks.runOne();const first=await checks.read(f.session);assert.ok(first.result?.reasons.includes('trace_pending'));assert.ok(Date.parse((await checks.status(job)).available_at)>Date.now()+23*3600000);
 const derivations=createSessionDerivationService(f.db);while(await derivations.runOne()){/* Finish the source after the earlier quality observation. */}
 assert.equal((await checks.read(f.session)).state,'stale');assert.equal(await checks.runOne(),false,'the daily cooldown is respected');
 // Advance only the test job's due-time boundary; do not enqueue or alter its
 // successful state, generation, result or source version.
 at=new Date(f.now.getTime()+60000);await f.db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);assert.equal(await checks.runOne(),true);
 const refreshed=await checks.read(f.session);assert.equal(refreshed.state,'current');assert.ok(!refreshed.result?.reasons.includes('trace_pending'));assert.notEqual(refreshed.source_version,first.source_version);assert.equal(refreshed.checked_at,at.toISOString());assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[f.session])).rows[0]!.n,1);assert.ok(Date.parse((await checks.status(job)).available_at)>Date.now()+23*3600000);
});
