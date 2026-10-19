import {submitCleanupConfirmed,confirmCleanupAcceptance,resumeCleanupConfirmed} from '../helpers/cleanup-acceptance.js';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabase,connectionString} from '../../../storage/test/helpers.js';import {createIdentityService} from '../../src/identity.js';import {createCleanupService} from '../../src/cleanup.js';
import {createCleanupCheckpoint,createRecoveryService} from '../../src/recovery.js';
import {createSessionDerivationService} from '../../src/session-derivation.js';import {createSessionReadService} from '../../src/session-reading.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {createUsageModelChecks} from '../../src/usage-model-checks.js';
import {createSessionTokenChecks} from '../../src/session-token-checks.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';import type {ProviderUsageItem} from '../../src/usage-provider.js';
const clock=()=>new Date('2026-09-24T12:00:00Z');
async function fixture(t:TestContext){const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));const identity=createIdentityService(db,{clock,emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'cleanup-root@example.invalid',name:'清理超管'});const initial=await identity.login('cleanup-root@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(initial.token,seed.temporaryPassword,'cleanup-root-password');const owner=randomUUID(),other=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'cleanup-owner@example.invalid','清理目标'),($2,'cleanup-other@example.invalid','保留人员')",[owner,other]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'清理设备')",[installation,owner,'a'.repeat(64)]);
 const put=(id:string,at:string)=>db.ingest({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:'cross-boundary',payload:{prompt:'PRIVATE_PROMPT'}},{admissionEpoch:1,receivedAt:clock()});await put('before','2026-09-21T01:00:00Z');await put('target','2026-09-22T01:00:00Z');await put('after','2026-09-23T01:00:00Z');const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {db,identity,root,owner,other,installation,put,journal:createCleanupJournal(directory),cleanup:createCleanupService(db,identity,{clock}),directory};}
test('cleanup preview is superadmin-only, counts the exact half-open range and contains no original content',async t=>{
 const {db,identity,root,owner,other,cleanup}=await fixture(t);const range={user_id:owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'};const preview=await cleanup.preview(root.token,range);
 assert.equal(preview.target.id,owner);assert.equal(preview.target.email,'cleanup-owner@example.invalid');assert.equal(preview.counts.hook_events,1);assert.equal(preview.counts.sessions,1);assert.equal(preview.range.to,'2026-09-23T00:00:00.000Z');assert.ok(Date.parse(preview.expires_at)>clock().getTime());assert.doesNotMatch(JSON.stringify(preview),/PRIVATE_PROMPT|payload|password_hash/);assert.equal((await db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3);
 const issued=await identity.resetPassword(root.token,other,1);const temp=await identity.login('cleanup-other@example.invalid',issued.temporaryPassword);const employee=await identity.changePassword(temp.token,issued.temporaryPassword,'cleanup-other-password');await assert.rejects(cleanup.preview(employee.token,range),{code:'forbidden'});await assert.rejects(cleanup.preview(root.token,{...range,to:'2026-09-25T00:00:00Z'}),{code:'invalid_cleanup_range'});
});
test('confirmed cleanup hides only the selected range immediately and repeated submission returns the same job',{timeout:20000},async t=>{
 let durable:Promise<string>|undefined;t.after(async()=>{await durable?.catch(()=>undefined);});
 const f=await fixture(t);let writes=0;const worker=createSessionDerivationService(f.db,{clock});while(await worker.runOne()){/* Publish */}const service=createCleanupService(f.db,f.identity,{clock,journal:{...f.journal,accept:record=>durable=(async()=>{if(++writes===1)await delay(2500);return f.journal.accept(record);})()}});const range={user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'},preview=await service.preview(f.root.token,range);
 const input={preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email};const key=randomUUID();let unconfirmed=0;
 const confirmed=()=>confirmCleanupAcceptance(()=>service.submit(f.root.token,input,key),()=>{unconfirmed++;});
 const submitted=await confirmed();assert.ok(unconfirmed>=1,'the retained slow-write control must exercise an unconfirmed response');assert.equal(submitted.status,'queued');assert.equal((await confirmed()).job_id,submitted.job_id);
 const jobs=await service.list(f.root.token,{user_id:f.owner});assert.equal(jobs.items.length,1);assert.equal(jobs.items[0]!.job_id,submitted.job_id);
 const dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;
 assert.equal((await f.journal.readAccepted(dataset,submitted.job_id)).record.user_id,f.owner);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones WHERE user_id=$1',[f.owner])).rows[0]!.n,1);
 const reader=createSessionReadService(f.db,f.identity,{clock});const list=await reader.listAll(f.root.token,{user_id:f.owner,from:'2026-09-20T00:00:00Z',to:'2026-09-24T00:00:00Z'});assert.equal(list.items[0]?.prompt_turns,2);const raw=await reader.fragments(f.root.token,list.items[0]!.id,{mode:'raw'});assert.equal(raw.items.length,2);
 assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3,'submission is a visibility barrier, not a false physical-completion ACK');assert.equal((await service.status(f.root.token,submitted.job_id)).phase,'journal');
 await assert.rejects(service.submit(f.root.token,{...input,to:'2026-09-24T00:00:00Z'},key),{code:'idempotency_conflict'});
});
test('physical cleanup proceeds in retryable batches only after a durable recovery manifest and preserves outside facts',async t=>{
 const f=await fixture(t);const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-worker-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory),service=createCleanupService(f.db,f.identity,{clock,journal,batchSize:1});const derive=createSessionDerivationService(f.db,{clock});while(await derive.runOne()){/* publish originals */}
 const cachedSession=(await f.db.query('SELECT id FROM sessions WHERE user_id=$1',[f.owner])).rows[0]!.id;const predictionReader=createSessionReadService(f.db,f.identity,{clock});assert.ok((await predictionReader.simulation(f.root.token,cachedSession,{})).computed_at);
 const tokenChecks=createSessionTokenChecks(f.db,{clock});await tokenChecks.enqueue(cachedSession);await tokenChecks.runOne();assert.equal((await predictionReader.tokenCheck(f.root.token,cachedSession)).state,'current');
 const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});const submitted=await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());let preparing=0;while((await service.status(f.root.token,submitted.job_id)).phase!=='events'){assert.ok(++preparing<20);assert.equal(await service.runOne(),true);assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3);}
 const dataset=(await f.db.query('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id as string;const receipt=await journal.open(dataset,submitted.job_id);assert.equal(receipt.record.user_id,f.owner);assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3);
 let loops=0;while(await service.runOne())assert.ok(++loops<80);assert.equal((await service.status(f.root.token,submitted.job_id)).status,'succeeded');assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,2);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_simulation_cache WHERE session_id=$1',[cachedSession])).rows[0]!.n,0);assert.equal((await predictionReader.simulation(f.root.token,cachedSession,{})).simulated_input_tokens,null);
 while(await derive.runOne()){/* republish remaining facts */}const reader=createSessionReadService(f.db,f.identity,{clock});const list=await reader.listAll(f.root.token,{user_id:f.owner});assert.equal(list.items[0]?.prompt_turns,2);assert.equal((await reader.detail(f.root.token,list.items[0]!.id)).projection_ready,true);
 assert.equal((await predictionReader.tokenCheck(f.root.token,cachedSession)).result,null);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[cachedSession])).rows[0]!.n,0);
 assert.deepEqual(await f.put('late-cleared','2026-09-22T02:00:00Z'),{outcome:'rejected',reason:'data_cleared'});
});
test('cleanup invalidates and removes overlapping official observations while preserving other days and people',async t=>{
 let durable:Promise<string>|undefined;t.after(async()=>{await durable?.catch(()=>undefined);});
 const f=await fixture(t);const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-usage-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory);let writes=0;
 const service=createCleanupService(f.db,f.identity,{clock,journal:{...journal,accept:record=>durable=(async()=>{if(++writes===1)await delay(2500);return journal.accept(record);})()},batchSize:2});const store=createUsageSnapshotStore(f.db,{clock,providerAccount:'cleanup-source'});
 async function publish(user:string,email:string,date:string,tokens:string){const draft=await store.begin(user,date),query=draft.parts[0]!.query;const item:ProviderUsageItem={billing_session_id:`bill-${date}`,provider_user_id:`provider-${user}`,email,start_time:String(query.start_time+3600),client:'ide',scene:'Chat',model_name:'Synthetic Cleanup',model_type:'Chat',model_source:'Trae',consumption_source:'pay_go',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens,completion_tokens:'0',total_tokens:tokens,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'};await store.stage(draft,0,{items:[item],pagination:{page:1,page_size:200,total:1,total_pages:1},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);}
 await publish(f.owner,'cleanup-owner@example.invalid','2026-09-21','101');await publish(f.owner,'cleanup-owner@example.invalid','2026-09-22','102');await publish(f.other,'cleanup-other@example.invalid','2026-09-22','999');
 const modelChecks=createUsageModelChecks(f.db,{providerAccount:'cleanup-source',clock,provider:{getMemberModelUsage:async query=>({items:[{provider_user_id:`provider-${f.owner}`,email:'cleanup-owner@example.invalid',model_usage:[{model_name:'Synthetic Cleanup',model_type:'Chat',model_source:'Trae',usage:{input_tokens:'102',output_tokens:'0'}}]}],pagination:null,request_id:'cleanup-model',observed_at:clock().toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'user-model-usage',parameters:query}})}});await modelChecks.enqueue(f.owner,'2026-09-22');await modelChecks.runOne();assert.equal((await modelChecks.read(f.owner,'2026-09-22')).state,'matched');

 const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});
 const input={preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},key=randomUUID();let unconfirmed=0;
 const confirmed=()=>confirmCleanupAcceptance(()=>service.submit(f.root.token,input,key),()=>{unconfirmed++;});
 const job=await confirmed();assert.ok(unconfirmed>=1,'slow durable acceptance must exercise the unconfirmed response');
 assert.equal((await confirmed()).job_id,job.job_id);assert.equal((await service.list(f.root.token,{user_id:f.owner})).items.length,1,'same-key retries must not create another cleanup');
 assert.equal((await store.readCurrent(f.owner,'2026-09-22')).status,'invalidated');let loops=0;while(await service.runOne())assert.ok(++loops<90);assert.equal((await service.status(f.root.token,job.job_id)).status,'succeeded');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM usage_model_checks')).rows[0]!.n,0,'physical cleanup removes derived model comparisons as well as original observations');
 assert.equal((await store.readCurrent(f.owner,'2026-09-21')).items[0]?.usage.total_tokens,'101');assert.equal((await store.readCurrent(f.other,'2026-09-22')).items[0]?.usage.total_tokens,'999');assert.equal((await f.db.query("SELECT count(*)::int AS count FROM usage_observations o JOIN usage_snapshot_runs r ON r.id=o.run_id JOIN usage_scopes s ON s.id=r.scope_id WHERE s.user_id=$1 AND s.business_date='2026-09-22'",[f.owner])).rows[0]?.count,0);
});
test('clearing a whole retained session removes its index and old derived copies instead of rebuilding an empty shell',async t=>{
 const f=await fixture(t);const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-empty-'));t.after(()=>rm(directory,{recursive:true,force:true}));const derive=createSessionDerivationService(f.db,{clock});while(await derive.runOne()){/* originals */}const service=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory),batchSize:2});
 const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-20T00:00:00Z',to:'2026-09-24T00:00:00Z'});const job=await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());let loops=0;while(await service.runOne())assert.ok(++loops<100);assert.equal((await service.status(f.root.token,job.job_id)).status,'succeeded');assert.equal((await f.db.query('SELECT count(*)::int AS count FROM sessions WHERE user_id=$1',[f.owner])).rows[0]?.count,0);assert.equal((await f.db.query('SELECT count(*)::int AS count FROM session_derivations WHERE user_id=$1',[f.owner])).rows[0]?.count,0);
});
test('post-cleanup reconstruction preserves microsecond endpoints and exposes a partial-history marker',async t=>{
 const f=await fixture(t);await f.put('micro-last','2026-09-23T02:00:00.000001Z');const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-micro-'));t.after(()=>rm(directory,{recursive:true,force:true}));const service=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory)});const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-20T00:00:00Z',to:'2026-09-22T00:00:00Z'});await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());let count=0;while(await service.runOne())assert.ok(++count<80);const derive=createSessionDerivationService(f.db,{clock});while(await derive.runOne()){/* remaining facts */}
 const reader=createSessionReadService(f.db,f.identity,{clock}),list=await reader.listAll(f.root.token,{user_id:f.owner});const id=list.items[0]!.id;assert.equal((await reader.turns(f.root.token,id)).items.length,3);assert.equal((await reader.detail(f.root.token,id)).partial_history,true);assert.equal((await reader.simulation(f.root.token,id,{})).reason,'partial_history');
});
test('stale, expired, mismatched or unconfigured cleanup submissions never create a barrier',async t=>{
 const f=await fixture(t);let at=clock();const service=createCleanupService(f.db,f.identity,{clock:()=>at,journal:f.journal}),range={user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'};const preview=await service.preview(f.root.token,range);const input={preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email};
 let unconfirmed=0;await assert.rejects(confirmCleanupAcceptance(()=>service.submit(f.root.token,{...input,confirmation_email:'someone-else@example.invalid'},randomUUID()),()=>{unconfirmed++;}),{code:'cleanup_confirmation_mismatch'});assert.equal(unconfirmed,0,'validation errors must propagate without confirmation retries');await f.put('late-preview','2026-09-22T02:00:00Z');await assert.rejects(service.submit(f.root.token,input,randomUUID()),{code:'cleanup_preview_stale'});
 const next=await service.preview(f.root.token,range);at=new Date(clock().getTime()+601000);await assert.rejects(service.submit(f.root.token,{...input,preview_id:next.preview_id},randomUUID()),{code:'cleanup_preview_expired'});await assert.rejects(f.cleanup.submit(f.root.token,input,randomUUID()),{code:'cleanup_unavailable'});assert.equal((await f.db.query('SELECT count(*)::int AS count FROM cleanup_tombstones')).rows[0]?.count,0);
});
test('a missing or corrupted durable manifest stops physical deletion without undoing the visibility barrier',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'adi-cleanup-corrupt-'));t.after(()=>rm(directory,{recursive:true,force:true}));const service=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory)});const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});const job=await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());let count=0;while((await service.status(f.root.token,job.job_id)).phase!=='events'){assert.ok(++count<20);await service.runOne();}
 const dataset=(await f.db.query('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id as string;await writeFile(join(directory,dataset,job.job_id,'manifest.json'),'corrupted');await service.runOne();assert.equal((await service.status(f.root.token,job.job_id)).status,'failed');assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3);assert.equal((await createSessionReadService(f.db,f.identity,{clock}).listAll(f.root.token,{user_id:f.owner})).items[0]?.prompt_turns,2);
});
test('a user-wide cleanup generation does not invalidate unrelated sessions or another persons data',async t=>{
 const f=await fixture(t);const otherInstallation=randomUUID();await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'其他人的设备')",[otherInstallation,f.other,'b'.repeat(64)]);
 const unrelated=await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'unrelated',occurred_at:'2026-09-23T03:00:00Z',event_type:'UserPromptSubmit',source_session_id:'unrelated-session',payload:{prompt:'KEEP'}},{admissionEpoch:1,receivedAt:clock()});const another=await f.db.ingest({schema_version:2,installation_id:otherInstallation,client_event_id:'another-person',occurred_at:'2026-09-22T01:00:00Z',event_type:'UserPromptSubmit',source_session_id:'another-person',payload:{prompt:'KEEP_OTHER_USER'}},{admissionEpoch:1,receivedAt:clock()});if(unrelated.outcome!=='committed'||another.outcome!=='committed')throw new Error('fixture');const derive=createSessionDerivationService(f.db,{clock});while(await derive.runOne()){/* original views */}
 const service=createCleanupService(f.db,f.identity,{clock,journal:f.journal});const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());const reader=createSessionReadService(f.db,f.identity,{clock});assert.equal((await reader.detail(f.root.token,unrelated.sessionId)).projection_ready,true);assert.equal((await reader.detail(f.root.token,unrelated.sessionId)).content_estimate.tokens,null);assert.equal((await reader.detail(f.root.token,another.sessionId)).prompt_turns,1);assert.equal((await reader.detail(f.root.token,another.sessionId)).projection_ready,true);
});
test('revoked execution authority halts deletion, and a newly authorized retry resumes the same operation',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'adi-cleanup-authority-'));t.after(()=>rm(directory,{recursive:true,force:true}));const service=createCleanupService(f.db,f.identity,{clock,journal:createCleanupJournal(directory)}),preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});const job=await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());await f.db.query('DELETE FROM role_grants WHERE user_id=$1',[f.root.user.user_id]);await service.runOne();assert.equal((await f.db.query('SELECT status FROM jobs WHERE id=$1',[job.job_id])).rows[0]?.status,'failed');assert.equal((await f.db.query('SELECT count(*)::int AS count FROM hook_events')).rows[0]?.count,3);
 await f.db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super','2026-09-01Z')",[f.root.user.user_id]);assert.equal((await resumeCleanupConfirmed(service,f.root.token,job.job_id,preview.target.email)).job_id,job.job_id);assert.equal((await resumeCleanupConfirmed(service,f.root.token,job.job_id,preview.target.email)).job_id,job.job_id);let count=0;while(await service.runOne())assert.ok(++count<80);assert.equal((await service.status(f.root.token,job.job_id)).status,'succeeded');
});
test('a confirmed submission has a durable acceptance record before any cleanup worker runs',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'adi-cleanup-accept-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory),cleanup=createCleanupService(f.db,f.identity,{clock,journal});const preview=await cleanup.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});const job=await submitCleanupConfirmed(cleanup,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());
 const dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;const receipt=await journal.readAccepted(dataset,job.job_id);assert.equal(receipt.record.user_id,f.owner);assert.equal(receipt.record.from,'2026-09-22T00:00:00.000Z');assert.equal((await cleanup.status(f.root.token,job.job_id)).phase,'journal');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,3);assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_PROMPT|password/);
});
test('acceptance file failure returns unconfirmed and the same request retries the already-created job',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'adi-acceptance-failure-'));t.after(()=>rm(directory,{recursive:true,force:true}));const {chmod}=await import('node:fs/promises');const journal=createCleanupJournal(directory),cleanup=createCleanupService(f.db,f.identity,{clock,journal}),preview=await cleanup.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'}),input={preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},key=randomUUID();
 await chmod(directory,0o755);await assert.rejects(cleanup.submit(f.root.token,input,key),{code:'cleanup_acceptance_unconfirmed'});let unconfirmed=0;await assert.rejects(confirmCleanupAcceptance(()=>cleanup.submit(f.root.token,input,key),()=>{unconfirmed++;}),{code:'cleanup_acceptance_unconfirmed',status:503});assert.equal(unconfirmed,8,'a permanent journal failure must exhaust the bounded budget and still fail');const jobs=await cleanup.list(f.root.token,{user_id:f.owner});assert.equal(jobs.items.length,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,3);
 await chmod(directory,0o700);const retried=await submitCleanupConfirmed(cleanup,f.root.token,input,key);assert.equal(retried.job_id,jobs.items[0]!.job_id);assert.equal((await cleanup.list(f.root.token,{user_id:f.owner})).items.length,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);
});
test('slow acceptance I/O has a bounded response and a same-key retry shares the in-flight durable write',{timeout:15000},async t=>{
 const f=await fixture(t),real=f.journal;let unblock!:()=>void,entered!:()=>void,stored!:()=>void,deliver!:()=>void;
 const blocked=new Promise<void>(resolve=>{unblock=resolve;}),acceptEntered=new Promise<void>(resolve=>{entered=resolve;}),receiptStored=new Promise<void>(resolve=>{stored=resolve;}),receiptDelivery=new Promise<void>(resolve=>{deliver=resolve;});
 const release=()=>{unblock();deliver();};t.after(release);t.signal.addEventListener('abort',release,{once:true});let writes=0,preparationReads=0,preparing=Promise.resolve(),acceptanceWork:Promise<string>|undefined,releaseOnRetry=false;
 const retryIdentity={...f.identity,async mutate<T>(...args:Parameters<typeof f.identity.mutate<T>>){
  const result=await f.identity.mutate<T>(...args);
  // The next event-loop turn lets cleanup's await continuation join the
  // still-in-flight acceptance before delivering its successful SQL reply.
  if(releaseOnRetry)setImmediate(deliver);return result;
 }};
 // A bounded unconfirmed response can precede journal entry. Keep the real
 // PostgreSQL read, but delay its result so retries exercise that preparation.
 const slowDb={...f.db,async query<Row extends Record<string,unknown>=Record<string,unknown>>(text:string,values?:unknown[]){
  const result=await f.db.query<Row>(text,values);
  if(text.startsWith('SELECT r.*,(SELECT dataset_id FROM data_identity) AS current_dataset FROM cleanup_requests r WHERE job_id=')){preparationReads++;preparing=delay(350);await preparing;}
  // The receipt is genuinely committed. Hold only its response delivery so a
  // retry cannot accidentally begin after completed work leaves the Map.
  if(text.startsWith('UPDATE cleanup_requests SET acceptance_digest=')){stored();await receiptDelivery;}
  return result;
 }};
 const cleanup=createCleanupService(slowDb,retryIdentity,{clock,acceptanceDeadlineMs:100,journal:{...real,accept:record=>{writes++;entered();acceptanceWork=(async()=>{await blocked;if(writes===1)await delay(500);return real.accept(record);})();return acceptanceWork;}}});const preview=await cleanup.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'}),input={preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},key=randomUUID();
 try{
  const started=performance.now();await assert.rejects(cleanup.submit(f.root.token,input,key),{code:'cleanup_acceptance_unconfirmed'});assert.ok(performance.now()-started<1000);await assert.rejects(cleanup.submit(f.root.token,input,key),{code:'cleanup_acceptance_unconfirmed'});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The real acceptance write must begin within the fixture budget')),5000);void acceptEntered.then(()=>{clearTimeout(timer);resolve();});});
  assert.equal(preparationReads,1);assert.equal(writes,1);unblock();
  // Real journal fsync and the PostgreSQL receipt update complete first, while
  // their acceptance Promise remains in flight until the reply gate opens.
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The real acceptance receipt must commit within the fixture budget')),5000);void receiptStored.then(()=>{clearTimeout(timer);resolve();});});
  releaseOnRetry=true;const job=await cleanup.submit(f.root.token,input,key);
  assert.ok(job,'the released durable write must eventually be confirmed');const listed=await cleanup.list(f.root.token,{user_id:f.owner});assert.equal(listed.items.length,1);assert.equal(listed.items[0]!.job_id,job.job_id);assert.equal(writes,1);
  const dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;assert.equal((await real.readAccepted(dataset,job.job_id)).record.user_id,f.owner);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,3);
 }finally{
  release();await preparing;await delay(0);await acceptanceWork?.catch(()=>{});
 }
});

test('source checkpoint export includes every database request and an older checkpoint rejects a later acceptance',async t=>{
 const f=await fixture(t),journal=f.journal,dataset=(await f.db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;const before=await createCleanupCheckpoint(f.db,journal,dataset);assert.equal(before.operations,0);
 const service=createCleanupService(f.db,f.identity,{clock,journal}),preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());const after=await createCleanupCheckpoint(f.db,journal,dataset);assert.equal(after.operations,1);
 const recovery=createRecoveryService(f.db,journal),run=await recovery.quarantine(dataset);await assert.rejects(recovery.prepare(run.id,before),{code:'recovery_checkpoint_mismatch'});await assert.rejects(createCleanupCheckpoint(f.db,journal,dataset),{code:'recovery_quarantined'});await recovery.prepare(run.id,after);let steps=0;while(await recovery.step(run.id))assert.ok(++steps<100);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,2);
});


test('a crashed cleanup process leaves a reclaimable lease and a new process resumes committed batches exactly once', {timeout:30000}, async t => {
 const {spawn}=await import('node:child_process'); const {fileURLToPath}=await import('node:url');
 const f=await fixture(t); await f.put('target-two','2026-09-22T02:00:00Z'); await f.put('target-three','2026-09-22T03:00:00Z');
 const service=createCleanupService(f.db,f.identity,{clock,journal:f.journal,batchSize:1});
 const preview=await service.preview(f.root.token,{user_id:f.owner,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});
 const job=await submitCleanupConfirmed(service,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());
 let steps=0; while((await service.status(f.root.token,job.job_id)).phase!=='events'){assert.ok(++steps<20);await service.runOne();}
 await service.runOne();
 const before=(await f.db.query('SELECT progress FROM jobs WHERE id=$1',[job.job_id])).rows[0]!.progress;
 assert.equal(before.deleted_events,1); assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]?.n,4);
 const start=()=>spawn(process.execPath,[fileURLToPath(new URL('../../../../apps/worker/dist/cleanup-main.js',import.meta.url))],{env:{NODE_ENV:'test',ADI_DATABASE_URL:connectionString,ADI_DATABASE_SCHEMA:f.db.schema,ADI_CLEANUP_JOURNAL_DIR:f.directory,ADI_EMAIL_DOMAINS:'example.invalid'},stdio:'ignore'});
 const children:ReturnType<typeof start>[]=[];
 t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}}});
 const until=async(predicate:()=>Promise<boolean>,budget=8000)=>{const end=Date.now()+budget;while(!await predicate()){if(Date.now()>end)assert.fail('cleanup process condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
 let release!:()=>void,acquired!:(pid:number)=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>(resolve=>{acquired=resolve;});
 const holder=f.db.transaction(async sql=>{await sql.query('LOCK TABLE hook_events IN SHARE MODE');acquired(Number((await sql.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));await gate;});
 let blockedPid=0;
 try{
  const blocker=await ready; const first=start();children.push(first);
  await until(async()=>{const row=(await f.db.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blocker])).rows[0];if(!row)return false;blockedPid=Number(row.pid);return true;});
  assert.equal((await f.db.query('SELECT status FROM jobs WHERE id=$1',[job.job_id])).rows[0]?.status,'running');
  const ended=once(first,'exit');first.kill('SIGKILL');await ended;
 }finally{release();await holder;}
 await until(async()=>(await f.db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[blockedPid])).rowCount===0);
 const crashed=(await f.db.query('SELECT status,progress,lease_token FROM jobs WHERE id=$1',[job.job_id])).rows[0]!;
 assert.equal(crashed.status,'running');assert.equal(crashed.progress.deleted_events,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]?.n,4,'the interrupted second batch must roll back');
 // Advance only the abandoned test lease instead of waiting 120 seconds. The
 // replacement process still uses the real expiration/claim path and budget.
 await f.db.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND lease_token=$2",[job.job_id,crashed.lease_token]);
 const second=start();children.push(second);
 await until(async()=>(await f.db.query('SELECT status FROM jobs WHERE id=$1',[job.job_id])).rows[0]?.status==='succeeded',12000);
 const complete=(await f.db.query('SELECT progress FROM jobs WHERE id=$1',[job.job_id])).rows[0]!.progress;
 assert.equal(complete.deleted_events,3);
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='cleanup'")).rows[0]?.n,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones WHERE user_id=$1',[f.owner])).rows[0]?.n,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]?.n,2);
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='cleanup_completed' AND metadata->>'job_id'=$1",[job.job_id])).rows[0]?.n,1);
 assert.equal((await f.put('must-not-revive','2026-09-22T01:00:00Z')).outcome,'rejected');
});

test('clearing a whole session removes token checks even without a projection and cancels its daily task',async t=>{
 const f=await fixture(t),sid=(await f.db.query('SELECT id FROM sessions WHERE user_id=$1',[f.owner])).rows[0]!.id,checks=createSessionTokenChecks(f.db,{clock});const daily=await checks.enqueue(sid);await checks.runOne();assert.equal((await checks.read(sid)).state,'current');
 const cleanup=createCleanupService(f.db,f.identity,{clock,journal:f.journal}),preview=await cleanup.preview(f.root.token,{user_id:f.owner,from:'2026-09-21T00:00:00Z',to:'2026-09-24T00:00:00Z'});await submitCleanupConfirmed(cleanup,f.root.token,{preview_id:preview.preview_id,user_id:f.owner,...preview.range,confirmation_email:preview.target.email},randomUUID());let n=0;while(await cleanup.runOne())assert.ok(++n<80);
 assert.equal((await checks.status(daily)).status,'cancelled');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_token_checks WHERE session_id=$1',[sid])).rows[0]!.n,0);await assert.rejects(checks.read(sid),{code:'not_found'});
});
