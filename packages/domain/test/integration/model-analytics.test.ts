import {test,type TestContext} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../storage/test/helpers.js';import {createIdentityService} from '../../src/identity.js';import {createAnalyticsService} from '../../src/analytics.js';import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';import type {ProviderUsageItem} from '../../src/usage-provider.js';
import {createSessionPersonalModelService} from '../../src/session-personal-models.js';
const clock=()=>new Date('2026-09-24T12:00:00Z');const period={from:'2026-09-21T16:00:00Z',to:'2026-09-24T16:00:00Z'};
test('member model and official summaries exclude other people even inside the same department',async t=>{
 const f=await fixture(t);const other=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'other-models@example.invalid','另一个模型人员')",[other]);await f.db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,'2026-09-01Z')",[other,f.a]);
 const original=(await f.store.readCurrent(f.user,'2026-09-23')).items.find(row=>row.scene==='Chat'&&row.model_name==='Model A')!;const row:ProviderUsageItem={...original,email:'other-models@example.invalid',provider_user_id:'OTHER_PROVIDER',billing_session_id:'OTHER_BILL',model_name:'PRIVATE_OTHER_MODEL',usage:{...original.usage,prompt_tokens:'10000',total_tokens:'10000'}};
 const draft=await f.store.begin(other,'2026-09-23');await f.store.stage(draft,0,{items:[row],pagination:{page:1,page_size:200,total:1,total_pages:1},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'user_usage_detail',parameters:draft.parts[0]!.query}});await f.store.publish(draft);
 const query={...period,scope:'organization' as const,department_id:f.a,member_id:f.user};const models=await f.analytics.models(f.root.token,query);assert.equal(models.items.reduce((sum,item)=>sum+BigInt(item.tokens!),0n),315n);assert.doesNotMatch(JSON.stringify(models),/PRIVATE_OTHER_MODEL|OTHER_PROVIDER|OTHER_BILL/);
 const official=await f.analytics.officialUsage(f.root.token,query);assert.equal(official.groups.reduce((sum,item)=>sum+BigInt(item.tokens!),0n),365n);assert.equal(official.coverage.expected_user_days,3);
});
async function fixture(t:TestContext){
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid'],clock});const seed=await identity.bootstrap({email:'models-root@example.invalid',name:'模型超管'});const temp=await identity.login('models-root@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(temp.token,seed.temporaryPassword,'models-root-password');
 const user=randomUUID(),a=randomUUID(),b=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'models-owner@example.invalid','模型本人')",[user]);await db.query("INSERT INTO departments(id,name) VALUES($1,'模型A'),($2,'模型B')",[a,b]);await db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,'2026-09-01Z')",[user,a]);
 const issued=await identity.resetPassword(root.token,user,1);const temporary=await identity.login('models-owner@example.invalid',issued.temporaryPassword);const own=await identity.changePassword(temporary.token,issued.temporaryPassword,'models-owner-password');
 const store=createUsageSnapshotStore(db,{providerAccount:'models-test',clock});
 async function publish(date:string,amount='150'){
  const draft=await store.begin(user,date);const query=draft.parts[0]!.query;
  const row=(name:string|null,tokens:string,source='Trae',scene='Chat',client='ide',currency:string|null='CNY'):ProviderUsageItem=>({billing_session_id:'PRIVATE_BILLING',provider_user_id:'PRIVATE_PROVIDER',email:'models-owner@example.invalid',start_time:String(query.start_time+3600),client,scene,model_name:name,model_type:'Chat',model_source:source,consumption_source:source==='Custom'?'enterprise_builtin':'pay_go',model_call_count:'1',departments:[{id:'model-dept',name:'模型部门',full_path:'ANC/模型部门'}],usage:{prompt_tokens:tokens,completion_tokens:'0',total_tokens:tokens,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:source==='Custom'?null:'0.100000',amount_reason:source==='Custom'?'not_priced':null,currency,quality:[],token_basis:'provider_reported'});
  const rows=date==='2026-09-23'?[row('Model A','100'),row('Model B','50'),row('Model A','30','Trae','CUE')]:[row('Model A',amount),row('Model A','10','Trae','Chat','ide','USD'),row('Model A','20','Custom','Chat',''),row(null,'5')];
  await store.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:rows.length,total_pages:1},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);
 }
 await publish('2026-09-23');await publish('2026-09-24');
 return {db,identity,root,own,user,a,b,publish,store,analytics:createAnalyticsService(db,identity,{clock,providerAccount:'models-test'})};
}
test('model distribution pages exact official quantities, separates currency and scenes, and leaves missing daily values unknown',async t=>{
 const {analytics,own,publish}=await fixture(t);const first=await analytics.models(own.token,{...period,scope:'self',limit:1});
 assert.equal(first.total,3);assert.equal(first.items[0]?.name,'Model A');assert.equal(first.items[0]?.tokens,'260');assert.equal(first.items[0]?.users,1);assert.equal(first.items[0]?.calls,'3');assert.equal(first.items[0]?.costs.length,2);assert.equal(first.items[0]?.costs.find(row=>row.currency==='CNY')?.amount,'0.200000');assert.equal(first.items[0]?.costs.find(row=>row.currency==='USD')?.amount,'0.100000');assert.ok(first.next_cursor);
 assert.deepEqual(first.trend.map(row=>row.tokens),[null,'150','165']);assert.equal(first.trend[0]?.records,0);
 const second=await analytics.models(own.token,{...period,scope:'self',limit:1,cursor:first.next_cursor!});assert.equal(second.items[0]?.name,'Model B');
 const drill=await analytics.models(own.token,{...period,scope:'self',model_key:first.items[0]!.key});assert.deepEqual(drill.trend.map(row=>row.tokens),[null,'100','160']);
 const cue=await analytics.models(own.token,{...period,scope:'self',scene:'CUE'});assert.equal(cue.items[0]?.tokens,'30');
 const custom=await analytics.models(own.token,{...period,scope:'self',client:'unspecified'});assert.equal(custom.items[0]?.model_source,'Custom');assert.equal(custom.items[0]?.tokens,'20');assert.equal(custom.items[0]?.costs[0]?.amount,null);
 assert.ok(!JSON.stringify(first).includes('PRIVATE_'));assert.ok(!JSON.stringify(first).includes('models-owner@'));
 await publish('2026-09-24','120');await assert.rejects(analytics.models(own.token,{...period,scope:'self',limit:1,cursor:first.next_cursor!}),{code:'invalid_cursor'});
});

test('a normal annual retention cutoff preserves recent official and model readings in the same local department scope', async t => {
 const {db,root,user,a,analytics}=await fixture(t);
 const query={...period,scope:'organization' as const,department_id:a,member_id:user};
 const officialBefore=await analytics.officialUsage(root.token,query);
 const modelsBefore=await analytics.models(root.token,query);
 assert.equal(officialBefore.groups.reduce((sum,row)=>sum+BigInt(row.known_tokens),0n),365n);
 assert.equal(modelsBefore.items.reduce((sum,row)=>sum+BigInt(row.tokens!),0n),315n);
 assert.equal(modelsBefore.trend[0]?.tokens,null,'an unobserved day remains unknown');
 const cutoff=new Date(clock().getTime()-365*24*60*60*1000).toISOString();
 await db.query('UPDATE data_identity SET retention_cutoff=$1',[cutoff]);
 const officialAfter=await analytics.officialUsage(root.token,query);
 const modelsAfter=await analytics.models(root.token,query);
 assert.deepEqual(officialAfter.groups,officialBefore.groups);
 assert.deepEqual(officialAfter.coverage,officialBefore.coverage);
 assert.deepEqual(modelsAfter.items,modelsBefore.items);
 assert.deepEqual(modelsAfter.trend,modelsBefore.trend);
 assert.deepEqual(modelsAfter.coverage,modelsBefore.coverage);
});

test('characterization: advancing retention before physical cleanup currently differs between official and model readings', async t => {
 const {db,own,analytics}=await fixture(t);
 const query={...period,scope:'self' as const};
 const modelsBefore=await analytics.models(own.token,query);
 await db.query("UPDATE data_identity SET retention_cutoff='2026-09-23T12:00:00Z'");
 const official=await analytics.officialUsage(own.token,query);
 const models=await analytics.models(own.token,query);
 assert.equal(official.groups.reduce((sum,row)=>sum+row.records,0),4);
 assert.equal(official.groups.reduce((sum,row)=>sum+BigInt(row.known_tokens),0n),185n,
  'the summary hides the entire September 23 scope crossing the durable cutoff');
 // Existing behavior only: model reading still follows the published snapshot
 // pointer until physical cleanup. This discrepancy needs a separate decision;
 // the structural refactor must not silently turn it into a new retention policy.
 assert.deepEqual(models.items,modelsBefore.items);
 assert.deepEqual(models.trend,modelsBefore.trend);
 assert.equal(models.items.reduce((sum,row)=>sum+BigInt(row.tokens!),0n),315n);
});

test('model aggregate roles remain scoped and clearing a source day cannot become a zero-valued trend point',async t=>{
 const {db,identity,root,own,user,a,b,analytics}=await fixture(t);await assert.rejects(analytics.models(own.token,{...period,department_id:a}),{code:'forbidden'});
 await db.query("INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,'department_admin',$2,'2026-09-01Z')",[user,a]);const manager=await identity.login('models-owner@example.invalid','models-owner-password');
 assert.equal((await analytics.models(manager.token,{...period,department_id:a})).items.find(row=>row.name==='Model A')?.tokens,'260');await assert.rejects(analytics.models(manager.token,{...period,department_id:b}),{code:'forbidden'});
 assert.equal((await analytics.models(root.token,{...period,department_id:b})).items.length,0);
 await db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[user]);await client.query("INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,'2026-09-24T00:00:00Z','2026-09-24T02:00:00Z',1)",[user]);});
 const cleared=await analytics.models(manager.token,{...period,department_id:a});assert.equal(cleared.items.find(row=>row.name==='Model A')?.tokens,'100');assert.equal(cleared.trend[2]?.tokens,null);assert.equal(cleared.coverage.missing_user_days,2);
});

test('declared-model aggregates count observed-session cohorts without fabricating dated tokens or exposing sessions',async t=>{
 const {db,identity,root,own,user,a,b,analytics}=await fixture(t);await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'声明模型夹具')",[installation,user,'e'.repeat(64)]);
 const service=createSessionPersonalModelService(db,identity,{clock});let first='';
 for(const i of [0,1]){const put=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'declared-'+i,occurred_at:`2026-09-${23+i}T01:00:00Z`,event_type:'UserPromptSubmit',source_session_id:'declared-'+i,payload:{prompt:'PRIVATE_DECLARED_PROMPT'}},{admissionEpoch:1,receivedAt:clock()});assert.equal(put.outcome,'committed');if(put.outcome!=='committed')throw new Error('fixture');if(i===0)first=put.sessionId;const state=await service.read(own.token,put.sessionId);await service.replace(own.token,put.sessionId,{version:state.version,cleanup_generation:state.cleanup_generation,models:i?['User Only']:['Model A','User Only']});}
 const page=await analytics.declaredModels(own.token,{...period,scope:'self',limit:1});assert.equal(page.source,'user_declared');assert.equal(page.total,2);assert.equal(page.confirmed_sessions,2);assert.equal(page.items[0]?.name,'User Only');assert.equal(page.items[0]?.sessions,2);assert.equal(page.items[0]?.users,1);assert.ok(page.next_cursor);assert.equal(Object.hasOwn(page,'trend'),false);assert.ok(!JSON.stringify(page).includes('PRIVATE_'));assert.ok(!JSON.stringify(page).includes(first));
 assert.equal((await analytics.declaredModels(root.token,{...period,department_id:a})).confirmed_sessions,2);assert.equal((await analytics.declaredModels(root.token,{...period,department_id:b})).confirmed_sessions,0);
 const state=await service.read(own.token,first);await service.replace(own.token,first,{version:state.version,cleanup_generation:state.cleanup_generation,models:[]});await assert.rejects(analytics.declaredModels(own.token,{...period,scope:'self',limit:1,cursor:page.next_cursor!}),{code:'invalid_cursor'});assert.equal((await analytics.declaredModels(own.token,{...period,scope:'self'})).confirmed_sessions,1);
});

test('late Hooks that change the declared-session cohort invalidate subsequent model pages',async t=>{
 const {db,identity,own,user,analytics}=await fixture(t);await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'迟到模型夹具')",[installation,user,'c'.repeat(64)]);const models=createSessionPersonalModelService(db,identity,{clock});
 async function put(key:string,at:string,id=key){return db.ingest({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:key,payload:{}},{admissionEpoch:1,receivedAt:clock()});}
 for(const [key,at,name] of [['inside-a','2026-09-23T01:00:00Z','A'],['inside-b','2026-09-23T02:00:00Z','B'],['outside','2026-09-21T01:00:00Z','C']]){const saved=await put(key!,at!);if(saved.outcome!=='committed')throw new Error('fixture');const state=await models.read(own.token,saved.sessionId);await models.replace(own.token,saved.sessionId,{version:state.version,cleanup_generation:state.cleanup_generation,models:[name!]});}
 const first=await analytics.declaredModels(own.token,{...period,scope:'self',limit:1});assert.equal(first.total,2);assert.ok(first.next_cursor);
 await put('outside','2026-09-23T03:00:00Z','late-inside');await assert.rejects(analytics.declaredModels(own.token,{...period,scope:'self',limit:1,cursor:first.next_cursor!}),{code:'invalid_cursor'});
});

test('a model with excessive currency groups fails explicitly instead of producing an unbounded response',async t=>{
 const {own,user,store,analytics}=await fixture(t);const draft=await store.begin(user,'2026-09-22');const query=draft.parts[0]!.query;
 const rows:ProviderUsageItem[]=Array.from({length:201},(_,i)=>({billing_session_id:'currency-'+i,provider_user_id:'PRIVATE_PROVIDER',email:'models-owner@example.invalid',start_time:String(query.start_time+1),client:'ide',scene:'Chat',model_name:'Currency Model',model_type:'Chat',model_source:'Trae',consumption_source:'pay_go',model_call_count:'1',departments:[],usage:{prompt_tokens:'1',completion_tokens:'0',total_tokens:'1',cache_read_input_tokens:'0',cache_creation_input_tokens:'0'},amount:'0.1',amount_reason:null,currency:'X'+i,quality:[],token_basis:'provider_reported'}));
 for(const page of [1,2])await store.stage(draft,0,{items:rows.slice((page-1)*200,page*200),pagination:{page,page_size:200,total:201,total_pages:2},request_id:'currency-fixture',observed_at:clock().toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...query,page}}});await store.publish(draft);
 await assert.rejects(analytics.models(own.token,{...period,scope:'self'}),{code:'metric_overflow'});
});

test('model department attribution follows local history and transfer revisions invalidate model cursors',async t=>{
 const {db,identity,root,own,user,a,b,analytics}=await fixture(t);
 const {createOrganizationService}=await import('../../src/organization.js');
 const first=await analytics.models(root.token,{...period,department_id:a,limit:1});assert.ok(first.next_cursor);assert.equal(first.items[0]?.tokens,'260');
 const version=(await db.query<{version:number}>('SELECT version FROM users WHERE id=$1',[user])).rows[0]!.version;
 await createOrganizationService(db,identity,{clock}).transferMember(root.token,user,{target_department_id:b,version});
 await assert.rejects(analytics.models(root.token,{...period,department_id:a,limit:1,cursor:first.next_cursor!}),{code:'invalid_cursor'});
 await db.query("UPDATE membership_periods SET valid_to='2026-09-23T18:00:00Z' WHERE user_id=$1 AND department_id=$2",[user,a]);
 await db.query("UPDATE membership_periods SET valid_from='2026-09-23T18:00:00Z' WHERE user_id=$1 AND department_id=$2",[user,b]);
 assert.equal((await analytics.models(root.token,{...period,department_id:a})).items.find(row=>row.name==='Model A')?.tokens,'100');
 assert.equal((await analytics.models(root.token,{...period,department_id:b})).total,0);
 assert.equal((await analytics.models(own.token,{...period,scope:'self'})).items.find(row=>row.name==='Model A')?.tokens,'260');
});
