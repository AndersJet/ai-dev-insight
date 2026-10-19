import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createIdentityService} from '../../src/identity.js';
import {createAnalyticsService} from '../../src/analytics.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';
import {createUsageAttributionService} from '../../src/usage-attribution.js';
import {createSessionReadService} from '../../src/session-reading.js';
import type {ProviderUsageItem} from '../../src/usage-provider.js';

test('dense relation accounting stays within the normal database deadline without dropping or duplicating official records',{timeout:30000},async t=>{
 const db=await testDatabase(t);await db.migrate();const now=new Date(),midnight=Math.floor((now.getTime()+28800000)/86400000)*86400000-28800000;
 const from=new Date(midnight-86400000),to=new Date(midnight),date=new Date(from.getTime()+28800000).toISOString().slice(0,10);
 const identity=createIdentityService(db,{emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'dense@example.invalid',name:'密集关联合成测试'});const temp=await identity.login('dense@example.invalid',seed.temporaryPassword);const own=await identity.changePassword(temp.token,seed.temporaryPassword,'dense-synthetic-password');
 const user=own.user.user_id,store=createUsageSnapshotStore(db,{providerAccount:'dense-test'}),draft=await store.begin(user,date),query=draft.parts[0]!.query;
 const rows:ProviderUsageItem[]=Array.from({length:10000},(_,index)=>({billing_session_id:`dense-bill-${index}`,provider_user_id:'dense-person',email:'dense@example.invalid',start_time:String(query.start_time+1),scene:'Chat',client:'ide',model_name:'Synthetic',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:'8',completion_tokens:'2',total_tokens:'10',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'}));
 for(let page=1;page<=50;page++)await store.stage(draft,0,{items:rows.slice((page-1)*200,page*200),pagination:{page,page_size:200,total:10000,total_pages:50},request_id:'synthetic',observed_at:now.toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...query,page}}});await store.publish(draft);
 await db.ensurePartitions(from,to);const installation=randomUUID();
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'密集会话合成安装')",[installation,user,'d'.repeat(64)]);
 const sessions:string[]=[];for(let index=0;index<2;index++){
  const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`dense-${index}`,source_session_id:`dense-${index}`,event_type:'UserPromptSubmit',occurred_at:from.toISOString(),payload:{prompt:'SYNTHETIC_DENSE_PROMPT'}},{admissionEpoch:1,receivedAt:now});
  assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('Dense session fixture must persist');sessions.push(saved.sessionId);
 }
 const links=createUsageAttributionService(db,{providerAccount:'dense-test',provider:{getSessionUsage:async hook=>({items:hook==='dense-0'?rows.slice(0,5000):rows.slice(5000),pagination:null,request_id:'synthetic',observed_at:now.toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}});for(const session of sessions)await links.probe(session);
 for(const table of ['users','sessions','usage_scopes','usage_snapshot_runs','usage_snapshot_parts','usage_observations','usage_attribution_evidence','usage_provider_identities'])await db.query(`ANALYZE ${table}`);
 const result=await createAnalyticsService(db,identity,{providerAccount:'dense-test'}).officialUsage(own.token,{scope:'self',from:from.toISOString(),to:to.toISOString()});
 assert.equal(result.reconciliation?.total.records,10000);assert.equal(result.reconciliation?.total.tokens,'100000');assert.equal(result.reconciliation?.attributed.tokens,'100000');assert.equal(result.reconciliation?.unattributed.records,0);assert.equal(result.reconciliation?.conflicting.records,0);assert.equal(result.reconciliation?.session_completeness,'unknown');assert.doesNotMatch(JSON.stringify(result),/dense-bill-/);
 // Both projections now share the person/day read set. Exercise the model
 // projection at the same scale, including its optional membership allocation,
 // under the storage adapter's normal statement deadline (no timeout override).
 const department=randomUUID();await db.query("INSERT INTO departments(id,name) VALUES($1,'密集账项本地部门')",[department]);
 await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)',[user,department,from]);
 const analytics=createAnalyticsService(db,identity,{providerAccount:'dense-test'});
 for(const scope of [{scope:'self' as const},{scope:'organization' as const,department_id:department}]){
  const models=await analytics.models(own.token,{...scope,from:from.toISOString(),to:to.toISOString()});
  assert.equal(models.total,1);assert.equal(models.items[0]?.records,10000);assert.equal(models.items[0]?.tokens,'100000');
  assert.equal(models.trend[0]?.tokens,'100000');assert.equal(models.coverage.verified_user_days,1);assert.doesNotMatch(JSON.stringify(models),/dense-bill-/);
 }
 const reader=createSessionReadService(db,identity,{providerAccount:'dense-test'}),period={from:from.toISOString(),to:to.toISOString()};
 const listed=await reader.listMine(own.token,{...period,channel:'official'});
 assert.equal(listed.total,2);assert.equal(listed.items.reduce((sum,row)=>sum+row.official_records,0),10000);
 assert.equal(listed.items.reduce((sum,row)=>sum+BigInt(row.official_tokens!),0n),100000n);
 for(const session of sessions){
  const detail=await reader.officialUsage(own.token,session,period);
  assert.equal(detail.attribution.linked_ids,5000);assert.equal(detail.attribution.conflicting_ids,0);
  assert.equal(detail.groups.reduce((sum,row)=>sum+row.records,0),5000);
  assert.equal(detail.groups.reduce((sum,row)=>sum+BigInt(row.tokens!),0n),50000n);
  assert.doesNotMatch(JSON.stringify(detail),/dense-bill-|SYNTHETIC_DENSE_PROMPT/);
 }
});
