import {submitCleanupConfirmed} from '../helpers/cleanup-acceptance.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCleanupJournal } from '../../../storage/src/cleanup-journal.js';
import { createCleanupService } from '../../src/cleanup.js';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createAdministrationService } from '../../src/administration.js';
import { createSessionReadService } from '../../src/session-reading.js';
import { createUsageSnapshotStore } from '../../src/usage-snapshots.js';
import { createUsageAttributionService } from '../../src/usage-attribution.js';
import { createUsageAttributionJobs } from '../../src/usage-attribution-jobs.js';
import { createSessionPersonalModelService } from '../../src/session-personal-models.js';
import { createAnalyticsService } from '../../src/analytics.js';
import { createRetentionService } from '../../src/retention.js';
import { recentPeriod } from '../../src/recent-period.js';
import { queryOfficialUsage } from '../../src/official-usage.js';
import { createUsageSyncService } from '../../src/usage-sync.js';
import type { ProviderUsageItem } from '../../src/usage-provider.js';

const clock=()=>new Date('2026-09-24T12:00:00Z');
const period={from:'2026-09-22T16:00:00Z',to:'2026-09-24T16:00:00Z'};
async function fixture(t:TestContext,mixedSource=false){
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const identity=createIdentityService(db,{emailDomains:['example.invalid'],clock});const seed=await identity.bootstrap({email:'usage-detail-root@example.invalid',name:'出账详情超管'});const temp=await identity.login('usage-detail-root@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(temp.token,seed.temporaryPassword,'usage-detail-root-password');
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'usage-detail-owner@example.invalid','出账详情本人')",[user]);
 const issued=await identity.resetPassword(root.token,user,1);const initial=await identity.login('usage-detail-owner@example.invalid',issued.temporaryPassword);const own=await identity.changePassword(initial.token,issued.temporaryPassword,'usage-detail-owner-password');
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')",[installation,user,'d'.repeat(64)]);
 let session='';for(const [index,at] of ['2026-09-23T01:00:00Z','2026-09-24T01:00:00Z'].entries()){
  const put=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'detail-'+index,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:'hook-detail',payload:{prompt:'SYNTHETIC_PRIVATE_PROMPT'}},{admissionEpoch:1,receivedAt:clock()});assert.equal(put.outcome,'committed');if(put.outcome==='committed')session=put.sessionId;
 }
 const make=(id:string,tokens:string,start:number,custom=false):ProviderUsageItem=>({billing_session_id:id,provider_user_id:'detail-provider-person',email:'usage-detail-owner@example.invalid',start_time:String(start),client:custom?'':'ide',scene:'Chat',model_name:custom?'企业模型':'标准模型',model_type:'Chat',model_source:custom?'Custom':'Trae',consumption_source:custom?'enterprise_builtin':'basic',model_call_count:'1',departments:[],usage:{total_tokens:tokens,prompt_tokens:tokens,completion_tokens:'0',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:custom?null:'0.000000',amount_reason:custom?'not_priced':null,currency:'CNY',quality:[],token_basis:'provider_reported'});
 const store=createUsageSnapshotStore(db,{providerAccount:'detail-test',clock});
 async function publish(date:string,tokens:string,external?:string,missingCache=false){const draft=await store.begin(user,date);const query=draft.parts[0]!.query;const rows=[make('billing-detail',tokens,query.start_time+3600),make('unlinked','999',query.start_time+3600)];if(date==='2026-09-24')rows.push(make('billing-custom','50',query.start_time+3600,true),{...make('cue','20',query.start_time+3600),scene:'CUE'});if(mixedSource)rows.splice(0,rows.length,...(date==='2026-09-24'?[make('billing-built-in','22583',query.start_time+3600),make('billing-custom','26488',query.start_time+3660,true)]:[]));if(missingCache)rows[0]!.usage.cache_read_input_tokens=null;if(external)for(const row of rows)row.departments=[{id:external,name:'合成来源部门',full_path:'公司/合成部门'}];await store.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:rows.length,total_pages:1},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:'e'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);}
 await publish('2026-09-23','100');await publish('2026-09-24','150');
 const attribution=createUsageAttributionService(db,{providerAccount:'detail-test',clock,provider:{getSessionUsage:async hook=>({items:mixedSource?[make('billing-custom','26488',0,true)]:[make('billing-detail','9999',0),make('billing-custom','8888',0,true)],pagination:null,request_id:'probe-fixture',observed_at:clock().toISOString(),response_hash:'f'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}});await attribution.probe(session);
 return {db,identity,root,own,user,session,installation,attribution,publish,reader:createSessionReadService(db,identity,{clock,providerAccount:'detail-test'})};
}
test('authorized session usage joins unique evidence to current non-overlapping daily records without adding probe quantities',async t=>{
 const {reader,own,root,session,publish}=await fixture(t);const result=await reader.officialUsage(own.token,session,period);
 assert.equal(result.configured,true);assert.equal(result.attribution.state,'linked');assert.equal(result.attribution.linked_ids,2);assert.equal(result.coverage.expected_days,2);assert.equal(result.coverage.verified_days,2);
 assert.equal(result.groups.find(row=>row.model_source==='Trae')?.tokens,'250');assert.equal(result.groups.find(row=>row.model_source==='Custom')?.tokens,'50');assert.equal(result.groups.find(row=>row.model_source==='Custom')?.amount,null);assert.equal(result.groups.length,2);
 assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PROMPT'));assert.ok(!JSON.stringify(result).includes('unlinked'));
 assert.equal((await reader.officialUsage(root.token,session,period)).groups[0]?.tokens,result.groups[0]?.tokens);
 await publish('2026-09-24','120');assert.equal((await reader.officialUsage(own.token,session,period)).groups.find(row=>row.model_source==='Trae')?.tokens,'220');
 await publish('2026-09-24','9007199254740993');assert.equal((await reader.officialUsage(own.token,session,period)).groups.find(row=>row.model_source==='Trae')?.tokens,'9007199254741093');
 await assert.rejects(reader.officialUsage(own.token,session,{from:'2026-09-23T01:00:00Z',to:period.to}),{code:'official_period_precision'});
});

test('a mixed-source session remains coverage-unknown when the Hook query returns only its enterprise bill, even with every day verified',async t=>{
 const {reader,own,session}=await fixture(t,true);const result=await reader.officialUsage(own.token,session,period);
 assert.equal(result.attribution.state,'linked');assert.equal(result.attribution.linked_ids,1);
 assert.equal(result.coverage.verified_days,result.coverage.expected_days);
 assert.equal(result.groups.length,1);assert.equal(result.groups[0]?.tokens,'26488');
 assert.deepEqual(result.session_coverage,{state:'unknown',reason:'billing_id_inventory_unavailable'});
 const list=await reader.listMine(own.token,period);assert.equal(list.items[0]?.official_tokens,'26488');
 assert.deepEqual(list.items[0]?.session_coverage,{state:'unknown',reason:'billing_id_inventory_unavailable'});
});

test('pending retries and failed or empty probes retain known quantities and expose query and source revisions separately from coverage',async t=>{
 const {db,reader,own,session,publish}=await fixture(t);const before=await reader.officialUsage(own.token,session,period);
 assert.equal(before.attribution.pending,false);assert.equal(before.attribution.requested_at,clock().toISOString());
 assert.equal(before.attribution.probe_revision,1);assert.match(before.coverage.revision??'',/^[a-f0-9]{32}$/);
 await createUsageAttributionJobs(db,{providerAccount:'detail-test',clock}).enqueue(session);
 assert.equal((await reader.officialUsage(own.token,session,period)).attribution.pending,true);
 const empty=createUsageAttributionService(db,{providerAccount:'detail-test',clock,provider:{getSessionUsage:async hook=>({items:[],pagination:null,request_id:'synthetic-empty',observed_at:clock().toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}});
 await empty.probe(session);const afterEmpty=await reader.officialUsage(own.token,session,period);
 assert.equal(afterEmpty.attribution.probe_state,'empty');assert.equal(afterEmpty.attribution.probe_revision,2);assert.equal(afterEmpty.groups.find(row=>row.model_source==='Trae')?.tokens,'250');assert.equal(afterEmpty.session_coverage.state,'unknown');
 const failed=createUsageAttributionService(db,{providerAccount:'detail-test',clock,provider:{getSessionUsage:async()=>{throw new Error('synthetic source unavailable');}}});
 await assert.rejects(failed.probe(session));const afterFailure=await reader.officialUsage(own.token,session,period);
 assert.equal(afterFailure.attribution.probe_state,'failed');assert.equal(afterFailure.attribution.probe_revision,3);assert.equal(afterFailure.groups.find(row=>row.model_source==='Trae')?.tokens,'250');
 assert.equal(afterFailure.coverage.revision,before.coverage.revision);
 await publish('2026-09-24','120');const revised=await reader.officialUsage(own.token,session,period);
 assert.notEqual(revised.coverage.revision,before.coverage.revision);assert.equal(revised.groups.find(row=>row.model_source==='Trae')?.tokens,'220');assert.equal(revised.session_coverage.state,'unknown');
});

for(const affected of [false,true])test(`logical cleanup ${affected?'inside':'outside'} the source window updates coverage independently of the historical probe`,async t=>{
 const {db,identity,reader,root,own,user,session,installation}=await fixture(t);const before=await reader.officialUsage(own.token,session,period);
 const directory=await mkdtemp(join(tmpdir(),'adi-coverage-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const cleanup=createCleanupService(db,identity,{clock,journal:createCleanupJournal(directory)});
 const range={user_id:user,from:affected?'2026-09-23T01:00:00Z':'2026-09-20T01:00:00Z',to:affected?'2026-09-23T02:00:00Z':'2026-09-20T02:00:00Z'};
 if(!affected)assert.equal((await db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),occurred_at:'2026-09-20T01:30:00Z',event_type:'UserPromptSubmit',source_session_id:'outside-official-window',payload:{prompt:'SYNTHETIC_OUTSIDE_WINDOW_CLEANUP'}},{admissionEpoch:1,receivedAt:clock()})).outcome,'committed');
 const preview=await cleanup.preview(root.token,range);await submitCleanupConfirmed(cleanup,root.token,{...range,preview_id:preview.preview_id,confirmation_email:preview.target.email},randomUUID());
 // Do not run the worker: logical hiding must already be reflected in the read.
 const after=await reader.officialUsage(own.token,session,period);
 assert.equal(after.session_coverage.state,'unknown');
 if(affected){assert.equal(after.coverage.invalidated_days,1);assert.notEqual(after.coverage.revision,before.coverage.revision);assert.equal(after.groups.length,0);}
 else{assert.equal(after.coverage.invalidated_days,0);assert.equal(after.coverage.revision,before.coverage.revision);assert.equal(after.groups.find(row=>row.model_source==='Trae')?.tokens,'250');}
 assert.equal(after.attribution.probe_state,'observed','the historical query result is independent of current source validity');
});

test('manager roles do not grant another persons session usage, and competing links or cleanup cannot inflate totals',async t=>{
 const {db,reader,identity,root,own,user,session,attribution}=await fixture(t);const other=randomUUID(),department=randomUUID();
 await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'usage-detail-other@example.invalid','另一成员')",[other]);await db.query("INSERT INTO departments(id,name) VALUES($1,'详情权限部门')",[department]);
 const issued=await identity.resetPassword(root.token,other,1);const temp=await identity.login('usage-detail-other@example.invalid',issued.temporaryPassword);const outsider=await identity.changePassword(temp.token,issued.temporaryPassword,'usage-detail-other-password');
 await assert.rejects(reader.officialUsage(outsider.token,session,period),{code:'not_found'});
 await db.query("INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,'department_admin',$2,'2026-09-01Z')",[other,department]);await assert.rejects(reader.officialUsage(outsider.token,session,period),{code:'not_found'});
 await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'anc_admin','2026-09-01Z')",[other]);await assert.rejects(reader.officialUsage(outsider.token,session,period),{code:'not_found'});
 const competing=randomUUID();await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'competing-hook','2026-09-23Z','2026-09-24Z')",[competing,user]);await attribution.probe(competing);
 const conflicted=await reader.officialUsage(own.token,session,period);assert.equal(conflicted.attribution.state,'conflict');assert.equal(conflicted.attribution.conflicting_ids,2);assert.equal(conflicted.groups.length,0);
 const listed=await reader.listMine(own.token,{...period,search:'hook-detail'});
 assert.equal(listed.total,1,'the competing claim has no visible Hook and is outside the matched list');
 assert.equal(listed.items[0]?.id,session);assert.equal(listed.items[0]?.attribution_conflicts,2);
 assert.equal(listed.items[0]?.official_records,0);assert.equal(listed.items[0]?.official_tokens,null);
 assert.equal((await reader.listMine(own.token,{...period,search:'hook-detail',channel:'official'})).total,0,
  'filtering sessions must not turn an out-of-list competing claim into a unique association');
 await db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[user]);await client.query("INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,'2026-09-24T01:00:00Z','2026-09-24T02:00:00Z',1)",[user]);});
 const cleared=await reader.officialUsage(own.token,session,period);assert.equal(cleared.groups.length,0);assert.equal(cleared.coverage.invalidated_days,1);assert.equal(cleared.attribution.linked_ids,0);
});

test('an attribution conflict committed during a session report invalidates that response',async t=>{
 const {db,reader,own,user,session,attribution}=await fixture(t);const competing=randomUUID();await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,'racing-hook','2026-09-23Z','2026-09-24Z')",[competing,user]);
 let unlock!:()=>void;let acquired!:()=>void;const release=new Promise<void>(resolve=>{unlock=resolve;});const ready=new Promise<void>(resolve=>{acquired=resolve;});
 const blocker=db.transaction(async client=>{await client.query('LOCK TABLE usage_observations IN ACCESS EXCLUSIVE MODE');acquired();await release;});await ready;
 const pending=reader.officialUsage(own.token,session,period);const rejected=assert.rejects(pending,{code:'content_changed'});
 try{
  let waiting=false;const deadline=Date.now()+2000;while(Date.now()<deadline){waiting=!!(await db.query("SELECT 1 FROM pg_locks WHERE relation='usage_observations'::regclass AND mode='AccessShareLock' AND NOT granted")).rowCount;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(waiting,true,'the public report must have reached the held database read');await attribution.probe(competing);
 }finally{unlock();await blocker;}
 await rejected;
});

test('suspending or logically deleting an account stops access and probes but preserves its historical official session usage for superadmins',async t=>{
 const {db,identity,reader,root,own,user,session,attribution}=await fixture(t);const admin=createAdministrationService(db,identity,{clock});
 for(const status of ['suspended','deleted'] as const){
  const account=await admin.getAccount(root.token,user);await admin.setStatus(root.token,user,{version:account.version,status,reason:'合成生命周期验证'});
  assert.equal(await identity.resolve(own.token),null);await assert.rejects(attribution.probe(session),{code:'account_inactive'});
  const history=await reader.officialUsage(root.token,session,period);assert.equal(history.groups.find(row=>row.model_source==='Trae')?.tokens,'250');assert.equal(history.attribution.linked_ids,2);
  const listed=await reader.listAll(root.token,{...period,user_id:user,channel:'official'});
  assert.equal(listed.total,1);assert.equal(listed.items[0]?.id,session);assert.equal(listed.items[0]?.official_records,3);
  assert.equal(listed.items[0]?.official_tokens,history.groups.reduce((sum,row)=>sum+BigInt(row.tokens!),0n).toString());
  await assert.rejects(reader.officialUsage(own.token,session,period),{code:'unauthenticated'});
  await assert.rejects(reader.listMine(own.token,period),{code:'unauthenticated'});
  assert.equal((await attribution.read(session)).links.length,0,'generic worker diagnostics keep their current-state isolation');
 }
 const deleted=await admin.getAccount(root.token,user);await admin.setStatus(root.token,user,{version:deleted.version,status:'active',reason:'恢复同一身份'});
 const restored=await identity.login('usage-detail-owner@example.invalid','usage-detail-owner-password');assert.equal((await reader.officialUsage(restored.token,session,period)).groups.find(row=>row.model_source==='Trae')?.tokens,'250');
});

test('normal annual maintenance preserves all four recent-45-day readings before physical cleanup begins',async t=>{
 const {db,identity,reader,own,session}=await fixture(t);
 const recent=recentPeriod({},clock(),45),analytics=createAnalyticsService(db,identity,{clock,providerAccount:'detail-test'});
 const read=async()=>({
  official:await analytics.officialUsage(own.token,{...recent,scope:'self'}),
  models:await analytics.models(own.token,{...recent,scope:'self'}),
  list:await reader.listMine(own.token,recent),
  detail:await reader.officialUsage(own.token,session,recent),
 });
 const counts=async()=>(await db.query<{hooks:string;observations:string}>(
  'SELECT (SELECT count(*)::text FROM hook_events) AS hooks,(SELECT count(*)::text FROM usage_observations) AS observations')).rows[0]!;
 const before=await read(),beforeCounts=await counts();
 assert.ok(before.official.groups.length>0);assert.ok(before.models.items.length>0);
 assert.equal(before.list.items[0]?.official_tokens,'300');
 assert.equal(before.detail.groups.reduce((sum,row)=>sum+BigInt(row.tokens!),0n),300n);
 const retention=createRetentionService(db,{clock});assert.equal((await retention.status()).phase,'idle');
 assert.equal(await retention.runOne(),true);
 const status=await retention.status(),expected=new Date(clock().getTime()-365*86400000).toISOString();
 assert.equal(status.phase,'partitions');assert.equal(status.cutoff?.toISOString(),expected);assert.deepEqual(status.progress,{});
 assert.equal((await db.query<{retention_cutoff:Date}>('SELECT retention_cutoff FROM data_identity')).rows[0]!.retention_cutoff.toISOString(),expected);
 assert.deepEqual(await counts(),beforeCounts,'the first maintenance step must not have physically removed source rows');
 assert.deepEqual(await read(),before,'normal annual cutoff advancement must preserve each recent-45-day projection');
});

test('fault characterization: a severely advanced maintenance clock followed by API clock rollback retains session quantities until cleanup',async t=>{
 const {db,identity,reader,own,session}=await fixture(t);
 const analytics=createAnalyticsService(db,identity,{clock,providerAccount:'detail-test'});
 const officialBefore=await analytics.officialUsage(own.token,{...period,scope:'self'});
 const modelsBefore=await analytics.models(own.token,{...period,scope:'self'});
 assert.equal(officialBefore.groups.reduce((sum,row)=>sum+BigInt(row.known_tokens),0n),2318n);
 const before=await reader.officialUsage(own.token,session,period);
 assert.equal((await reader.listMine(own.token,period)).items[0]?.official_tokens,'300');
 const cutoff=new Date('2026-09-23T12:00:00Z');
 const faultyClock=()=>new Date(cutoff.getTime()+365*86400000);
 const retention=createRetentionService(db,{clock:faultyClock});assert.equal((await retention.status()).phase,'idle');
 assert.equal(await retention.runOne(),true);const status=await retention.status();
 assert.equal(status.phase,'partitions');assert.equal(status.cutoff?.toISOString(),cutoff.toISOString());
 // Fault injection only: maintenance ran 364 days ahead, then these readers use
 // the original API clock as after a rollback. This is not normal annual
 // maintenance and does not approve the differing cutoff policy as a guarantee.
 const official=await analytics.officialUsage(own.token,{...period,scope:'self'});
 const models=await analytics.models(own.token,{...period,scope:'self'});
 assert.equal(official.groups.reduce((sum,row)=>sum+BigInt(row.known_tokens),0n),1219n,
  'the official summary hides the source day crossing the fault-induced cutoff');
 assert.deepEqual(models.items,modelsBefore.items);assert.deepEqual(models.trend,modelsBefore.trend);
 assert.equal(models.items.reduce((sum,row)=>sum+BigInt(row.tokens!),0n),2248n);
 const detail=await reader.officialUsage(own.token,session,period);
 const listed=await reader.listMine(own.token,{...period,channel:'official'});
 assert.deepEqual(detail.groups,before.groups);assert.deepEqual(detail.coverage,before.coverage);
 assert.equal(listed.total,1);assert.equal(listed.items[0]?.official_records,3);
 assert.equal(listed.items[0]?.official_tokens,'300');assert.equal(listed.items[0]?.id,session);
});

test('session filters distinguish official records, queued synchronization and unknown without treating enterprise Custom as personal configuration',async t=>{
 const {db,reader,own,root,user,session,installation}=await fixture(t);const ids:string[]=[];
 for(const [index,key] of ['pending-hook','unknown-hook'].entries()){
  const put=await db.ingest({schema_version:2,installation_id:installation,client_event_id:key,occurred_at:`2026-09-24T02:00:0${index}Z`,event_type:'UserPromptSubmit',source_session_id:key,payload:{prompt:key}},{admissionEpoch:1,receivedAt:clock()});assert.equal(put.outcome,'committed');if(put.outcome==='committed')ids.push(put.sessionId);
 }
 await createUsageAttributionJobs(db,{providerAccount:'detail-test',clock}).enqueue(ids[0]!);
 const official=await reader.listMine(own.token,{...period,channel:'official'});assert.equal(official.channel_available,true);assert.equal(official.total,1);assert.equal(official.items[0]?.id,session);assert.equal(official.items[0]?.official_tokens,'300');assert.equal(official.items[0]?.model_count,2);
 const pending=await reader.listMine(own.token,{...period,channel:'pending'});assert.equal(pending.total,1);assert.equal(pending.items[0]?.id,ids[0]);
 const all=await reader.listMine(own.token,period);assert.equal(all.total,3);assert.equal(all.items.find(row=>row.id===ids[1])?.channel,'unknown');
 assert.equal((await reader.listMine(own.token,{...period,channel:'custom'})).total,0);
 assert.equal((await reader.listAll(root.token,{...period,channel:'official'})).total,1);
 const yesterday=await reader.listMine(own.token,{from:period.from,to:'2026-09-23T16:00:00Z',channel:'official'});assert.equal(yesterday.items[0]?.official_tokens,'100');
 const subday=await reader.listMine(own.token,{from:'2026-09-24T00:00:00Z',to:period.to});assert.equal(subday.channel_available,false);assert.ok(subday.items.every(row=>row.official_tokens===null));
 const earlier=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'earlier-unknown',occurred_at:'2026-09-23T01:00:00Z',event_type:'UserPromptSubmit',source_session_id:'earlier-unknown',payload:{prompt:'较早未知会话'}},{admissionEpoch:1,receivedAt:clock()});assert.equal(earlier.outcome,'committed');
 await createUsageSyncService(db,{providerAccount:'detail-test',clock}).enqueue(user,'2026-09-24');const queued=await reader.listMine(own.token,{...period,channel:'pending'});assert.equal(queued.total,2);assert.deepEqual(new Set(queued.items.map(row=>row.id)),new Set(ids),'a different business days job must not classify an older unknown session as pending');
});

test('only the owner can confirm or revoke personal models, and mixed sessions keep official quantities separate',async t=>{
 const {db,identity,reader,root,own,user,session}=await fixture(t);const models=createSessionPersonalModelService(db,identity,{clock});const initial=await models.read(own.token,session);
 assert.equal(initial.can_edit,true);assert.deepEqual(initial.models,[]);assert.equal((await models.read(root.token,session)).can_edit,false);
 await assert.rejects(models.replace(root.token,session,{version:initial.version,cleanup_generation:initial.cleanup_generation,models:['个人模型']}),{code:'forbidden'});
 const confirmed=await models.replace(own.token,session,{version:initial.version,cleanup_generation:initial.cleanup_generation,models:[' DeepSeek-V3 ','DeepSeek-V3','私有模型']});
 assert.equal(confirmed.source,'user_declared');assert.equal(confirmed.scope,'session');assert.deepEqual(confirmed.models,['DeepSeek-V3','私有模型']);
 const official=await reader.listMine(own.token,{...period,channel:'official'});const custom=await reader.listMine(own.token,{...period,channel:'custom'});
 assert.equal(official.items[0]?.channel,'mixed');assert.equal(custom.items[0]?.id,session);assert.equal(custom.items[0]?.official_tokens,'300');assert.deepEqual(custom.items[0]?.personal_models,['DeepSeek-V3','私有模型']);
 await assert.rejects(models.replace(own.token,session,{version:initial.version,cleanup_generation:initial.cleanup_generation,models:[]}),{code:'version_conflict'});
 const revoked=await models.replace(own.token,session,{version:confirmed.version,cleanup_generation:confirmed.cleanup_generation,models:[]});assert.deepEqual(revoked.models,[]);assert.equal((await reader.listMine(own.token,{...period,channel:'custom'})).total,0);
 await db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[user]);await assert.rejects(models.replace(own.token,session,{version:revoked.version,cleanup_generation:revoked.cleanup_generation,models:['旧页面提交']}),{code:'content_changed'});
});

test('department-filtered session lists use local history without official mappings and do not duplicate cross-transfer bills',async t=>{
 const {db,reader,root,user,session,installation,publish}=await fixture(t);
 await db.ensurePartitions(new Date('2026-08-01Z'),new Date('2026-09-01Z'));
 await db.ingest({schema_version:2,installation_id:installation,client_event_id:'old-start',occurred_at:'2026-08-01T01:00:00Z',event_type:'UserPromptSubmit',source_session_id:'hook-detail',payload:{prompt:'合成旧会话'}},{admissionEpoch:1,receivedAt:clock()});
 const a=randomUUID(),b=randomUUID();await db.query("INSERT INTO departments(id,name) VALUES($1,'列表A部门'),($2,'列表B部门')",[a,b]);
 await db.query("INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,'2026-09-01Z','2026-09-23T16:00:00Z'),($1,$3,'2026-09-23T16:00:00Z',NULL)",[user,a,b]);
 await db.query("UPDATE hook_events SET department_id=CASE WHEN occurred_at<'2026-09-23T16:00:00Z' THEN $2::uuid ELSE $3::uuid END WHERE session_id=$1",[session,a,b]);
 await publish('2026-09-23','100','unmapped-official');await publish('2026-09-24','150','unmapped-official');
 assert.equal((await reader.listAll(root.token,{...period,department_id:a,channel:'official'})).items[0]?.official_tokens,'100');
 const later={from:'2026-09-23T16:00:00Z',to:period.to};
 const listB=await reader.listAll(root.token,{...later,department_id:b,channel:'official'});
 assert.equal(listB.items[0]?.id,session,'a session created yesterday still appears when it is active today');
 assert.equal(listB.items[0]?.official_tokens,'200');
 assert.equal((await queryOfficialUsage(db,'detail-test',later,{userId:user,departmentIds:[b]},clock())).reconciliation?.total.tokens,'1199','unlinked bills still belong to the local department');
 // Moving a membership boundary inside the aggregate must not assign either side.
 await db.query("UPDATE membership_periods SET valid_from='2026-09-24T00:00:00Z' WHERE user_id=$1 AND department_id=$2",[user,b]);
 await db.query("UPDATE membership_periods SET valid_to='2026-09-24T00:00:00Z' WHERE user_id=$1 AND department_id=$2",[user,a]);
 const uncertain=await reader.listAll(root.token,{...later,department_id:b,channel:'official'});
 assert.equal(uncertain.items[0]?.official_tokens,null);
 assert.equal(uncertain.items[0]?.department_unassigned_records,2);
 const personal=await queryOfficialUsage(db,'detail-test',later,{userId:user,departmentIds:null},clock());
 assert.equal(personal.reconciliation?.total.tokens,'1199');assert.equal(personal.unassigned_records,4);
 assert.equal((await queryOfficialUsage(db,'detail-test',later,{userId:user,departmentIds:[b]},clock())).groups.length,0);
 assert.equal((await reader.listAll(root.token,{...later})).items[0]?.official_tokens,'200');
});

test('personal declarations and source revisions invalidate list cursors instead of silently changing later pages',async t=>{
 const {db,reader,identity,own,session,installation,publish,attribution}=await fixture(t);
 await db.ingest({schema_version:2,installation_id:installation,client_event_id:'page-extra',occurred_at:'2026-09-24T02:00:00Z',event_type:'UserPromptSubmit',source_session_id:'page-extra',payload:{prompt:'分页额外会话'}},{admissionEpoch:1,receivedAt:clock()});
 const first=await reader.listMine(own.token,{...period,limit:1});assert.ok(first.next_cursor);const second=await reader.listMine(own.token,{...period,limit:1,cursor:first.next_cursor!});assert.notEqual(first.items[0]?.id,second.items[0]?.id);
 await attribution.probe(session);assert.equal((await reader.listMine(own.token,{...period,limit:1,cursor:first.next_cursor!})).items[0]?.id,second.items[0]?.id,'an unchanged evidence refresh must not invalidate the list cursor');
 const models=createSessionPersonalModelService(db,identity,{clock});const state=await models.read(own.token,session);await models.replace(own.token,session,{version:state.version,cleanup_generation:state.cleanup_generation,models:['声明模型']});
 await assert.rejects(reader.listMine(own.token,{...period,limit:1,cursor:first.next_cursor!}),{code:'invalid_cursor'});
 const fresh=await reader.listMine(own.token,{...period,limit:1});await publish('2026-09-24','160');await assert.rejects(reader.listMine(own.token,{...period,limit:1,cursor:fresh.next_cursor!}),{code:'invalid_cursor'});
});

test('local membership changes invalidate session pagination and the department warning never hides known personal tokens',async t=>{
 const {db,identity,reader,root,own,user,installation,session}=await fixture(t);
 const {createOrganizationService}=await import('../../src/organization.js');
 const a=randomUUID(),b=randomUUID();await db.query("INSERT INTO departments(id,name) VALUES($1,'分页旧部门'),($2,'分页新部门')",[a,b]);
 await db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,'2026-09-01Z')",[user,a]);
 await db.ingest({schema_version:2,installation_id:installation,client_event_id:'membership-page',occurred_at:'2026-09-24T02:00:00Z',event_type:'UserPromptSubmit',source_session_id:'membership-page',payload:{prompt:'合成分页事件'}},{admissionEpoch:1,receivedAt:clock()});
 const before=await reader.listMine(own.token,{...period,limit:1});assert.ok(before.next_cursor);
 const version=(await db.query<{version:number}>('SELECT version FROM users WHERE id=$1',[user])).rows[0]!.version;
 await createOrganizationService(db,identity,{clock}).transferMember(root.token,user,{target_department_id:b,version});
 await assert.rejects(reader.listMine(own.token,{...period,limit:1,cursor:before.next_cursor!}),{code:'invalid_cursor'});
 await db.query('DELETE FROM membership_periods WHERE user_id=$1',[user]);
 const personal=(await reader.listMine(own.token,period)).items.find(row=>row.id===session)!;
 assert.equal(personal.channel,'official');assert.equal(personal.official_tokens,'300');assert.equal(personal.department_unassigned_records,3);
});

async function timeCandidateFixture(t:TestContext,variants:Partial<ProviderUsageItem>[]=[{}]){
 const f=await fixture(t,true);const {createSessionDerivationService}=await import('../../src/session-derivation.js');
 const worker=createSessionDerivationService(f.db,{clock});while(await worker.runOne(f.session)){/* publish observed prompt windows */}
 const store=createUsageSnapshotStore(f.db,{providerAccount:'detail-test',clock}),draft=await store.begin(f.user,'2026-09-24'),query=draft.parts[0]!.query;
 const row:ProviderUsageItem={billing_session_id:'builtin-candidate',provider_user_id:'detail-provider-person',email:'usage-detail-owner@example.invalid',start_time:String(Date.parse('2026-09-24T01:00:00Z')/1000),client:'ide',scene:'Chat',model_name:'MiniMax-M3',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:'120',completion_tokens:'3',total_tokens:'123',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:'CNY',quality:[],token_basis:'provider_reported'};
 const rows=variants.map(v=>({...row,...v}));
 await store.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:rows.length,total_pages:1},request_id:'candidate-fixture',observed_at:clock().toISOString(),response_hash:'c'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);
 return f;
}

test('a unique second-level built-in candidate is displayed separately and never changes verified session totals',async t=>{
 const f=await timeCandidateFixture(t);
 const result=await f.reader.officialUsage(f.own.token,f.session,period);
 assert.equal(result.time_candidates.state,'available');assert.equal(result.time_candidates.items.length,1);
 assert.equal(result.time_candidates.items[0]?.billing_session_id,'builtin-candidate');assert.equal(result.time_candidates.items[0]?.relation,'time_inferred');assert.equal(result.time_candidates.items[0]?.tokens,'123');
 assert.equal(result.groups.length,0,'candidate quantities are not verified session totals');assert.equal(result.attribution.linked_ids,1,'only the original enterprise Hook relation exists');assert.equal(result.session_coverage.state,'unknown');
 const listed=await f.reader.listMine(f.own.token,period);assert.equal(listed.total,1);
 assert.equal(listed.items[0]?.official_records,0);assert.equal(listed.items[0]?.official_tokens,null);assert.equal(listed.items[0]?.model_count,0);
 assert.equal((await f.reader.listMine(f.own.token,{...period,channel:'official'})).total,0,'time candidates never enter the verified official list');
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_PROMPT/);
 const ledger=await queryOfficialUsage(f.db,'detail-test',period,{userId:f.user,departmentIds:null},clock());assert.equal(ledger.reconciliation?.unattributed.tokens,'123');
});

test('multiple billing IDs in one observed second remain ambiguous rather than selecting the closest record',async t=>{
 const f=await timeCandidateFixture(t,[{billing_session_id:'candidate-a'},{billing_session_id:'candidate-b'}]);
 const result=await f.reader.officialUsage(f.own.token,f.session,period);assert.equal(result.time_candidates.items.length,2);
 assert.ok(result.time_candidates.items.every(row=>row.relation==='ambiguous'&&row.reason==='multiple_bills_in_window'));assert.equal(result.groups.length,0);
});

test('a competing observed Hook session prevents automatic time association even before its projection is ready',async t=>{
 const f=await timeCandidateFixture(t);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'competing-prompt',source_session_id:'other-hook',event_type:'UserPromptSubmit',occurred_at:'2026-09-24T01:00:00.500Z',payload:{prompt:'OTHER_PRIVATE_TEXT'}},{admissionEpoch:1,receivedAt:clock()});
 const result=await f.reader.officialUsage(f.own.token,f.session,period);assert.equal(result.time_candidates.items[0]?.relation,'ambiguous');assert.equal(result.time_candidates.items[0]?.reason,'competing_hook_sessions');assert.doesNotMatch(JSON.stringify(result),/OTHER_PRIVATE_TEXT|other-hook/);
});

test('time candidates respect second boundaries and are replaced by revised source observations',async t=>{
 const outside=await timeCandidateFixture(t,[{start_time:String(Date.parse('2026-09-24T01:00:01Z')/1000)}]);
 assert.equal((await outside.reader.officialUsage(outside.own.token,outside.session,period)).time_candidates.state,'none');
 const f=await timeCandidateFixture(t);assert.equal((await f.reader.officialUsage(f.own.token,f.session,period)).time_candidates.items.length,1);
 await f.publish('2026-09-24','120');const revised=await f.reader.officialUsage(f.own.token,f.session,period);assert.equal(revised.time_candidates.items.length,0);assert.equal(revised.groups[0]?.tokens,'26488');
});

test('logical cleanup hides time candidates before the cleanup worker removes any rows',async t=>{
 const f=await timeCandidateFixture(t);assert.equal((await f.reader.officialUsage(f.own.token,f.session,period)).time_candidates.items.length,1);
 const directory=await mkdtemp(join(tmpdir(),'adi-time-candidate-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const cleanup=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory)}),range={user_id:f.user,from:'2026-09-24T01:00:00Z',to:'2026-09-24T02:00:00Z'};
 const preview=await cleanup.preview(f.root.token,range);await submitCleanupConfirmed(cleanup,f.root.token,{...range,preview_id:preview.preview_id,confirmation_email:preview.target.email},randomUUID());
 const result=await f.reader.officialUsage(f.own.token,f.session,period);assert.equal(result.time_candidates.state,'unavailable');assert.equal(result.time_candidates.items.length,0);assert.doesNotMatch(JSON.stringify(result),/builtin-candidate/);
});

test('a competing Hook spanning the queried dates stays ambiguous without an event inside that date slice',async t=>{
 const f=await timeCandidateFixture(t);
 for(const [i,at] of ['2026-09-22T15:00:00Z','2026-09-24T17:00:00Z'].entries())await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'spanning-'+i,source_session_id:'spanning-hook',event_type:i?'PostToolUse':'PreToolUse',occurred_at:at,payload:{tool_use_id:'long-call',tool_name:'Read'}},{admissionEpoch:1,receivedAt:new Date('2026-09-24T18:00:00Z')});
 const result=await f.reader.officialUsage(f.own.token,f.session,period);assert.equal(result.time_candidates.items[0]?.relation,'ambiguous');assert.equal(result.time_candidates.items[0]?.reason,'competing_hook_sessions');
});

test('day and associated-session projections expose independent official quantities and missing cache counts',async t=>{
 const f=await fixture(t);await f.publish('2026-09-24','150',undefined,true);
 const result=await f.reader.officialUsage(f.own.token,f.session,period),builtIn=result.groups.find(row=>row.model_source==='Trae')!,custom=result.groups.find(row=>row.model_source==='Custom')!;
 assert.ok(builtIn.token_breakdown);assert.ok(custom.token_breakdown);
 assert.equal(builtIn.token_breakdown.input.tokens,'250');assert.equal(builtIn.token_breakdown.output.tokens,'0');
 assert.deepEqual(builtIn.token_breakdown.cache_read,{tokens:null,known_tokens:'0',missing_token_records:1});assert.equal(builtIn.token_breakdown.cache_creation.tokens,'0');
 assert.equal(custom.token_breakdown.input.tokens,'50');assert.equal(custom.token_breakdown.cache_read.tokens,'0');
 const day=await queryOfficialUsage(f.db,'detail-test',period,{userId:f.user,departmentIds:null},clock());
 const group=day.groups.find(row=>row.model_source==='Trae'&&row.scene==='Chat')!;
 assert.equal(group.token_breakdown.input.tokens,'2248');assert.equal(group.token_breakdown.output.tokens,'0');assert.equal(group.token_breakdown.cache_read.tokens,null);assert.equal(group.token_breakdown.cache_read.missing_token_records,1);
});
