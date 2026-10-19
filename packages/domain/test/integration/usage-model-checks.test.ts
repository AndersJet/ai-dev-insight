import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createUsageSyncService } from '../../src/usage-sync.js';
import { createUsageModelChecks } from '../../src/usage-model-checks.js';
import type { MemberModelUsageQuery, MemberUsageQuery, ProviderModelUsagePage, ProviderUsageItem, ProviderUsagePage } from '../../src/usage-provider.js';

const account='model-check-test',date='2026-09-28',clock=()=>new Date('2026-09-29T02:00:00Z');
function detail(id:string,input:string,client='ide'):ProviderUsageItem{
 return {billing_session_id:id,provider_user_id:'synthetic-person',email:'model-check@example.invalid',start_time:String(Date.parse('2026-09-28T01:00:00Z')/1000),client,scene:'Chat',model_name:'Synthetic',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:input,completion_tokens:'2',total_tokens:String(BigInt(input)+2n),cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:null,quality:[],token_basis:'provider_reported'};
}
function page(query:MemberUsageQuery,items:ProviderUsageItem[]):ProviderUsagePage{
 return {items,pagination:{page:1,page_size:query.page_size??200,total:items.length,total_pages:1},request_id:'detail-request',observed_at:clock().toISOString(),response_hash:createHash('sha256').update(JSON.stringify(items)).digest('hex'),query:{endpoint:'user_usage_detail',parameters:{...query,page:1,page_size:query.page_size??200}}};
}
function summary(query:MemberModelUsageQuery,input='140',output='4'):ProviderModelUsagePage{
 return {items:[{provider_user_id:'synthetic-person',email:'model-check@example.invalid',model_usage:[{model_name:'Synthetic',model_type:'Chat',model_source:'Trae',usage:{input_tokens:input,output_tokens:output}}]}],pagination:null,request_id:'model-request',observed_at:clock().toISOString(),response_hash:'d'.repeat(64),query:{endpoint:'user-model-usage',parameters:query}};
}
test('model cross-check compares the same closed member window across all clients and persists its result without adding to the ledger',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','模型核查')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[detail('one','100'),detail('two','40','cli')])}});const source=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(source)).status,'succeeded');
 const queries:MemberModelUsageQuery[]=[];const checks=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>{queries.push(query);return summary(query);}}});
 const job=await checks.enqueue(user,date);for(let i=0;i<8&&(await checks.status(job)).status!=='succeeded';i++)await checks.runOne();assert.equal((await checks.status(job)).status,'succeeded');
 const result=await checks.read(user,date);assert.equal(result.state,'matched');assert.equal(result.result?.groups[0]?.detail.input_tokens,'140');assert.equal(result.result?.groups[0]?.official.input_tokens,'140');assert.equal(result.result?.groups[0]?.official.output_tokens,'4');
 assert.deepEqual(queries,[{start_time:Date.parse('2026-09-28T00:00:00+08:00')/1000,end_time:Date.parse('2026-09-28T23:59:59+08:00')/1000,user_ids:['synthetic-person']}]);
 const restarted=createUsageModelChecks(db,{providerAccount:account,clock});assert.deepEqual(await restarted.read(user,date),result);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_observations o JOIN usage_scopes s ON s.published_run_id=o.run_id WHERE s.user_id=$1',[user])).rows[0]!.n,2);
});

test('an independent daily model check wakes a cold empty detail ledger when delayed official usage appears',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','迟到汇总')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[])}});const source=await sync.enqueue(user,date,{recurring:true});for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();
 await db.query("UPDATE jobs SET available_at=clock_timestamp()+interval '30 days' WHERE id=$1",[source]);
 let calls=0;const checks=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>{calls++;assert.deepEqual(query.emails,['model-check@example.invalid']);return summary(query,'90','3');}}});
 assert.equal(await checks.discoverRecent(),1);assert.equal(await checks.runOne(),true);assert.equal((await checks.read(user,date)).state,'difference');assert.equal((await checks.read(user,date)).result?.groups[0]?.detail.input_tokens,null,'an empty ledger has no reported token quantity');
 assert.ok(Date.parse((await sync.status(source)).available_at)<=Date.now()+1000,'the existing cold detail job becomes due');
 assert.equal(await checks.runOne(),false,'model checks do not loop every five minutes');assert.equal(calls,1);
});

test('different enterprise model names permit only cohort equality, and missing tokens never become zero',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','比较口径')",[user]);
 const row={...detail('custom','140'),model_name:'openai/AI/GLM',model_source:'Custom'};
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[row])}});const source=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();
 let missing=false,absent=false,empty=false;const checks=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>{
  const result=summary(query,'140','2');result.items[0]!.model_usage[0]!.model_name='AI/GLM|openai';result.items[0]!.model_usage[0]!.model_source='Custom';if(missing)result.items[0]!.model_usage[0]!.usage.input_tokens=null;if(empty)result.items[0]!.model_usage=[];if(absent)result.items=[];return result;
 }}});
 await checks.enqueue(user,date);await checks.runOne();let result=await checks.read(user,date);assert.equal(result.state,'cohort_matched');assert.equal(result.result?.groups[0]?.models_comparable,false);
 missing=true;await checks.enqueue(user,date);await checks.runOne();result=await checks.read(user,date);assert.equal(result.state,'not_comparable');assert.equal(result.result?.groups[0]?.official.input_tokens,null);
 absent=true;await checks.enqueue(user,date);await checks.runOne();result=await checks.read(user,date);assert.equal(result.state,'not_comparable');assert.equal(result.result?.reason,'member_not_returned');assert.equal(result.result?.groups[0]?.official.input_tokens,null,'a missing member response does not report a zero official quantity');
 absent=false;empty=true;await checks.enqueue(user,date);await checks.runOne();result=await checks.read(user,date);assert.equal(result.state,'not_comparable');assert.equal(result.result?.groups[0]?.official.input_tokens,null,'an empty model list is not an explicit zero-token report');
});

test('model verification resumes disjoint retained windows after restart and never queries the cleared gap',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name,cleanup_generation) VALUES($1,'model-check@example.invalid','分段恢复',2)",[user]);
 await db.query("INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,'2026-09-28T03:00:00Z','2026-09-28T04:00:00Z',2)",[user]);
 const split=Date.parse('2026-09-28T04:00:00Z')/1000;
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[{...detail(String(query.start_time),query.start_time<split?'100':'40'),start_time:String(query.start_time+1)}])}});
 const source=await sync.enqueue(user,date);for(let i=0;i<12&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(source)).status,'succeeded');
 const queries:MemberModelUsageQuery[]=[];const options={providerAccount:account,clock,provider:{getMemberModelUsage:async(query:MemberModelUsageQuery)=>{queries.push(query);return summary(query,query.start_time<split?'100':'40','2');}}};
 const checks=createUsageModelChecks(db,options),job=await checks.enqueue(user,date);await checks.runOne();assert.equal((await checks.status(job)).status,'queued');assert.equal((await checks.read(user,date)).state,'not_checked');
 const restarted=createUsageModelChecks(db,options);await restarted.runOne();assert.equal((await restarted.status(job)).status,'succeeded');const result=await restarted.read(user,date);assert.equal(result.state,'matched');assert.equal(result.result?.groups[0]?.official.input_tokens,'140');assert.equal(result.result?.evidence.length,2);
 assert.deepEqual(queries.map(q=>[q.start_time,q.end_time]),[[Date.parse('2026-09-27T16:00:00Z')/1000,Date.parse('2026-09-28T02:59:59Z')/1000],[split,Date.parse('2026-09-28T15:59:59Z')/1000]]);
});

test('a changed source during the model HTTP request cannot publish stale comparison or keep old comparison current',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','核查屏障')",[user]);let tokens='140';
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[detail('one',tokens)])}});
 async function publish(){const id=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(id)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(id)).status,'succeeded');}
 await publish();const baseline=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>summary(query,'140','2')}});await baseline.enqueue(user,date);await baseline.runOne();assert.equal((await baseline.read(user,date)).state,'matched');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});t.after(()=>release());
 const checks=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>{entered();await held;return summary(query,'140','2');}}});const job=await checks.enqueue(user,date);const running=checks.runOne();await started;
 try{tokens='200';await publish();}finally{release();await running;}
 assert.equal((await checks.status(job)).error_code,'usage_model_source_changed');const result=await checks.read(user,date);assert.equal(result.state,'stale');assert.equal(result.result,null);
});

test('wrong-owner model responses cannot publish, and rate limits pause subsequent source requests',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','上游边界')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[detail('one','140')])}});const source=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();
 const {UsageProviderError}=await import('../../src/usage-provider.js');let mode='wrong-owner',calls=0;
 const checks=createUsageModelChecks(db,{providerAccount:account,clock,onRateLimit:async seconds=>{assert.equal(seconds,120);await db.query("INSERT INTO usage_provider_control(provider_account,interval_ms,paused_until) VALUES($1,20,clock_timestamp()+interval '120 seconds') ON CONFLICT(provider_account) DO UPDATE SET paused_until=excluded.paused_until",[account]);},provider:{getMemberModelUsage:async query=>{calls++;if(mode==='limited')throw new UsageProviderError('provider_rate_limited',429,null,120);const result=summary(query,'140','2');if(mode==='wrong-owner')result.items[0]!.provider_user_id='different-person';return result;}}});
 const job=await checks.enqueue(user,date);await checks.runOne();assert.equal((await checks.status(job)).error_code,'usage_model_owner_mismatch');assert.equal((await checks.read(user,date)).state,'not_checked');
 mode='limited';await checks.enqueue(user,date);await checks.runOne();assert.equal((await checks.status(job)).status,'queued');assert.equal((await checks.status(job)).error_code,'provider_rate_limited');
 await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);assert.equal(await checks.runOne(),false);assert.equal(calls,2);
 mode='valid';await db.query("UPDATE usage_provider_control SET paused_until=clock_timestamp()-interval '1 second' WHERE provider_account=$1",[account]);await checks.runOne();assert.equal((await checks.read(user,date)).state,'matched');
});

test('a model response with a revoked job lease cannot replace an already published comparison',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','租约隔离')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[detail('one','140')])}});const source=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();
 const baseline=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>summary(query,'140','2')}});await baseline.enqueue(user,date);await baseline.runOne();const previous=await baseline.read(user,date);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});t.after(()=>release());
 const checks=createUsageModelChecks(db,{providerAccount:account,clock,provider:{getMemberModelUsage:async query=>{entered();await held;return summary(query,'999','2');}}}),job=await checks.enqueue(user,date);const running=checks.runOne();await started;
 await db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1',[job,randomUUID()]);release();await running;
 assert.equal((await checks.status(job)).status,'running');assert.deepEqual(await checks.read(user,date),previous);
});

test('successful retained windows do not exhaust retries and a timeout resumes only the unfinished window',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name,cleanup_generation) VALUES($1,'model-check@example.invalid','分段重试预算',2)",[user]);
 for(const hour of ['03','05','07','09','11'])await db.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,2)',[user,`2026-09-28T${hour}:00:00Z`,`2026-09-28T${hour}:30:00Z`]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[{...detail(String(query.start_time),'10'),start_time:String(query.start_time+1)}])}}),source=await sync.enqueue(user,date);for(let i=0;i<24&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(source)).status,'succeeded');
 const {UsageProviderError}=await import('../../src/usage-provider.js');const queries:MemberModelUsageQuery[]=[];const options={providerAccount:account,clock,provider:{getMemberModelUsage:async(query:MemberModelUsageQuery)=>{queries.push(query);if(queries.length===6)throw new UsageProviderError('provider_timeout');return summary(query,'10','2');}}};
 const checks=createUsageModelChecks(db,options),job=await checks.enqueue(user,date);for(let i=0;i<6;i++)await checks.runOne();assert.equal((await checks.status(job)).status,'queued','successful windows do not count as failed attempts');
 await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);const restarted=createUsageModelChecks(db,options);await restarted.runOne();assert.equal((await restarted.status(job)).status,'succeeded');assert.equal(queries.length,7);assert.deepEqual(queries[6],queries[5]);const result=await restarted.read(user,date);assert.equal(result.state,'matched');assert.equal(result.result?.groups[0]?.official.input_tokens,'60');assert.equal(result.result?.evidence.length,6);
});

test('an email-scoped empty snapshot cannot be compared with a corrected member email before source verification',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','人员查询一致性')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:account,clock,provider:{getMemberUsage:async query=>page(query,[])}});const source=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(source)).status!=='succeeded';i++)await sync.runOne();
 await db.query("UPDATE users SET email_key='corrected@example.invalid',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);
 const checks=createUsageModelChecks(db,{providerAccount:account,clock});await assert.rejects(checks.enqueue(user,date),{code:'usage_source_unavailable'});
 const refreshed=await sync.enqueue(user,date);for(let i=0;i<8&&(await sync.status(refreshed)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(refreshed)).status,'succeeded');assert.equal((await checks.status(await checks.enqueue(user,date))).status,'queued');
});

test('a revised retained old scope advances its existing model check without discovering unbounded old scopes',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'model-check@example.invalid','旧范围修订')",[user]);let at=new Date('2026-08-02T02:00:00Z'),input='100';const oldDate='2026-08-01';
 const sync=createUsageSyncService(db,{providerAccount:account,clock:()=>at,provider:{getMemberUsage:async query=>page(query,[{...detail('old',input),start_time:String(query.start_time+1)}])}});
 async function publish(day:string){const job=await sync.enqueue(user,day);for(let i=0;i<8&&(await sync.status(job)).status!=='succeeded';i++)await sync.runOne();assert.equal((await sync.status(job)).status,'succeeded');}
 await publish(oldDate);const checks=createUsageModelChecks(db,{providerAccount:account,clock:()=>at,provider:{getMemberModelUsage:async query=>summary(query,input,'2')}});const job=await checks.enqueue(user,oldDate);await checks.runOne();assert.equal((await checks.read(user,oldDate)).state,'matched');
 at=clock();input='200';await publish(oldDate);await publish('2026-08-03');assert.equal((await checks.read(user,oldDate)).state,'stale');assert.equal(await checks.discoverRecent(),1);assert.equal((await checks.status(job)).status,'queued');await checks.runOne();assert.equal((await checks.read(user,oldDate)).state,'matched');assert.ok(Date.parse((await checks.status(job)).available_at)>Date.now()+29*86400000);
});
