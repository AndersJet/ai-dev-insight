import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createUsageAttributionService } from '../../src/usage-attribution.js';
import { createUsageAttributionJobs } from '../../src/usage-attribution-jobs.js';
import type { ProviderUsagePage } from '../../src/usage-provider.js';

const response = (hook: string): ProviderUsagePage => ({ items: [], pagination: null, request_id: 'job-fixture', observed_at: new Date().toISOString(), response_hash: 'c'.repeat(64), query: { endpoint: 'session_usage_detail', parameters: { session_ids: [hook] } } });
test('durable attribution jobs discover verified recent sessions and survive coordinator replacement', async t => {
  const db = await testDatabase(t); await db.migrate(); const user = randomUUID(); const session = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-job@example.invalid','关联任务夹具')", [user]);
  await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-job',clock_timestamp(),clock_timestamp())", [session,user]);
  let time=Date.now();const clock=()=>new Date(time);
  const jobs = createUsageAttributionJobs(db,{providerAccount:'job-test',clock,provider:{getSessionUsage:async hook=>response(hook)}});
  assert.equal(await jobs.discoverRecent(),0);
  await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('job-test',$1,'external-person','link-job@example.invalid')",[user]);
  time+=31000;
  assert.equal(await jobs.discoverRecent(),1); assert.equal(await jobs.discoverRecent(),0);
  const id=await jobs.enqueue(session); const restarted=createUsageAttributionJobs(db,{providerAccount:'job-test',provider:{getSessionUsage:async hook=>response(hook)}});
  assert.equal(await restarted.runOne(),true); assert.equal((await restarted.status(id)).status,'succeeded');
  assert.equal((await createUsageAttributionService(db,{providerAccount:'job-test'}).read(session)).probe_state,'empty');
  assert.equal(await restarted.runOne(),false);
});

test('old recurring sessions stop source probing and resume when a new Hook makes the session recent again',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();let time=Date.now();let calls=0;
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-retention@example.invalid','关联窗口夹具')",[user]);
 await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-retention',$3,$3)",[session,user,new Date(time)]);
 await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('retention-test',$1,'external-person','link-retention@example.invalid')",[user]);
 const jobs=createUsageAttributionJobs(db,{providerAccount:'retention-test',clock:()=>new Date(time),provider:{getSessionUsage:async hook=>{calls++;return response(hook);}}});
 assert.equal(await jobs.discoverRecent(),1);time+=46*86400000;
 assert.equal(await jobs.runOne(),true);assert.equal(calls,0);
 await db.query('UPDATE sessions SET last_at=$2 WHERE id=$1',[session,new Date(time)]);
 await jobs.enqueue(session);assert.equal(await jobs.runOne(),true);assert.equal(calls,1);
});

test('revoking a running attribution job lease prevents its source response from publishing',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-fence@example.invalid','关联租约夹具')",[user]);
 await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-fence',clock_timestamp(),clock_timestamp())",[session,user]);
 await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('fence-test',$1,'external-person','link-fence@example.invalid')",[user]);
 let received!:()=>void;let release!:(value:ProviderUsagePage)=>void;const entered=new Promise<void>(resolve=>{received=resolve;});const held=new Promise<ProviderUsagePage>(resolve=>{release=resolve;});
 const jobs=createUsageAttributionJobs(db,{providerAccount:'fence-test',provider:{getSessionUsage:async()=>{received();return held;}}});const id=await jobs.enqueue(session);
 const running=jobs.runOne();await entered;await db.query("UPDATE jobs SET lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",[id,randomUUID()]);release(response('hook-fence'));await running;
 assert.equal((await jobs.status(id)).status,'running');assert.notEqual((await createUsageAttributionService(db,{providerAccount:'fence-test'}).read(session)).probe_state,'empty');
});

test('a real short database lock conflict leaves attribution retryable instead of permanently failing it',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-lock@example.invalid','关联短锁夹具')",[user]);
 await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-lock',clock_timestamp(),clock_timestamp())",[session,user]);
 await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('lock-test',$1,'external-person','link-lock@example.invalid')",[user]);
 let unlock!:()=>void;const held=new Promise<void>(resolve=>{unlock=resolve;});let locked!:()=>void;const started=new Promise<void>(resolve=>{locked=resolve;});let blocker:Promise<void>|undefined;
 const jobs=createUsageAttributionJobs(db,{providerAccount:'lock-test',provider:{getSessionUsage:async hook=>{
   blocker=db.transaction(async client=>{await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);locked();await held;});await started;return response(hook);
 }}});
 const id=await jobs.enqueue(session);try{await jobs.runOne();const state=await jobs.status(id);assert.equal(state.status,'queued');assert.equal(state.error_code,'55P03');}finally{unlock();await blocker;}
});


test('recurring Hook probes cool after one hour and after 24 hours without heating up merely because an empty query succeeded',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();let at=new Date();const last=new Date(at.getTime()-2*3600000);
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-clock@example.invalid','关联分级')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-clock',$3,$3)",[session,user,last]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('clock-test',$1,'external-person','link-clock@example.invalid')",[user]);
 const options={providerAccount:'clock-test',clock:()=>at,provider:{getSessionUsage:async(hook:string)=>({...response(hook),observed_at:at.toISOString()})}};const jobs=createUsageAttributionJobs(db,options);await jobs.discoverRecent();const id=await jobs.enqueue(session);await jobs.runOne();assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+3600000).toISOString());
 at=new Date(at.getTime()+25*3600000);const restarted=createUsageAttributionJobs(db,options);await restarted.enqueue(session);await restarted.runOne();assert.equal((await restarted.status(id)).available_at,new Date(at.getTime()+86400000).toISOString());
});

test('recurring Hook failures remain visible and retry daily after a coordinator restart',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();let unavailable=true;
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-retry@example.invalid','关联日重试')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-retry',clock_timestamp(),clock_timestamp())",[session,user]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('retry-test',$1,'external-person','link-retry@example.invalid')",[user]);
 const {UsageProviderError}=await import('../../src/usage-provider.js');const options={providerAccount:'retry-test',provider:{getSessionUsage:async(hook:string)=>{if(unavailable)throw new UsageProviderError('provider_auth_failed');return response(hook);}}};
 const jobs=createUsageAttributionJobs(db,options);await jobs.discoverRecent();const id=await jobs.enqueue(session);await jobs.runOne();const failed=await jobs.status(id);assert.equal(failed.status,'failed');assert.equal(failed.error_code,'provider_auth_failed');assert.ok(Date.parse(failed.available_at)>Date.now()+23*3600000);
 unavailable=false;await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);const resumed=createUsageAttributionJobs(db,options);assert.equal(await resumed.runOne(),true);assert.equal((await resumed.status(id)).status,'succeeded');assert.equal((await createUsageAttributionService(db,{providerAccount:'retry-test'}).read(session)).probe_state,'empty');
});

test('new relationship IDs reheat an old Hook, while repeated evidence keeps its first observation and cools normally',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();let at=new Date(),ids=['bill-a'];
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-new@example.invalid','新关系升频')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-new',$3,$3)",[session,user,new Date(at.getTime()-2*86400000)]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('new-test',$1,'external-person','link-new@example.invalid')",[user]);
 const options={providerAccount:'new-test',clock:()=>at,provider:{getSessionUsage:async(hook:string):Promise<ProviderUsagePage>=>({...response(hook),observed_at:at.toISOString(),items:ids.map(id=>({billing_session_id:id,provider_user_id:'external-person',email:'link-new@example.invalid',start_time:null,scene:'Chat',client:'ide',model_name:'Synthetic',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:null,departments:[],usage:{prompt_tokens:null,completion_tokens:null,total_tokens:null,cache_creation_input_tokens:null,cache_read_input_tokens:null},amount:null,amount_reason:'missing',currency:null,quality:['tokens_incomplete'],token_basis:'provider_reported'}))})}};
 const jobs=createUsageAttributionJobs(db,options);await jobs.discoverRecent();const id=await jobs.enqueue(session);await jobs.runOne();assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+300000).toISOString());
 const reader=createUsageAttributionService(db,options);const first=await reader.read(session);
 at=new Date(at.getTime()+2*3600000);await jobs.enqueue(session);await jobs.runOne();assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+3600000).toISOString());assert.equal((await reader.read(session)).links[0]?.first_seen_at,first.links[0]?.first_seen_at);
 ids=['bill-a','bill-b'];await jobs.enqueue(session);await jobs.runOne();assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+300000).toISOString());assert.equal((await reader.read(session)).links.length,2);
});

test('a late Hook wakes an existing old recurring probe even when no probe subject has been created yet',async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date();let at=new Date(now.getTime()-46*86400000),calls=0;await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(now.getTime()+86400000));
 const user=randomUUID(),session=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-late@example.invalid','迟到关联唤醒')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-late',$3,$3)",[session,user,at]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'a'.repeat(64)]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('late-test',$1,'external-person','link-late@example.invalid')",[user]);
 const options={providerAccount:'late-test',clock:()=>at,provider:{getSessionUsage:async(hook:string)=>{calls++;return {...response(hook),observed_at:at.toISOString()};}}};const jobs=createUsageAttributionJobs(db,options);await jobs.discoverRecent();const id=await jobs.enqueue(session);at=now;await jobs.runOne();assert.equal(calls,0);
 const event={schema_version:2 as const,installation_id:installation,client_event_id:'late-wakeup',event_type:'UserPromptSubmit' as const,source_session_id:'hook-late',occurred_at:new Date(now.getTime()-46*86400000+3600000).toISOString(),payload:{prompt:'合成迟到'}};assert.equal((await db.ingest(event,{admissionEpoch:1,receivedAt:now})).outcome,'committed');assert.equal((await jobs.status(id)).available_at,new Date(now.getTime()+300000).toISOString());
 assert.equal((await db.ingest(event,{admissionEpoch:1,receivedAt:new Date(now.getTime()+600000)})).outcome,'duplicate');assert.equal((await jobs.status(id)).available_at,new Date(now.getTime()+300000).toISOString());
 at=new Date(now.getTime()+300000);await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);assert.equal(await createUsageAttributionJobs(db,options).runOne(),true);assert.equal(calls,1);assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+300000).toISOString());
 await db.query("UPDATE users SET status='suspended',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await jobs.runOne();assert.equal((await jobs.status(id)).error_code,'account_inactive');
 await db.query("UPDATE users SET status='active',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);const restored=createUsageAttributionJobs(db,options);assert.equal(await restored.discoverRecent(),1);assert.equal(await restored.runOne(),true);assert.equal((await restored.status(id)).status,'succeeded');assert.equal(calls,2);
});

test('discovery adopts a prior one-shot probe and resumes it after account reactivation',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),session=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-adopt@example.invalid','周期衔接')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-adopt',clock_timestamp(),clock_timestamp())",[session,user]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('adopt-test',$1,'external-person','link-adopt@example.invalid')",[user]);
 const options={providerAccount:'adopt-test',provider:{getSessionUsage:async(hook:string)=>response(hook)}};const manual=createUsageAttributionJobs(db,options);const id=await manual.enqueue(session);await manual.runOne();assert.equal(await manual.runOne(),false);
 const automatic=createUsageAttributionJobs(db,options);assert.equal(await automatic.discoverRecent(),1);
 // Publication uses the application clock; claims use PostgreSQL time. Advance
 // this fixture to due explicitly instead of assuming the two clocks agree.
 await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);assert.equal(await automatic.runOne(),true,JSON.stringify({state:await automatic.status(id),db:(await db.query('SELECT clock_timestamp() AS now')).rows[0]}));assert.ok(Date.parse((await automatic.status(id)).available_at)>Date.now()+4*60000);
 await db.query("UPDATE users SET status='suspended',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await automatic.runOne();assert.equal((await automatic.status(id)).error_code,'account_inactive');
 await db.query("UPDATE users SET status='active',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);const resumed=createUsageAttributionJobs(db,options);assert.equal(await resumed.discoverRecent(),1);assert.equal((await resumed.status(id)).status,'queued');assert.equal(await resumed.runOne(),true);assert.equal((await resumed.status(id)).status,'succeeded');
});

test('a Hook arriving during the official request affects the next probe without revoking the running lease',async t=>{
 const db=await testDatabase(t);await db.migrate();let at=new Date();const earlier=new Date(at.getTime()-2*86400000);await db.ensurePartitions(earlier,new Date(at.getTime()+86400000));const user=randomUUID(),session=randomUUID(),installation=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'link-inflight@example.invalid','并发接收')",[user]);await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'hook-inflight',$3,$3)",[session,user,earlier]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'b'.repeat(64)]);await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('inflight-test',$1,'external-person','link-inflight@example.invalid')",[user]);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
 const jobs=createUsageAttributionJobs(db,{providerAccount:'inflight-test',clock:()=>at,provider:{getSessionUsage:async hook=>{entered();await held;return {...response(hook),observed_at:at.toISOString()};}}});await jobs.discoverRecent();const id=await jobs.enqueue(session);const running=jobs.runOne();await started;
 at=new Date(at.getTime()+1000);try{assert.equal((await db.ingest({schema_version:2,installation_id:installation,client_event_id:'inflight-late',event_type:'UserPromptSubmit',source_session_id:'hook-inflight',occurred_at:earlier.toISOString(),payload:{prompt:'合成并发'}},{admissionEpoch:1,receivedAt:at})).outcome,'committed');}finally{release();await running;}
 assert.equal((await jobs.status(id)).status,'succeeded');assert.equal((await jobs.status(id)).available_at,new Date(at.getTime()+300000).toISOString());
});
