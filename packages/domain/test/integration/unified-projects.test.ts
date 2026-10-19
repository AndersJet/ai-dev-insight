import {submitCleanupConfirmed} from '../helpers/cleanup-acceptance.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createPluginObservationStore} from '../../../storage/src/plugin-observations.js';
import {createIdentityService} from '../../src/identity.js';
import {createProjectInventoryService} from '../../src/project-inventory.js';
import type {PluginObservation,ProjectContext,HookEnvelope} from '@adi/contracts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {createCleanupService} from '../../src/cleanup.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';
import {createAnalyticsService} from '../../src/analytics.js';
import {createRetentionService} from '../../src/retention.js';

async function fixture(t:TestContext){
  const db=await testDatabase(t);await db.migrate();const at=new Date();
  await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(at.getTime()+86400000));
  const identity=createIdentityService(db,{emailDomains:['example.org']});
  await identity.syncConfigurationAdministrator({email:'unified@example.org',name:'合成管理员',password:'unified-synthetic-password'});
  const login=await identity.login('unified@example.org','unified-synthetic-password'),user=login.user.user_id;
  await db.query('UPDATE users SET registered_at=$2 WHERE id=$1',[user,at]);
  const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成采集')",[installation,user,'e'.repeat(64)]);
  const collector=randomUUID(),config=randomUUID();
  const observation=(sequence:string,state:PluginObservation['state']='repository',reason:PluginObservation['reason']=null):PluginObservation=>({schema_version:2,collector_id:collector,source_config_id:config,nt_email:'unified@example.org',observation_id:randomUUID(),sequence,platform:'macos',workspace_path:'/synthetic/unified',observed_at:new Date(at.getTime()+Number(sequence)).toISOString(),state,reason,git_root:state==='repository'?'/synthetic/unified':null,remotes:state==='repository'?[{address:'https://git.example.invalid/team/app.git'}]:[],plugin_version:'1.0.0'});
  const context=(value:PluginObservation):ProjectContext=>({collector_id:collector,platform:value.platform,workspace:value.workspace_path,unresolved_reason:null,observation:{id:value.observation_id,sequence:value.sequence,observed_at:value.observed_at,state:value.state,reason:value.reason,git_root:value.git_root,remotes:value.remotes}});
  const envelope=(value:ProjectContext,session='unified-session'):HookEnvelope=>({schema_version:2,installation_id:installation,client_event_id:randomUUID(),occurred_at:at.toISOString(),event_type:'UserPromptSubmit',source_session_id:session,payload:{prompt:'synthetic prompt'},project:value});
  return {db,at,user,login,identity,installation,collector,observation,context,envelope,plugin:createPluginObservationStore(db),hook:createProjectInventoryService(db,identity)};
}

test('pre-baseline reads exclude earlier Hook and official coverage instead of presenting them as missing user days',async t=>{
  const f=await fixture(t),begin=Math.floor((f.at.getTime()+28800000)/86400000)*86400000-28800000,end=begin+86400000;
  await f.db.ingest(f.envelope(f.context(f.observation('1'))),{admissionEpoch:1,receivedAt:f.at});
  await f.db.query('UPDATE data_identity SET collection_baseline_at=$1',[new Date(end)]);
  const analytics=createAnalyticsService(f.db,f.identity,{clock:()=>f.at,providerAccount:'synthetic-baseline'}),range={scope:'self' as const,from:new Date(begin).toISOString(),to:new Date(end).toISOString()};
  const overview=await analytics.overview(f.login.token,range);assert.equal(overview.sessions,0);assert.equal(overview.prompt_turns,0);
  const estimate=await analytics.contentEstimate(f.login.token,range);assert.equal(estimate.estimate.sessions,0);assert.equal(estimate.estimate.reason,'no_observations');
  const official=await analytics.officialUsage(f.login.token,range);assert.equal(official.coverage.expected_user_days,0);assert.equal(official.coverage.missing_user_days,0);assert.deepEqual(official.groups,[]);
});

test('permanent plugin history survives automatic Hook retention and is removed by an arbitrary older person-time range',async t=>{
  const f=await fixture(t),value=f.observation('1'),old=new Date(f.at.getTime()-800*86400000);value.observed_at=old.toISOString();
  await f.plugin.save(value,{userId:f.user});
  const retention=createRetentionService(f.db,{clock:()=>f.at,batchSize:10});let steps=0;while(await retention.runOne())assert.ok(++steps<200);
  const project=(await f.plugin.projects()).items[0]!;assert.ok(project.project_id);
  assert.equal((await f.plugin.history({project_id:project.project_id})).total,1);
  const directory=await mkdtemp(join(tmpdir(),'adi-unified-old-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cleanup=createCleanupService(f.db,f.identity,{clock:()=>f.at,journal:createCleanupJournal(directory)});
  const preview=await cleanup.preview(f.login.token,{user_id:f.user,from:old.toISOString(),to:new Date(old.getTime()+1000).toISOString()});
  assert.equal(preview.counts.plugin_project_observations,1);assert.equal(preview.counts.hook_project_observations,0);
  const input={preview_id:preview.preview_id,user_id:f.user,...preview.range,confirmation_email:preview.target.email},idempotency=randomUUID(),job=await submitCleanupConfirmed(cleanup,f.login.token,input,idempotency);
  steps=0;while(await cleanup.runOne())assert.ok(++steps<100);
  assert.equal((await f.plugin.projects()).total,0);await assert.rejects(f.plugin.save(value,{userId:f.user}),{code:'project_cleared'});
  const nothing=await cleanup.preview(f.login.token,{user_id:f.user,...preview.range});assert.equal(nothing.can_submit,false);
  assert.ok((await f.db.query('SELECT 1 FROM project_observation_keys WHERE user_id=$1',[f.user])).rowCount,'minimal replay keys must remain without counting as readable usage');
  await assert.rejects(cleanup.submit(f.login.token,{preview_id:nothing.preview_id,user_id:f.user,...nothing.range,confirmation_email:nothing.target.email},randomUUID()),{code:'cleanup_empty_scope',status:422});
  assert.equal((await submitCleanupConfirmed(cleanup,f.login.token,input,idempotency)).job_id,job.job_id,'accepted retries remain idempotent after their visible facts have been erased');
});

test('authenticated plugin project history compresses only consecutive identical results and preserves failure recovery',async t=>{
  const f=await fixture(t);
  const saved=await f.plugin.save(f.observation('1'),{userId:f.user});
  const repeated=await f.plugin.save(f.observation('2'),{userId:f.user});
  assert.equal(saved.state_changed,true);assert.equal(repeated.state_changed,false);
  await f.plugin.save(f.observation('3','failed','timeout'),{userId:f.user});
  const failed=(await f.plugin.projects()).items[0]!;
  assert.equal(failed.latest!.state,'failed');assert.equal(failed.confirmed!.sequence,'1');
  await f.plugin.save(f.observation('4'),{userId:f.user});
  const project=(await f.plugin.projects()).items[0]!;
  const history=await f.plugin.history({nt_email:'unified@example.org',collector_id:f.collector,workspace_key:project.workspace_key});
  assert.deepEqual(history.items.map(item=>item.sequence),['4','3','1']);
  assert.equal(project.confirmed!.sequence,'4');
});

test('Hook and plugin projects keep independent identities even for the same person, source ID, path and observation ID',async t=>{
  const f=await fixture(t),value=f.observation('1');
  await f.plugin.save(value,{userId:f.user});
  const first=await f.db.ingest(f.envelope(f.context(value),'first-session'),{admissionEpoch:1,receivedAt:f.at});
  const second=await f.db.ingest(f.envelope(f.context(value),'second-session'),{admissionEpoch:1,receivedAt:f.at});
  assert.equal(first.outcome,'committed');assert.equal(second.outcome,'committed');
  const hooks=await f.hook.list(f.login.token),plugins=await f.plugin.projects();
  assert.equal(hooks.total,1);assert.equal(plugins.total,1);
  assert.notEqual(hooks.items[0]!.id,plugins.items[0]!.project_id);
  const sessions=await f.hook.sessions(f.login.token,hooks.items[0]!.id);
  assert.equal(sessions.total,2);
  assert.equal(hooks.items[0]!.observed_at,value.observed_at);
  assert.equal(hooks.items[0]!.session_count,2);
});

test('person-time cleanup covers both sources, retains historical entry without promoting old heads, and accepts a new equal-state probe',async t=>{
  const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'adi-unified-cleanup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const clock=()=>new Date(f.at.getTime()+1000),cleanup=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory)});
  const first=f.observation('1'),latest=f.observation('3');latest.remotes=[{address:'https://git.example.invalid/team/new.git'}];
  await f.plugin.save(first,{userId:f.user});await f.plugin.save(latest,{userId:f.user});
  await f.db.ingest(f.envelope(f.context(first),'before'),{admissionEpoch:1,receivedAt:f.at});
  await f.db.ingest(f.envelope(f.context(latest),'later'),{admissionEpoch:1,receivedAt:f.at});
  const from=new Date(f.at.getTime()+2).toISOString(),to=new Date(f.at.getTime()+4).toISOString();
  const preview=await cleanup.preview(f.login.token,{user_id:f.user,from,to});
  assert.equal(preview.counts.hook_project_observations,1);assert.equal(preview.counts.plugin_project_observations,1);
  await submitCleanupConfirmed(cleanup,f.login.token,{preview_id:preview.preview_id,user_id:f.user,from,to,confirmation_email:'unified@example.org'},randomUUID());
  let batches=0;while(await cleanup.runOne())assert.ok(++batches<100);
  const plugin=(await f.plugin.projects()).items[0]!,hooks=await f.hook.list(f.login.token);
  assert.equal(plugin.current_available,false);assert.equal(plugin.history_only,true);assert.equal(plugin.latest,null);assert.equal(plugin.confirmed,null);
  assert.equal((await f.plugin.history({project_id:plugin.project_id as string})).items.length,1);
  assert.equal(hooks.total,1);assert.equal(hooks.items[0]!.current_available,false);assert.deepEqual(hooks.items[0]!.remotes,[]);
  await assert.rejects(f.plugin.save(latest,{userId:f.user}),{code:'project_cleared'});
  await assert.rejects(f.plugin.save({...latest,sequence:'5',observed_at:clock().toISOString()},{userId:f.user}),{code:'plugin_conflict'});
  const next={...latest,observation_id:randomUUID(),sequence:'4',observed_at:clock().toISOString()};
  const receipt=await f.plugin.save(next,{userId:f.user,receivedAt:clock()});
  assert.equal(receipt.state_changed,true);assert.equal(receipt.cleanup_generation,1);
  assert.equal((await f.plugin.projects()).items[0]!.latest!.sequence,'4');
});

test('a new closed dataset accepts no normal Hook and a business-day baseline rejects earlier facts',async t=>{
  const f=await fixture(t),today=Math.floor((f.at.getTime()+28800000)/86400000)*86400000-28800000;
  await f.db.query('UPDATE data_identity SET collection_baseline_at=$1,collection_enabled=false',[new Date(today)]);
  const blocked=await f.db.ingest(f.envelope(f.context(f.observation('1'))),{admissionEpoch:1,receivedAt:f.at});
  assert.deepEqual(blocked,{outcome:'rejected',reason:'collection_disabled'});
  await assert.rejects(f.plugin.save(f.observation('1'),{userId:f.user}),{code:'collection_unavailable'});
  await f.db.query('UPDATE data_identity SET collection_enabled=true');
  const old={...f.envelope(f.context(f.observation('2'))),occurred_at:new Date(today-1).toISOString()};
  assert.deepEqual(await f.db.ingest(old,{admissionEpoch:1,receivedAt:f.at}),{outcome:'rejected',reason:'before_collection_baseline'});
  await assert.rejects(f.plugin.save({...f.observation('3'),observed_at:new Date(today-1).toISOString()},{userId:f.user}),{code:'project_expired'});
  assert.equal((await f.hook.list(f.login.token)).total,0);assert.equal((await f.plugin.projects()).total,0);
});

test('official daily synchronization cannot query before the new baseline or while collection is closed',async t=>{
  const f=await fixture(t),today=Math.floor((f.at.getTime()+28800000)/86400000)*86400000-28800000;
  await f.db.query('UPDATE data_identity SET collection_baseline_at=$1',[new Date(today)]);
  const day=(value:number)=>new Date(value+28800000).toISOString().slice(0,10);
  const store=createUsageSnapshotStore(f.db,{providerAccount:'unified-synthetic',clock:()=>f.at});
  await assert.rejects(store.begin(f.user,day(today-86400000)),{code:'invalid_usage_day'});
  await f.db.query('UPDATE data_identity SET collection_enabled=false');
  await assert.rejects(store.begin(f.user,day(today)),{code:'collection_disabled'});
});

test('an uncleared out-of-order confirmation is retained without replacing a newer failure',async t=>{
  const f=await fixture(t);
  await f.plugin.save(f.observation('1'),{userId:f.user});
  await f.plugin.save(f.observation('3','failed','timeout'),{userId:f.user});
  await f.plugin.save(f.observation('2'),{userId:f.user});
  const project=(await f.plugin.projects()).items[0]!;
  assert.equal(project.latest!.sequence,'3');assert.equal(project.latest!.state,'failed');assert.equal(project.confirmed!.sequence,'2');
});
