import {submitCleanupConfirmed} from '../helpers/cleanup-acceptance.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {HookEnvelope,ProjectContext} from '@adi/contracts';
import {connectionString,testDatabase,testPostgresCommand} from '../../../storage/test/helpers.js';
import {openDatabase} from '../../../storage/src/index.js';
import {createIdentityService} from '../../src/identity.js';
import {createProjectInventoryService} from '../../src/project-inventory.js';
import {createCleanupService} from '../../src/cleanup.js';
import {createRetentionService} from '../../src/retention.js';
import {createOrganizationService} from '../../src/organization.js';
import {createRepositoryAllowlistService} from '../../src/project-repositories.js';
import {createCleanupCheckpoint,createRecoveryService} from '../../src/recovery.js';
import {createBackupService} from '../../src/backup.js';
import {createRecoveryAccessService} from '../../src/recovery-access.js';
import {readRecoveryArtifact} from '../../../storage/src/recovery-artifact.js';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';

async function fixture(t:TestContext){
  const db=await testDatabase(t);await db.migrate();const now=new Date();
  await db.ensurePartitions(new Date(now.getTime()-370*86400000),new Date(now.getTime()+86400000));
  const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const seed=await identity.bootstrap({email:'projects@example.invalid',name:'项目测试'});const first=await identity.login('projects@example.invalid',seed.temporaryPassword);
  const root=await identity.changePassword(first.token,seed.temporaryPassword,'synthetic-project-password');
  const installation=randomUUID();await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,root.user.user_id,'e'.repeat(64),'合成凭据']);
  const envelope=(project?:ProjectContext,session='session-one'):HookEnvelope=>({schema_version:2,installation_id:installation,client_event_id:randomUUID(),occurred_at:now.toISOString(),event_type:'UserPromptSubmit',source_session_id:session,payload:{cwd:'/synthetic/project',prompt:'https://dialogue-only.example.invalid/not-a-remote.git'},...(project?{project}:{})});
  const context=(collector:string=randomUUID(),sequence='1'):ProjectContext=>({collector_id:collector,platform:'macos',workspace:'/synthetic/project',unresolved_reason:null,observation:{id:randomUUID(),sequence,observed_at:now.toISOString(),state:'repository',reason:null,git_root:'/synthetic/project',remotes:[{name:'origin',direction:'fetch',address:'https://user:synthetic-secret@10.2.3.4/team/app.git'},{name:'origin',direction:'push',address:'https://git.example.com/team/app.git'}]}});
  return {db,identity,root,now,envelope,context,service:createProjectInventoryService(db,identity),ingest:(value:HookEnvelope)=>db.ingest(value,{admissionEpoch:1,receivedAt:now})};
}

async function jitReader(t:TestContext,f:Awaited<ReturnType<typeof fixture>>,failList=false){
  const db=openDatabase({connectionString,schema:f.db.schema,maxConnections:1});t.after(()=>db.close());
  await db.query('SET jit=on');
  const pid=(await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const transaction=db.transaction.bind(db),observed:string[]=[];
  db.transaction=action=>transaction(sql=>action(new Proxy(sql,{get(target,key){
    if(key!=='query')return Reflect.get(target,key);
    return async(statement:string,values?:unknown[])=>{
      if(/^(WITH eligible AS MATERIALIZED|SELECT s\.user_id FROM project_streams|WITH linked AS MATERIALIZED)/.test(statement)){
        const state=(await target.query<{jit:string;read_only:string;pid:number}>("SELECT current_setting('jit') AS jit,current_setting('transaction_read_only') AS read_only,pg_backend_pid() AS pid")).rows[0]!;
        assert.equal(state.pid,pid,'the single-connection reader must use the same physical PostgreSQL connection');
        assert.equal(state.read_only,'on','project reads keep the readonly transaction');
        assert.equal(state.jit,'off','the real project query must avoid JIT compilation inside its transaction');
        observed.push(statement.startsWith('WITH eligible')?'list':statement.startsWith('WITH linked')?'sessions':'project');
        if(failList&&statement.startsWith('WITH eligible'))await target.query('SELECT 1/0');
      }
      return target.query(statement,values);
    };
  }})));
  const identity=createIdentityService(db,{emailDomains:['example.invalid']}),service=createProjectInventoryService(db,identity);
  const restored=async()=>{assert.equal((await db.query<{jit:string}>('SHOW jit')).rows[0]!.jit,'on','the transaction must restore connection JIT after commit or rollback');assert.equal((await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,pid);};
  return {db,service,observed,restored};
}

test('project reads use transaction-local JIT settings while preserving real project and session pagination',async t=>{
  const f=await fixture(t),context=f.context();await f.ingest(f.envelope(context,'first-session'));await f.ingest(f.envelope(context,'second-session'));await f.ingest(f.envelope(f.context(),'other-project'));
  const reader=await jitReader(t,f);
  const first=await reader.service.list(f.root.token,{limit:1});assert.equal(first.total,2);assert.equal(first.items.length,1);assert.ok(first.next_cursor);await reader.restored();
  const second=await reader.service.list(f.root.token,{limit:1,cursor:first.next_cursor});assert.equal(second.total,2);assert.equal(second.items.length,1);assert.equal(second.next_cursor,null);assert.notEqual(first.items[0]!.id,second.items[0]!.id);await reader.restored();
  const project=[...first.items,...second.items].find(row=>row.collector_id===context.collector_id)!;assert.equal(project.session_count,2);
  const sessions=await reader.service.sessions(f.root.token,project.id,{limit:1});assert.equal(sessions.total,2);assert.equal(sessions.items.length,1);assert.ok(sessions.next_cursor);await reader.restored();
  const next=await reader.service.sessions(f.root.token,project.id,{limit:1,cursor:sessions.next_cursor});assert.equal(next.total,2);assert.equal(next.items.length,1);assert.equal(next.next_cursor,null);assert.notEqual(sessions.items[0]!.session_id,next.items[0]!.session_id);assert.ok([...sessions.items,...next.items].every(row=>row.readable));await reader.restored();
  assert.deepEqual(reader.observed,['list','list','project','sessions','project','sessions']);
});

test('project transaction-local JIT settings restore after a real SQL error and a missing project rollback',async t=>{
  const f=await fixture(t);await f.ingest(f.envelope(f.context()));const reader=await jitReader(t,f,true);
  await assert.rejects(reader.service.list(f.root.token),{code:'22012'});await reader.restored();
  await assert.rejects(reader.service.sessions(f.root.token,randomUUID()),{code:'not_found'});await reader.restored();
  assert.deepEqual(reader.observed,['list','project']);
});

test('real project contexts group sessions by authenticated user, collector instance and workspace, while old dialogue URLs create no project',async t=>{
  const f=await fixture(t);await f.ingest(f.envelope());assert.equal((await f.service.list(f.root.token)).total,0);
  const first=f.context();await f.ingest(f.envelope(first));await f.ingest(f.envelope(first,'session-two'));
  const second=f.context();await f.ingest(f.envelope(second));
  const listed=await f.service.list(f.root.token);assert.equal(listed.total,2);
  const row=listed.items.find(item=>item.collector_id===first.collector_id)!;assert.ok(row);assert.equal(row.workspace,'/synthetic/project');assert.equal(row.session_count,2);
  assert.equal(row.source_hook_session_id,'session-one','a cached Hook must not replace the original probe source session');
  assert.deepEqual(row.remotes.map(item=>[item.address,item.source_tag]),[['https://10.2.3.4/team/app.git','department'],['https://git.example.com/team/app.git','personal']]);
  assert.equal(JSON.stringify(listed).includes('synthetic-secret'),false);assert.equal(JSON.stringify(listed).includes('dialogue-only'),false);
});

test('project inventory stores and returns an address set while legacy cached observations retain their identity',async t=>{
  const f=await fixture(t),context=f.context();
  context.observation!.remotes=[
    {name:'origin',direction:'fetch',address:'https://user:synthetic-secret@10.2.3.4/team/app.git'},
    {name:'origin',direction:'push',address:'https://10.2.3.4/team/app.git'},
    {name:'upstream',direction:'fetch',address:'https://git.example.com/team/app.git'},
  ];
  await f.ingest(f.envelope(context));
  const addresses=[{address:'https://10.2.3.4/team/app.git'},{address:'https://git.example.com/team/app.git'}];
  const stored=await f.db.query<{evidence:{remotes:unknown}}>('SELECT evidence FROM project_observations WHERE id=$1',[context.observation!.id]);
  assert.deepEqual(stored.rows[0]!.evidence.remotes,addresses);
  // Keep a pre-upgrade row intact: old fetch/push evidence can be read and replayed.
  const legacy=context.observation!.remotes.map(remote=>({...remote,address:remote.address!.replace('user:synthetic-secret@','')}));
  await f.db.query("UPDATE project_observations SET evidence=jsonb_set(evidence,'{remotes}',$2::jsonb) WHERE id=$1",[context.observation!.id,JSON.stringify(legacy)]);
  const cached=await f.ingest(f.envelope(context,'second-session'));assert.equal(cached.outcome,'committed');
  assert.equal((await f.db.query('SELECT 1 FROM project_observations WHERE id=$1',[context.observation!.id])).rowCount,1);
  const listed=await f.service.list(f.root.token);assert.equal(listed.total,1);assert.equal(listed.items[0]!.session_count,2);
  assert.deepEqual(listed.items[0]!.remotes.map(remote=>({address:remote.address})),addresses);
  assert.ok(listed.items[0]!.remotes.every(remote=>!('name' in remote)&&!('direction' in remote)));
  assert.deepEqual((await f.db.query<{evidence:{remotes:unknown}}>('SELECT evidence FROM project_observations WHERE id=$1',[context.observation!.id])).rows[0]!.evidence.remotes,legacy);
  const current=f.context(context.collector_id,'2');current.observation!.remotes=addresses;await f.ingest(f.envelope(current));
  assert.deepEqual((await f.service.list(f.root.token)).items[0]!.remotes.map(remote=>({address:remote.address})),addresses);
});

test('new failures retain the last confirmed remote, while explicit non-Git and no-remote results permanently supersede it',async t=>{
  const f=await fixture(t),context=f.context();await f.ingest(f.envelope(context));
  const send=async(sequence:string,state:string)=>{
    const value=f.context(context.collector_id,sequence);value.observation!.state=state;
    if(state==='failed'){value.observation!.reason='timeout';value.observation!.git_root=null;value.observation!.remotes=[];}
    if(state==='not_git'){value.observation!.git_root=null;value.observation!.remotes=[];}
    if(state==='no_remote')value.observation!.remotes=[];
    await f.ingest(f.envelope(value));return value;
  };
  await send('3','failed');let item=(await f.service.list(f.root.token)).items[0]!;
  assert.equal(item.state,'failed');assert.equal(item.unconfirmed,true);assert.equal(item.remotes.length,2);
  await send('2','not_git');item=(await f.service.list(f.root.token)).items[0]!;
  assert.equal(item.state,'failed');assert.equal(item.confirmed_state,'not_git');assert.deepEqual(item.remotes,[]);
  await send('4','no_remote');await send('5','failed');item=(await f.service.list(f.root.token)).items[0]!;
  assert.equal(item.confirmed_state,'no_remote');assert.deepEqual(item.remotes,[]);
  const replay=await f.ingest(f.envelope(context,'cached-old-session'));assert.equal(replay.outcome,'committed');
  assert.deepEqual((await f.service.list(f.root.token)).items[0]!.remotes,[]);
});

test('same sequence with another observation identity is quarantined without losing the normal Hook',async t=>{
  const f=await fixture(t),context=f.context();await f.ingest(f.envelope(context));
  const conflict={...context,observation:{...context.observation!,id:randomUUID()}};
  const result=await f.ingest(f.envelope(conflict,'conflicting-source'));assert.equal(result.outcome,'committed');
  assert.equal(result.outcome==='committed'?result.project_outcome:null,'conflict');
  assert.equal((await f.service.list(f.root.token)).items[0]!.session_count,1);
});

test('cached old evidence expires by probe time even while newer Hooks remain, and a recent failure does not revive its remotes',async t=>{
  const f=await fixture(t),context=f.context();
  context.observation!.observed_at=new Date(f.now.getTime()-364*86400000).toISOString();await f.ingest(f.envelope(context));
  await f.ingest(f.envelope(context,'fresh-cache-hook'));
  assert.equal((await f.service.list(f.root.token)).items[0]!.confirmed_at,context.observation!.observed_at);
  const later=createProjectInventoryService(f.db,f.identity,{clock:()=>new Date(f.now.getTime()+2*86400000)});
  const expired=(await later.list(f.root.token)).items[0]!;
  assert.equal(expired.current_available,false);assert.equal(expired.confirmed_at,null);assert.deepEqual(expired.remotes,[]);
  const failure=f.context(context.collector_id,'2');Object.assign(failure.observation!,{state:'failed',reason:'timeout',git_root:null,remotes:[]});
  await f.ingest(f.envelope(failure));const row=(await later.list(f.root.token)).items[0]!;
  assert.equal(row.state,'failed');assert.equal(row.confirmed_at,null);assert.deepEqual(row.remotes,[]);
});

test('cleared probe evidence is hidden immediately and cannot be restored by a fresh Hook carrying its cache',async t=>{
  const f=await fixture(t),context=f.context();const old=new Date(f.now.getTime()-86400000);context.observation!.observed_at=old.toISOString();await f.ingest(f.envelope(context));
  await f.db.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.root.user.user_id,old,new Date(old.getTime()+1000)]);
  const cleared=(await f.service.list(f.root.token)).items[0]!;
  assert.equal(cleared.current_available,false);assert.equal(cleared.confirmed_at,null);assert.deepEqual(cleared.remotes,[]);
  const result=await f.ingest(f.envelope(context,'cached-after-cleanup'));assert.equal(result.outcome,'committed');
  assert.equal(result.outcome==='committed'?result.project_outcome:null,'cleared');
  const cached=(await f.service.list(f.root.token)).items[0]!;assert.equal(cached.current_available,false);assert.deepEqual(cached.remotes,[]);
});

test('physical cleanup erases a newer confirmation without promoting an older repository or accepting its cleaned cache',async t=>{
  const f=await fixture(t),original=f.context();const old=new Date(f.now.getTime()-3*86400000);
  original.observation!.observed_at=old.toISOString();await f.ingest({...f.envelope(original),occurred_at:old.toISOString()});
  const cleared=f.context(original.collector_id,'2'),target=new Date(f.now.getTime()-2*86400000);
  Object.assign(cleared.observation!,{observed_at:target.toISOString(),state:'not_git',git_root:null,remotes:[]});await f.ingest({...f.envelope(cleared),occurred_at:target.toISOString()});
  const failed=f.context(original.collector_id,'3');Object.assign(failed.observation!,{state:'failed',reason:'timeout',git_root:null,remotes:[]});await f.ingest(f.envelope(failed));
  const directory=await mkdtemp(join(tmpdir(),'adi-project-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cleanup=createCleanupService(f.db,f.identity,{journal:createCleanupJournal(directory),batchSize:2});
  const preview=await cleanup.preview(f.root.token,{user_id:f.root.user.user_id,from:target.toISOString(),to:new Date(target.getTime()+1000).toISOString()});
  const job=await submitCleanupConfirmed(cleanup,f.root.token,{preview_id:preview.preview_id,user_id:f.root.user.user_id,...preview.range,confirmation_email:f.root.user.email},randomUUID());
  let loops=0;while(await cleanup.runOne())assert.ok(++loops<100);
  assert.equal((await cleanup.status(f.root.token,job.job_id)).status,'succeeded');
  assert.equal((await f.db.query('SELECT 1 FROM project_observations WHERE id=$1',[cleared.observation!.id])).rowCount,0,'physical removal must include the Git evidence, not only its source Hook');
  const epoch=(await f.db.query<{ingest_epoch:number}>('SELECT ingest_epoch FROM users WHERE id=$1',[f.root.user.user_id])).rows[0]!.ingest_epoch;
  const replay=await f.db.ingest(f.envelope(cleared,'cleaned-cache'),{admissionEpoch:epoch,receivedAt:f.now});assert.equal(replay.outcome,'committed',JSON.stringify(replay));
  assert.equal(replay.outcome==='committed'?replay.project_outcome:null,'cleared');
  const row=(await f.service.list(f.root.token)).items[0]!;assert.equal(row.state,'failed');assert.equal(row.confirmed_at,null);assert.deepEqual(row.remotes,[]);
});

test('rolling retention physically deletes expired Git evidence even when a fresh cached Hook still references the project',async t=>{
  const f=await fixture(t),context=f.context();const old=new Date(f.now.getTime()-364*86400000);
  context.observation!.observed_at=old.toISOString();await f.ingest({...f.envelope(context),occurred_at:old.toISOString()});await f.ingest(f.envelope(context,'current-cache-hook'));
  const failure=f.context(context.collector_id,'2');Object.assign(failure.observation!,{state:'failed',reason:'git_missing',git_root:null,remotes:[]});await f.ingest(f.envelope(failure));
  const clock=()=>new Date(f.now.getTime()+2*86400000),retention=createRetentionService(f.db,{clock,batchSize:2});
  let loops=0;while(await retention.runOne())assert.ok(++loops<300);
  assert.equal((await retention.status()).phase,'idle');
  assert.equal((await f.db.query('SELECT 1 FROM project_observations WHERE id=$1',[context.observation!.id])).rowCount,0);
  const active=await f.identity.login('projects@example.invalid','synthetic-project-password');
  const reader=createProjectInventoryService(f.db,f.identity,{clock});const row=(await reader.list(active.token)).items[0]!;
  assert.equal(row.state,'failed');assert.deepEqual(row.remotes,[]);assert.equal(row.confirmed_at,null);
  const replay=await f.ingest(f.envelope(context,'expired-cache'));assert.equal(replay.outcome,'committed');
  assert.equal(replay.outcome==='committed'?replay.project_outcome:null,'expired');
});

test('department filters select current people after a transfer without changing project identity or repository classification',async t=>{
  const f=await fixture(t);await f.ingest(f.envelope(f.context()));let at=new Date();
  const org=createOrganizationService(f.db,f.identity,{clock:()=>at});const a=await org.createDepartment(f.root.token,'项目人员甲部门'),b=await org.createDepartment(f.root.token,'项目人员乙部门');
  const member=await org.addMember(f.root.token,a.id,{email:f.root.user.email,attach_existing:true});
  const reader=createProjectInventoryService(f.db,f.identity,{clock:()=>at});
  const before=await reader.list(f.root.token,{department_id:a.id});assert.equal(before.total,1);
  assert.equal((await reader.list(f.root.token,{department_id:b.id})).total,0);
  at=new Date(at.getTime()+1000);await org.transferMember(f.root.token,member.user_id,{target_department_id:b.id,version:member.version});
  assert.equal((await reader.list(f.root.token,{department_id:a.id})).total,0);
  const after=await reader.list(f.root.token,{department_id:b.id});assert.equal(after.total,1);
  assert.equal(after.items[0]!.id,before.items[0]!.id);assert.deepEqual(after.items[0]!.remotes,before.items[0]!.remotes);
});

test('equivalent Windows path spelling preserves a cached observation but case-distinct project paths are not guessed together',async t=>{
  const f=await fixture(t),context=f.context();context.platform='windows';context.workspace='c:\\Work\\Project';context.observation!.git_root='C:\\Work\\Project';
  await f.ingest(f.envelope(context));
  const same={...context,workspace:'C:/Work/Project/'};
  const cached=await f.ingest(f.envelope(same,'same-directory'));assert.equal(cached.outcome,'committed');assert.equal(cached.outcome==='committed'?cached.project_outcome:null,'cached');
  const distinct=f.context(context.collector_id,'2');distinct.platform='windows';distinct.workspace='C:/work/Project';distinct.observation!.git_root='C:/work/Project';await f.ingest(f.envelope(distinct));
  const list=await f.service.list(f.root.token);assert.equal(list.total,2);assert.equal(list.items.find(row=>row.workspace===context.workspace)?.session_count,2);
});

test('allowlist changes reclassify the retained confirmation without changing probe time or hiding the latest failure',async t=>{
  const f=await fixture(t),context=f.context();await f.ingest(f.envelope(context));
  const failure=f.context(context.collector_id,'2');Object.assign(failure.observation!,{state:'failed',reason:'inaccessible',git_root:null,remotes:[]});await f.ingest(f.envelope(failure));
  const before=(await f.service.list(f.root.token)).items[0]!,rules=createRepositoryAllowlistService(f.db,f.identity);
  const rule=await rules.create(f.root.token,{kind:'host',value:'git.example.com'});
  const after=(await f.service.list(f.root.token)).items[0]!;
  assert.deepEqual(after.remotes.map(remote=>remote.source_tag),['department','department']);assert.equal(after.state,'failed');assert.equal(after.unconfirmed,true);
  assert.equal(after.observed_at,before.observed_at);assert.equal(after.confirmed_at,before.confirmed_at);
  await rules.remove(f.root.token,rule.id,rule.version);assert.deepEqual((await f.service.list(f.root.token)).items[0]!.remotes.map(remote=>remote.source_tag),['department','personal']);
});

test('an older valid probe arriving after a newer one still links its real Hook session without replacing the latest state',async t=>{
  const f=await fixture(t),latest=f.context(undefined,'3');Object.assign(latest.observation!,{state:'failed',reason:'timeout',git_root:null,remotes:[]});await f.ingest(f.envelope(latest,'later-session'));
  const earlier=f.context(latest.collector_id,'1');Object.assign(earlier.observation!,{state:'failed',reason:'git_missing',git_root:null,remotes:[]});await f.ingest(f.envelope(earlier,'earlier-session'));
  const row=(await f.service.list(f.root.token)).items[0]!;assert.equal(row.reason,'timeout');assert.equal(row.session_count,2);
});

test('cleanup acceptance freezes project ordering before later probes and source checkpoints verify that frozen proof',async t=>{
  const f=await fixture(t),context=f.context();const target=new Date(f.now.getTime()-86400000);context.observation!.observed_at=target.toISOString();
  await f.ingest({...f.envelope(context),occurred_at:target.toISOString()});
  const directory=await mkdtemp(join(tmpdir(),'adi-project-accept-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory);
  const cleanup=createCleanupService(f.db,f.identity,{journal});const preview=await cleanup.preview(f.root.token,{user_id:f.root.user.user_id,from:target.toISOString(),to:new Date(target.getTime()+1000).toISOString()});
  const input={preview_id:preview.preview_id,user_id:f.root.user.user_id,...preview.range,confirmation_email:f.root.user.email},key=randomUUID();
  const job=await submitCleanupConfirmed(cleanup,f.root.token,input,key);const dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;
  const proof=await journal.openProof(dataset,job.job_id),barriers=[];for await(const page of proof.projects())barriers.push(...page);
  assert.equal(barriers.length,1);assert.equal(barriers[0]!.confirmed_sequence,'1');assert.equal(JSON.stringify(barriers).includes('/synthetic'),false);
  await f.ingest(f.envelope(f.context(context.collector_id,'2'),'after-acceptance'));
  assert.equal((await submitCleanupConfirmed(cleanup,f.root.token,input,key)).job_id,job.job_id);
  assert.equal((await journal.openProof(dataset,job.job_id)).accepted_digest,proof.accepted_digest);
  await createCleanupCheckpoint(f.db,journal,dataset);
  await f.db.query('UPDATE cleanup_project_barriers SET latest_sequence=3 WHERE job_id=$1',[job.job_id]);
  await assert.rejects(createCleanupCheckpoint(f.db,journal,dataset),{code:'cleanup_checkpoint_incomplete'});
});

test('a real older PostgreSQL backup cannot revive a repository superseded by a later cleared confirmation',{timeout:30000},async t=>{
  const f=await fixture(t),original=f.context(),other=f.context();const old=new Date(f.now.getTime()-3*86400000),target=new Date(f.now.getTime()-2*86400000);
  original.observation!.observed_at=old.toISOString();other.observation!.observed_at=old.toISOString();other.workspace='/synthetic/unrelated';other.observation!.git_root=other.workspace;
  await f.ingest({...f.envelope(original),occurred_at:old.toISOString()});await f.ingest({...f.envelope(other),occurred_at:old.toISOString()});
  const directory=await mkdtemp(join(tmpdir(),'adi-project-restore-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(join(directory,'journal'));
  const dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;
  const backup=createBackupService(f.db,journal,{directory,dump:testPostgresCommand('pg_dump'),maxBytes:'50000000',maxDurationMs:15000});
  const saved=await backup.create(dataset),artifact=await readRecoveryArtifact(saved.path,saved.digest) as {archive:{file:string}};
  const archive=await readFile(join(dirname(saved.path),artifact.archive.file));
  const cleared=f.context(original.collector_id,'2');Object.assign(cleared.observation!,{observed_at:target.toISOString(),state:'not_git',git_root:null,remotes:[]});await f.ingest({...f.envelope(cleared),occurred_at:target.toISOString()});
  const cleanup=createCleanupService(f.db,f.identity,{journal}),preview=await cleanup.preview(f.root.token,{user_id:f.root.user.user_id,from:target.toISOString(),to:new Date(target.getTime()+1000).toISOString()});
  await submitCleanupConfirmed(cleanup,f.root.token,{preview_id:preview.preview_id,user_id:f.root.user.user_id,...preview.range,confirmation_email:f.root.user.email},randomUUID());
  const checkpoint=await createCleanupCheckpoint(f.db,journal,dataset),access=createRecoveryAccessService(f.db,journal,{emailDomains:['example.invalid']});const accessSnapshot=await access.exportSnapshot(checkpoint);
  // Restore only this guarded, synthetic schema; no service is serving it.
  await f.db.query(`DROP SCHEMA "${f.db.schema}" CASCADE`);
  await new Promise<void>((resolve,reject)=>{
    const command=testPostgresCommand('pg_restore'),child=spawn(command.file,[...command.args,'--no-owner','--no-privileges','--single-transaction'],{env:command.env,stdio:['pipe','ignore','ignore']});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Synthetic project restore failed')));child.stdin.on('error',()=>{});child.stdin.end(archive);
  });
  const recovery=createRecoveryService(f.db,journal),run=await recovery.quarantine(dataset);await recovery.prepare(run.id,checkpoint);let steps=0;while(await recovery.step(run.id))assert.ok(++steps<100);
  const review=await access.review(run.id,accessSnapshot,f.root.user.email);await access.apply(run.id,review.review_id,accessSnapshot);
  const credential=await access.issueCredential(run.id,review.review_id);steps=0;while(await access.resumeBackground(run.id))assert.ok(++steps<100);await access.release(run.id,credential,credential.email);
  const temporary=await f.identity.login(credential.email,credential.temporary_password),active=await f.identity.changePassword(temporary.token,credential.temporary_password,'synthetic-restored-password');
  const result=await f.service.list(active.token);assert.equal(result.total,2);
  assert.equal(result.items.find(item=>item.collector_id===other.collector_id)?.current_available,true);
  const restored=result.items.find(item=>item.collector_id===original.collector_id)!;
  assert.equal(restored.current_available,false);assert.equal(restored.history_only,true);assert.deepEqual(restored.remotes,[]);
  assert.equal((await f.db.query('SELECT 1 FROM project_observations WHERE id=$1',[original.observation!.id])).rowCount,1,'outside-range historical evidence remains stored but must not be promoted by restore');
  assert.equal((await createCleanupCheckpoint(f.db,journal,dataset)).operations,1,'a recovered source can export the same project proof for a subsequent restore');
});

test('cleanup preview counts probe evidence separately from newer carrying Hooks and rejects a changed project preview',async t=>{
  const f=await fixture(t),context=f.context(),target=new Date(f.now.getTime()-86400000);context.observation!.observed_at=target.toISOString();await f.ingest(f.envelope(context));
  const directory=await mkdtemp(join(tmpdir(),'adi-project-preview-'));t.after(()=>rm(directory,{recursive:true,force:true}));const cleanup=createCleanupService(f.db,f.identity,{journal:createCleanupJournal(directory)});
  const preview=await cleanup.preview(f.root.token,{user_id:f.root.user.user_id,from:target.toISOString(),to:new Date(target.getTime()+1000).toISOString()});
  assert.equal(preview.counts.hook_events,0);assert.equal(preview.counts.project_observations,1);assert.equal(preview.counts.project_links,0);
  const next=f.context(context.collector_id,'2');next.observation!.observed_at=new Date(target.getTime()+500).toISOString();await f.ingest(f.envelope(next));
  await assert.rejects(cleanup.submit(f.root.token,{preview_id:preview.preview_id,user_id:f.root.user.user_id,...preview.range,confirmation_email:f.root.user.email},randomUUID()),{code:'cleanup_preview_stale'});
});

test('project search and pagination are bounded and scoped while legacy date parameters do not filter the inventory',async t=>{
  const f=await fixture(t);
  for(const workspace of ['/synthetic/first','/synthetic/second','/synthetic/100%_match']){const context=f.context();context.workspace=workspace;await f.ingest(f.envelope(context));}
  const first=await f.service.list(f.root.token,{limit:1,from:'1999-01-01',to:'not-a-date'});assert.equal(first.total,3);assert.equal(first.items.length,1);assert.ok(first.next_cursor);
  const second=await f.service.list(f.root.token,{limit:1,cursor:first.next_cursor});assert.equal(second.items.length,1);assert.ok(second.next_cursor);
  const third=await f.service.list(f.root.token,{limit:1,cursor:second.next_cursor,from:'tomorrow'});assert.equal(third.items.length,1);assert.equal(third.next_cursor,null);
  assert.equal(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size,3);
  const literal=await f.service.list(f.root.token,{search:'%_'});assert.deepEqual(literal.items.map(row=>row.workspace),['/synthetic/100%_match']);
  await assert.rejects(f.service.list(f.root.token,{limit:1,search:'different',cursor:first.next_cursor}),{code:'invalid_cursor'});
  await assert.rejects(f.service.list(f.root.token,{department_id:randomUUID()}),{code:'invalid_scope'});
});

test('project sessions are deduplicated, independently paged and distinguish retained links from currently readable content',async t=>{
  const f=await fixture(t),context=f.context(),old=new Date(f.now.getTime()-100*86400000);context.observation!.observed_at=old.toISOString();
  await f.ingest({...f.envelope(context,'old-hook-session'),occurred_at:old.toISOString()});
  await f.ingest(f.envelope(context,'recent-hook-session'));await f.ingest(f.envelope(context,'recent-hook-session'));
  const project=(await f.service.list(f.root.token)).items[0]!;assert.equal(project.session_count,2);
  const first=await f.service.sessions(f.root.token,project.id,{limit:1});assert.equal(first.total,2);assert.equal(first.items.length,1);assert.ok(first.next_cursor);
  const second=await f.service.sessions(f.root.token,project.id,{limit:1,cursor:first.next_cursor});assert.equal(second.items.length,1);
  const rows=[...first.items,...second.items];assert.equal(rows.find(row=>row.hook_session_id==='old-hook-session')!.readable,false);
  assert.equal(rows.find(row=>row.hook_session_id==='old-hook-session')!.unavailable_reason,'outside_recent_window');
  assert.equal(rows.find(row=>row.hook_session_id==='recent-hook-session')!.readable,true);
  assert.equal(rows.find(row=>row.hook_session_id==='recent-hook-session')!.hook_events,2);
  assert.equal(JSON.stringify(rows).includes('dialogue-only'),false);
});

test('unresolved multi-root Hooks remain pending evidence rather than inventing a project or a personal repository',async t=>{
  const f=await fixture(t);await f.ingest(f.envelope({collector_id:randomUUID(),platform:'macos',workspace:null,unresolved_reason:'ambiguous_workspace',observation:null}));
  const result=await f.service.list(f.root.token);assert.equal(result.total,0);assert.deepEqual(result.items,[]);assert.equal(result.pending_hooks,1);
});

test('cleanup committed after project rows were read prevents the pending response from exposing the cleared snapshot',async t=>{
  const f=await fixture(t);await f.ingest(f.envelope(f.context()));
  const lock=async(table:string)=>{
    let ready!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const work=f.db.transaction(async sql=>{await sql.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);ready();await gate;});await started;return {work,release};
  };
  const waiting=async(table:string)=>{for(let attempt=0;attempt<100;attempt++){if((await f.db.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation=to_regclass($1) AND NOT granted) AS blocked',[`${f.db.schema}.${table}`])).rows[0]!.blocked)return;await delay(10);}throw new Error('Synthetic reader did not reach the database gate');};
  const observations=await lock('project_observations');let rules:Awaited<ReturnType<typeof lock>>|undefined;
  const result=f.service.list(f.root.token).then(value=>({value,error:null}),error=>({value:null,error}));
  try{
    await waiting('project_observations');rules=await lock('repository_allowlist');observations.release();await observations.work;await waiting('repository_allowlist');
    await f.db.transaction(async sql=>{await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.root.user.user_id]);await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.root.user.user_id,new Date(f.now.getTime()-1000),new Date(f.now.getTime()+1000)]);});
    rules.release();await rules.work;const completed=await result;assert.equal(completed.value,null);assert.equal(completed.error?.code,'content_changed');
  }finally{observations.release();rules?.release();await observations.work;await rules?.work;await result;}
});
