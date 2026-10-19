import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionString} from '../../../../packages/storage/test/helpers.js';
import {stopUsageFixture} from '../../../../packages/domain/test/helpers/stop-usage.js';
import {createSessionReadService} from '../../../../packages/domain/src/session-reading.js';
import {createUsageSnapshotStore} from '../../../../packages/domain/src/usage-snapshots.js';
import {createUsageAttributionService} from '../../../../packages/domain/src/usage-attribution.js';
import {createApi} from '../../src/app.js';
import {configuredServices} from '../../src/config.js';

async function publishLegacyQuantity(f:Awaited<ReturnType<typeof stopUsageFixture>>){
 const snapshots=createUsageSnapshotStore(f.db,{providerAccount:'stop-test'});
 const day=new Date(f.stop.getTime()+28800000).toISOString().slice(0,10),draft=await snapshots.begin(f.user,day);
 for(const [index,part] of draft.parts.entries())await snapshots.stage(draft,index,await f.provider.getMemberUsage(part.query));
 await snapshots.publish(draft);
 const attribution=createUsageAttributionService(f.db,{providerAccount:'stop-test',provider:{getSessionUsage:async hook=>({...(await f.provider.getSessionUsage('official-bill')),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}});
 await attribution.probe(f.session);
}

test('the default-off session API ignores stored Stop trial quantities',async t=>{
 const f=await stopUsageFixture(t);await f.run();
 assert.equal((await f.read()).groups[0]?.tokens,'176004');
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test'});
 const api=createApi(undefined,{identity:f.identity,sessions:reader});t.after(()=>api.close());
 const response=await api.inject({url:`/api/v1/sessions/${f.session}/official-usage`,headers:{cookie:`adi_session=${f.login.token}`}});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().data.groups,[]);
 assert.equal(response.json().data.session_query,undefined);
});

test('turning the Stop trial off restores known person-day quantities in session details, lists and official filters',async t=>{
 const f=await stopUsageFixture(t);await f.run();await publishLegacyQuantity(f);
 const legacy=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',stopWindowEnabled:false});
 assert.equal((await legacy.officialUsage(f.login.token,f.session)).groups[0]?.tokens,'31336');
 for(const read of [legacy.listMine,legacy.listAll]){
  const result=await read(f.login.token,{channel:'official'});
  assert.equal(result.total,1);assert.equal(result.items[0]?.official_tokens,'31336');
 }
 assert.equal((await f.reader.listMine(f.login.token,{channel:'official'})).items[0]?.official_tokens,'176004');
 assert.equal((await f.read()).groups[0]?.tokens,'176004','reopening can use the still-valid stored trial result');
});

test('disabled session pagination survives trial refreshes and cannot be reused after switching the trial on',async t=>{
 const f=await stopUsageFixture(t);await f.run();await publishLegacyQuantity(f);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'older-session',source_session_id:'older-hook',event_type:'UserPromptSubmit',occurred_at:new Date(f.start.getTime()-1000).toISOString(),payload:{prompt:'较早会话'}},{admissionEpoch:1,receivedAt:f.at});
 const legacy=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',stopWindowEnabled:false});
 const page=await legacy.listMine(f.login.token,{limit:1});assert.ok(page.next_cursor);
 await f.run();
 const next=await legacy.listMine(f.login.token,{limit:1,cursor:page.next_cursor});
 assert.equal(next.items[0]?.source_session_id,'older-hook');
 await assert.rejects(f.reader.listMine(f.login.token,{limit:1,cursor:page.next_cursor}),{code:'invalid_cursor'});
 const enabled=await f.reader.listMine(f.login.token,{limit:1});assert.ok(enabled.next_cursor);
 await assert.rejects(legacy.listMine(f.login.token,{limit:1,cursor:enabled.next_cursor}),{code:'invalid_cursor'});
});

test('a new Hook leaves legacy quantities readable while reopening keeps the stored trial result pending',async t=>{
 const f=await stopUsageFixture(t);await f.run();await publishLegacyQuantity(f);
 const later=new Date();await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'after-trial-disabled',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:later.toISOString(),payload:{last_assistant_message:'后续停止记录'}},{admissionEpoch:1,receivedAt:later});
 const legacy=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',stopWindowEnabled:false});
 assert.equal((await legacy.officialUsage(f.login.token,f.session)).groups[0]?.tokens,'31336');
 assert.equal((await legacy.listMine(f.login.token,{channel:'official'})).items[0]?.official_tokens,'31336');
 const reopened=await f.read();assert.equal(reopened.session_query?.state,'pending');assert.deepEqual(reopened.groups,[]);
 assert.ok(reopened.session_query?.reasons.includes('new_hook_events'));
});

test('the configured API uses the same validated Stop trial flag as its worker',async t=>{
 const f=await stopUsageFixture(t);await f.run();
 const directory=mkdtempSync(join(tmpdir(),'adi-stop-switch-')),keys=['ADI_DATABASE_URL','ADI_DATABASE_SCHEMA','ADI_USAGE_PROVIDER_ACCOUNT','ADI_USAGE_STOP_WINDOW_ENABLED','ADI_EMAIL_DOMAINS','ADI_INSTALLATION_KEY_FILE'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 t.after(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}rmSync(directory,{recursive:true,force:true});});
 Object.assign(process.env,{ADI_DATABASE_URL:connectionString,ADI_DATABASE_SCHEMA:f.db.schema,ADI_USAGE_PROVIDER_ACCOUNT:'stop-test',ADI_EMAIL_DOMAINS:'example.invalid',ADI_INSTALLATION_KEY_FILE:join(directory,'installation.key')});
 for(const flag of [undefined,'false','true']){
  if(flag===undefined)delete process.env.ADI_USAGE_STOP_WINDOW_ENABLED;else process.env.ADI_USAGE_STOP_WINDOW_ENABLED=flag;
  const services=configuredServices();assert.ok(services);
  const api=createApi(undefined,{identity:services.identity,sessions:services.sessions});
  try{
   const response=await api.inject({url:`/api/v1/sessions/${f.session}/official-usage`,headers:{cookie:`adi_session=${f.login.token}`}});
   assert.equal(response.statusCode,200,response.body);
   assert.equal(response.json().data.groups[0]?.tokens,flag==='true'?'176004':undefined);
  }finally{await api.close();await services.db.close();}
 }
 process.env.ADI_USAGE_STOP_WINDOW_ENABLED='invalid';
 assert.throws(()=>configuredServices(),/Invalid usage configuration/);
});
