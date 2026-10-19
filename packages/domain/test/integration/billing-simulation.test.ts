import {test,type TestContext} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../storage/test/helpers.js';import {createIdentityService} from '../../src/identity.js';import {createSessionDerivationService} from '../../src/session-derivation.js';import {createSessionReadService} from '../../src/session-reading.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';import type {ProviderUsageItem} from '../../src/usage-provider.js';
import {createSessionPersonalModelService} from '../../src/session-personal-models.js';
const clock=()=>new Date('2026-09-24T12:00:00Z');
async function fixture(t:TestContext){
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-07-01Z'),new Date('2026-10-01Z'));const identity=createIdentityService(db,{clock,emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'simulation@example.invalid',name:'模拟夹具'});const login=await identity.login('simulation@example.invalid',seed.temporaryPassword);const own=await identity.changePassword(login.token,seed.temporaryPassword,'simulation-strong-password');const installation=randomUUID();
 await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,own.user.user_id,'d'.repeat(64),'模拟设备']);let index=0;let sid='';
 const put=async(type:string,payload:Record<string,unknown>,at?:string)=>{const i=++index;const event=await db.ingest({schema_version:2,installation_id:installation,client_event_id:String(i),occurred_at:at??new Date(Date.parse('2026-09-23T01:00:00Z')+i*1000).toISOString(),event_type:type,source_session_id:'simulation',payload},{admissionEpoch:1,receivedAt:clock()});if(event.outcome!=='committed')throw new Error('fixture rejected');sid=event.sessionId;return sid;};
 const drain=async()=>{const worker=createSessionDerivationService(db,{clock});let n=0;while(await worker.runOne())assert.ok(++n<40);};return {db,own,identity,put,drain,session:()=>sid,reader:createSessionReadService(db,identity,{clock})};
}
test('billing simulation repeats visible context under explicit assumptions and never creates official cost',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'中'});await f.put('Stop',{last_assistant_message:'文'});await f.put('UserPromptSubmit',{prompt:'字'});await f.put('Stop',{last_assistant_message:'答'});await f.drain();
 const result=await f.reader.simulation(f.own.token,f.session(),{});
 assert.equal(result.kind,'billing_simulation');assert.equal(result.simulated_input_tokens,'48004');assert.equal(result.hypothetical_calls,2);assert.equal(result.baseline.tokens,'24000');assert.equal(result.baseline.source,'default');assert.equal(result.observed_output_tokens,'2');assert.equal(result.amount,null);assert.equal(result.reason,null);
 const adjusted=await f.reader.simulation(f.own.token,f.session(),{base_tokens:'10000'});assert.equal(adjusted.simulated_input_tokens,'20004');assert.equal(adjusted.baseline.source,'scenario_override');assert.equal((await f.reader.detail(f.own.token,f.session())).content_estimate.tokens,null);
 const declarations=createSessionPersonalModelService(f.db,f.identity);const prior=await declarations.read(f.own.token,f.session());await declarations.replace(f.own.token,f.session(),{version:prior.version,cleanup_generation:prior.cleanup_generation,models:['Personal-X']});assert.equal((await f.reader.simulation(f.own.token,f.session(),{})).baseline.model,null);
});
test('tool batches use timing and declared action assumptions rather than equating every Hook to a model call',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'a'},'2026-09-23T01:00:00Z');
 await f.put('PreToolUse',{tool_use_id:'read',tool_name:'Read',tool_input:{}},'2026-09-23T01:00:01Z');await f.put('PostToolUse',{tool_use_id:'read',tool_name:'Read',tool_response:'中'},'2026-09-23T01:00:02Z');
 await f.put('PreToolUse',{tool_use_id:'write',tool_name:'Write',tool_input:{}},'2026-09-23T01:00:03Z');await f.put('PostToolUse',{tool_use_id:'write',tool_name:'Write',tool_response:'文'},'2026-09-23T01:00:04Z');await f.put('Stop',{last_assistant_message:'答'},'2026-09-23T01:00:05Z');await f.drain();
 const result=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(result.hypothetical_calls,3);assert.equal(result.simulated_input_tokens,'72012');assert.equal(result.context_tokens,'12');assert.equal(result.observed_output_tokens,'1');
 const batched=await f.reader.simulation(f.own.token,f.session(),{mutating_gap_ms:2000});assert.equal(batched.hypothetical_calls,2);assert.equal(batched.simulated_input_tokens,'48008');assert.ok(result.warnings.includes('hypothetical_calls_not_observed'));
});
test('unproven official labels never calibrate the current session or become an independent system baseline',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'中',model:'Model-X'});await f.drain();const reader=createSessionReadService(f.db,f.identity,{clock,providerAccount:'simulation-source'}),store=createUsageSnapshotStore(f.db,{clock,providerAccount:'simulation-source'});
 const other=randomUUID();await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[other,'other-simulation@example.invalid','另一个合成员工']);
 async function publish(user:string,email:string,prompt:string|null,calls:string|null='1'){
  const draft=await store.begin(user,'2026-09-23');const items:ProviderUsageItem[]=prompt===null?[]:[{billing_session_id:'bill-'+user,provider_user_id:'provider-'+user,email,start_time:String(Date.parse('2026-09-23T01:00:00Z')/1000),client:'ide',scene:'Chat',model_name:'Model-X',model_type:'Chat',model_source:'Trae',consumption_source:'pay_go',model_call_count:calls,departments:[],usage:{prompt_tokens:prompt,completion_tokens:'0',total_tokens:prompt,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:'CNY',quality:[],token_basis:'provider_reported'}];
  await store.stage(draft,0,{items,pagination:{page:1,page_size:200,total:items.length,total_pages:1},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'user_usage_detail',parameters:{...draft.parts[0]!.query,page:1}}});await store.publish(draft);
 }
 const before=await reader.simulation(f.own.token,f.session(),{});await publish(f.own.user.user_id,'simulation@example.invalid','20000');let data=await reader.simulation(f.own.token,f.session(),{});assert.equal(data.simulated_input_tokens,before.simulated_input_tokens,'an evaluated bill cannot move its own prediction');assert.equal(data.baseline.tokens,'24000');assert.equal(data.baseline.source,'default');assert.equal(data.baseline.samples,0);assert.equal(data.baseline.calibrated,false);assert.equal(data.baseline.training_before,data.period.from);
 await publish(f.own.user.user_id,'simulation@example.invalid','20000');assert.equal((await reader.simulation(f.own.token,f.session(),{})).baseline.samples,0);
 await publish(f.own.user.user_id,'simulation@example.invalid','10000');await publish(other,'other-simulation@example.invalid','30000');data=await reader.simulation(f.own.token,f.session(),{});assert.equal(data.baseline.tokens,'24000');assert.equal(data.baseline.source,'default');
 await publish(f.own.user.user_id,'simulation@example.invalid',null);data=await reader.simulation(f.own.token,f.session(),{});assert.equal(data.baseline.tokens,'24000');assert.equal(data.baseline.source,'default');assert.doesNotMatch(JSON.stringify(data),/other-simulation|另一个合成员工|provider-/);
 await publish(f.own.user.user_id,'simulation@example.invalid','20000',null);assert.equal((await reader.simulation(f.own.token,f.session(),{})).baseline.source,'default');
 assert.equal((await reader.simulation(f.own.token,f.session(),{model:'No-Samples'})).baseline.source,'default');assert.equal((await reader.simulation(f.own.token,f.session(),{base_tokens:'12345'})).baseline.source,'scenario_override');
});
test('pending and partial traces do not produce complete-looking simulation totals and other managers cannot read them',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'中'});assert.equal((await f.reader.simulation(f.own.token,f.session(),{})).reason,'projection_pending');await f.drain();
 await assert.rejects(f.reader.simulation(f.own.token,f.session(),{base_tokens:'1000001'}),{code:'invalid_request'});await assert.rejects(f.reader.simulation(f.own.token,f.session(),{min_call_gap_ms:1}),{code:'invalid_request'});
 await f.put('UserPromptSubmit',{prompt:'旧上下文'},'2026-07-10T00:00:00Z');await f.drain();const partial=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(partial.reason,'partial_history');assert.equal(partial.simulated_input_tokens,null);
 const other=randomUUID();await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[other,'simulation-manager@example.invalid','不可读他人']);const reset=await f.identity.resetPassword(f.own.token,other,1);const temporary=await f.identity.login('simulation-manager@example.invalid',reset.temporaryPassword);const manager=await f.identity.changePassword(temporary.token,reset.temporaryPassword,'manager-simulation-password');
 await assert.rejects(f.reader.simulation(manager.token,f.session(),{}),{code:'not_found'});await f.db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'anc_admin','2026-09-01Z')",[other]);await assert.rejects(f.reader.simulation(manager.token,f.session(),{}),{code:'not_found'});
});
test('missing prompt content is unknown rather than zero-cost context',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{});await f.drain();const data=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(data.reason,'missing_prompt_content');assert.equal(data.simulated_input_tokens,null);
});
test('conflicting tool timestamps are disclosed and a cleared part prevents whole-session simulation',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'a'});await f.put('PostToolUse',{tool_use_id:'unpaired',tool_name:'Read',tool_input:{},tool_response:'中'});await f.put('PreToolUse',{tool_use_id:'unpaired',tool_name:'Read',tool_input:{}});await f.drain();const data=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(data.hypothetical_calls,2);assert.ok(data.warnings.includes('incomplete_tool_timing'));
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.own.user.user_id]);await f.db.query("INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,'2026-09-23T01:00:02Z','2026-09-23T01:00:03Z',1)",[f.own.user.user_id]);await createSessionDerivationService(f.db,{clock}).enqueueRebuild(f.session());await f.drain();const cleared=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(cleared.reason,'partial_history');assert.equal(cleared.simulated_input_tokens,null);
});

test('an unassigned tool return cannot become a fabricated per-turn billing simulation',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'a'});await f.put('PostToolUse',{tool_use_id:'missing-start',tool_name:'Read',tool_input:{},tool_response:'中'});await f.drain();const data=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(data.reason,'unattributed_events');assert.equal(data.hypothetical_calls,null);assert.equal(data.simulated_input_tokens,null);
});

test('multiple observed models do not silently replace the session model with the last value',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'FIRST',model:'Model-A'});await f.put('Stop',{last_assistant_message:'A',model:'Model-A'});await f.put('UserPromptSubmit',{prompt:'SECOND',model:'Model-B'});await f.put('Stop',{last_assistant_message:'B',model:'Model-B'});await f.drain();
 const data=await f.reader.simulation(f.own.token,f.session(),{});assert.equal(data.baseline.model,null);assert.equal(data.baseline.calibrated,false);assert.ok(data.warnings.includes('multiple_hook_models_unresolved'));assert.ok(!data.warnings.includes('multiple_hook_models_latest_used'));
 const scenario=await f.reader.simulation(f.own.token,f.session(),{model:'Scenario-Only',base_tokens:'10000'});assert.equal(scenario.baseline.model,'Scenario-Only');assert.equal(scenario.baseline.calibrated,false);assert.ok(scenario.warnings.includes('multiple_hook_models_unresolved'));
});

test('unchanged scenario inputs reuse a frozen result while parameter and Hook revisions produce a new result',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'中'});await f.put('Stop',{last_assistant_message:'文'});await f.drain();let at=clock();const reader=createSessionReadService(f.db,f.identity,{clock:()=>at});
 const first=await reader.simulation(f.own.token,f.session(),{});assert.equal(first.computed_at,at.toISOString());assert.match(first.source_version!,/^[a-f0-9]{64}$/);
 at=new Date(at.getTime()+60000);const same=await reader.simulation(f.own.token,f.session(),{});assert.equal(same.computed_at,first.computed_at);assert.equal(same.source_version,first.source_version);assert.equal(same.simulated_input_tokens,first.simulated_input_tokens);
 const changed=await reader.simulation(f.own.token,f.session(),{base_tokens:'10000'});assert.equal(changed.computed_at,at.toISOString());assert.notEqual(changed.simulated_input_tokens,first.simulated_input_tokens);assert.equal(changed.source_version,first.source_version);
 at=new Date(at.getTime()+60000);await f.put('UserPromptSubmit',{prompt:'字'});await f.drain();const revised=await reader.simulation(f.own.token,f.session(),{base_tokens:'10000'});assert.equal(revised.computed_at,at.toISOString());assert.notEqual(revised.source_version,first.source_version);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_simulation_cache WHERE session_id=$1',[f.session()])).rows[0]!.n,1,'only the latest parameter result is retained per session');
});

test('concurrent identical scenario reads agree on one frozen computation',async t=>{
 const f=await fixture(t);await f.put('UserPromptSubmit',{prompt:'中'});await f.drain();const later=new Date(clock().getTime()+60000);const one=createSessionReadService(f.db,f.identity,{clock}),two=createSessionReadService(f.db,f.identity,{clock:()=>later});
 const [a,b]=await Promise.all([one.simulation(f.own.token,f.session(),{}),two.simulation(f.own.token,f.session(),{})]);assert.ok(a.computed_at);assert.equal(a.computed_at,b.computed_at);assert.equal(a.source_version,b.source_version);assert.equal(a.simulated_input_tokens,b.simulated_input_tokens);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_simulation_cache WHERE session_id=$1',[f.session()])).rows[0]!.n,1);
});
