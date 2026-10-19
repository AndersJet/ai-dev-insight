import {submitCleanupConfirmed} from '../helpers/cleanup-acceptance.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {createIdentityService} from '../../src/identity.js';
import {createCleanupCheckpoint,createRecoveryService} from '../../src/recovery.js';
import {createCleanupService} from '../../src/cleanup.js';
import {createSessionDerivationService} from '../../src/session-derivation.js';
import {createProjectInventoryService} from '../../src/project-inventory.js';
import {createRecoveryAccessService} from '../../src/recovery-access.js';
const clock=()=>new Date('2026-09-24T12:00:00Z');

async function fixture(t:TestContext,cleanupForFresh=false,withBackground=false){
 const db=await testDatabase(t);await db.migrate();if(withBackground||cleanupForFresh)await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));let at=clock();const currentTime=()=>at;const identity=createIdentityService(db,{clock:currentTime,emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'old-admin@example.invalid',name:'旧管理员'});const initial=await identity.login('old-admin@example.invalid',seed.temporaryPassword);const old=await identity.changePassword(initial.token,seed.temporaryPassword,'old-admin-password');
 const fresh=randomUUID(),department=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'fresh-admin@example.invalid','当前管理员')",[fresh]);await db.query("INSERT INTO departments(id,name) VALUES($1,'当前部门')",[department]);await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super','2026-09-01Z')",[fresh]);await db.query('DELETE FROM role_grants WHERE user_id=$1',[seed.userId]);await db.query("UPDATE users SET status='suspended' WHERE id=$1",[seed.userId]);
 const directory=await mkdtemp(join(tmpdir(),'adi-recovery-access-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory),dataset=(await db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;let pendingJob:string|undefined;
 if(cleanupForFresh){
  await db.query("UPDATE users SET status='active' WHERE id=$1",[seed.userId]);await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super','2026-09-01Z')",[seed.userId]);
  const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'恢复前真实清理事实')",[installation,fresh,'8'.repeat(64)]);
  assert.equal((await db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),occurred_at:'2026-09-22T10:00:00Z',event_type:'UserPromptSubmit',source_session_id:'pre-backup-missing-person',payload:{prompt:'SYNTHETIC_REMOVED_BEFORE_BACKUP'}},{admissionEpoch:1,receivedAt:currentTime()})).outcome,'committed');
  const cleanup=createCleanupService(db,identity,{clock:currentTime,journal}),preview=await cleanup.preview(old.token,{user_id:fresh,from:'2026-09-22T00:00:00Z',to:'2026-09-23T00:00:00Z'});assert.equal(preview.counts.hook_events,1);
  pendingJob=(await submitCleanupConfirmed(cleanup,old.token,{preview_id:preview.preview_id,user_id:fresh,...preview.range,confirmation_email:preview.target.email},randomUUID())).job_id;
  let steps=0;while(await cleanup.runOne())assert.ok(++steps<100);assert.equal((await cleanup.status(old.token,pendingJob)).status,'succeeded');
  await db.query('DELETE FROM installations WHERE id=$1',[installation]);
  await db.query('DELETE FROM role_grants WHERE user_id=$1',[seed.userId]);await db.query("UPDATE users SET status='suspended' WHERE id=$1",[seed.userId]);
 }
 const checkpoint=await createCleanupCheckpoint(db,journal,dataset);const access=createRecoveryAccessService(db,journal,{clock:currentTime,emailDomains:['example.invalid']});const snapshot=await access.exportSnapshot(checkpoint);
 assert.doesNotMatch(JSON.stringify(snapshot),/password_hash|token_hash|temporaryPassword|csrf_hash/);
 // Recreate the older backup's authorization state; cleanup replay remains independent.
 if(pendingJob){await db.query('DELETE FROM cleanup_journal_parts WHERE job_id=$1',[pendingJob]);await db.query('DELETE FROM cleanup_sessions WHERE job_id=$1',[pendingJob]);await db.query('DELETE FROM cleanup_requests WHERE job_id=$1',[pendingJob]);await db.query('DELETE FROM cleanup_previews WHERE user_id=$1',[fresh]);await db.query('DELETE FROM cleanup_tombstones WHERE user_id=$1',[fresh]);await db.query('DELETE FROM personal_model_revisions WHERE user_id=$1',[fresh]);await db.query('DELETE FROM jobs WHERE id=$1',[pendingJob]);}
 await db.query('DELETE FROM role_grants WHERE user_id=$1',[fresh]);await db.query('DELETE FROM users WHERE id=$1',[fresh]);await db.query("UPDATE users SET status='active' WHERE id=$1",[seed.userId]);await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super','2026-09-01Z')",[seed.userId]);await db.query('DELETE FROM departments WHERE id=$1',[department]);
 let backgroundSession:string|undefined;if(withBackground){const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'background fixture')",[installation,seed.userId,'9'.repeat(64)]);const accepted=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'restore-background',occurred_at:'2026-09-23T10:00:00Z',event_type:'UserPromptSubmit',source_session_id:'restore-background',payload:{prompt:'SYNTHETIC_BACKGROUND'}},{admissionEpoch:1,receivedAt:currentTime()});if(accepted.outcome!=='committed')throw new Error('fixture');backgroundSession=accepted.sessionId;await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'member_import','restore-user-import','{}')",[randomUUID()]);}
 const recovery=createRecoveryService(db,journal),run=await recovery.quarantine(dataset);await recovery.prepare(run.id,checkpoint);assert.equal(await recovery.step(run.id),false);
 return {db,identity,seed,old,fresh,department,journal,dataset,checkpoint,snapshot,access,recovery,run,backgroundSession,advance:(ms:number)=>{at=new Date(at.getTime()+ms);}};
}

test('reviewed current access replaces stale restored grants before a fresh bootstrap credential opens the dataset',async t=>{
 const {identity,old,seed,access,recovery,run,snapshot}=await fixture(t);
 const review=await access.review(run.id,snapshot,'fresh-admin@example.invalid');assert.equal(review.counts.new_users,1);assert.ok(review.changes.some(change=>change.user_id===seed.userId&&change.after_status==='suspended'));await access.apply(run.id,review.review_id,snapshot);await assert.rejects(identity.resolve(old.token),{code:'recovery_quarantined'});
 const credential=await access.issueCredential(run.id,review.review_id);assert.equal(credential.email,'fresh-admin@example.invalid');assert.notEqual(credential.temporary_password,'old-admin-password');await assert.rejects(access.release(run.id,credential,'old-admin@example.invalid'),{code:'recovery_confirmation_mismatch'});
 const released=await access.release(run.id,credential,'fresh-admin@example.invalid');assert.equal(released.state,'released');await assert.rejects(identity.login('old-admin@example.invalid','old-admin-password'),{code:'invalid_credentials'});const login=await identity.login(credential.email,credential.temporary_password);assert.equal(login.user.must_change_password,true);assert.deepEqual(login.user.roles,['employee','super']);await assert.rejects(identity.requireUser(login.token),{code:'password_change_required'});const changed=await identity.changePassword(login.token,credential.temporary_password,'new-recovery-password');assert.ok((await identity.requireUser(changed.token)).roles.includes('super'));assert.equal((await recovery.status(run.id)).serving,true);
});

test('identity review rejects missing subjects, credential injection, changed snapshots and target drift atomically',async t=>{
 const f=await fixture(t);const missing=structuredClone(f.snapshot);missing.users=missing.users.filter(user=>user.id!==f.seed.userId);await assert.rejects(f.access.review(f.run.id,missing,'fresh-admin@example.invalid'),{code:'recovery_access_incomplete'});
 await assert.rejects(f.access.review(f.run.id,{...f.snapshot,credentials:[]},'fresh-admin@example.invalid'),{code:'invalid_recovery_access_snapshot'});
 const duplicate=structuredClone(f.snapshot);duplicate.users[1]!.email_key=duplicate.users[0]!.email_key;await assert.rejects(f.access.review(f.run.id,duplicate,'fresh-admin@example.invalid'),{code:'invalid_recovery_access_snapshot'});
 const review=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid'),changed=structuredClone(f.snapshot);changed.users.find(user=>user.id===f.seed.userId)!.status='deleted';await assert.rejects(f.access.apply(f.run.id,review.review_id,changed),{code:'recovery_access_review_stale'});
 await f.db.query('UPDATE users SET version=version+1 WHERE id=$1',[f.seed.userId]);await assert.rejects(f.access.apply(f.run.id,review.review_id,f.snapshot),{code:'recovery_access_review_stale'});assert.equal((await f.db.query('SELECT status FROM users WHERE id=$1',[f.seed.userId])).rows[0]!.status,'active');assert.equal((await f.recovery.status(f.run.id)).serving,false);
});
test('microsecond membership boundaries survive identity restore and old official department links are removed',async t=>{
 const f=await fixture(t);await f.db.query("INSERT INTO departments(id,name) VALUES($1,'旧部门名称')",[f.department]);await f.db.query("INSERT INTO usage_department_mappings(provider_account,external_department_id,department_id,valid_from,created_by) VALUES('old-source','old-external',$1,'2026-09-01Z',$2)",[f.department,f.seed.userId]);
 const snapshot=structuredClone(f.snapshot);snapshot.memberships=[{id:randomUUID(),user_id:f.seed.userId,department_id:f.department,valid_from:'2026-09-22T00:00:00.000001Z',valid_to:'2026-09-22T00:00:00.000002Z'},{id:randomUUID(),user_id:f.seed.userId,department_id:f.department,valid_from:'2026-09-22T00:00:00.000002Z',valid_to:null}];
 const review=await f.access.review(f.run.id,snapshot,'fresh-admin@example.invalid');assert.equal(review.official_mappings.before.length,1);assert.equal(review.official_mappings.after.length,0);await f.access.apply(f.run.id,review.review_id,snapshot);
 const bounds=(await f.db.query<{valid_from:string;valid_to:string|null}>('SELECT valid_from::text,valid_to::text FROM membership_periods WHERE user_id=$1 ORDER BY valid_from',[f.seed.userId])).rows;assert.match(bounds[0]!.valid_from,/000001/);assert.match(bounds[0]!.valid_to!,/000002/);assert.equal(bounds[1]!.valid_from,bounds[0]!.valid_to);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM usage_department_mappings')).rows[0]!.n,0);
});
test('rotating a staged bootstrap credential invalidates the earlier release token and release acknowledgement is idempotent',async t=>{
 const f=await fixture(t),review=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,f.snapshot);const first=await f.access.issueCredential(f.run.id,review.review_id),second=await f.access.issueCredential(f.run.id,review.review_id);
 await assert.rejects(f.access.release(f.run.id,first,first.email),{code:'recovery_access_review_stale'});await assert.rejects(f.access.release(f.run.id,{...second,temporary_password:'not-the-staged-password'},second.email),{code:'recovery_bootstrap_not_authorized'});await f.access.release(f.run.id,second,second.email);assert.equal((await f.access.release(f.run.id,second,second.email)).serving,true);assert.equal((await f.db.query("SELECT count(*)::int AS n FROM recovery_events WHERE run_id=$1 AND action='recovery_released'",[f.run.id])).rows[0]!.n,1);
});
test('expired reviews and credentials cannot reopen a quarantined dataset',async t=>{
 const f=await fixture(t),old=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid');f.advance(601000);await assert.rejects(f.access.apply(f.run.id,old.review_id,f.snapshot),{code:'recovery_access_review_stale'});const review=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,f.snapshot);const credential=await f.access.issueCredential(f.run.id,review.review_id);f.advance(86400001);await assert.rejects(f.access.release(f.run.id,credential,credential.email),{code:'recovery_access_review_stale'});assert.equal((await f.recovery.status(f.run.id)).serving,false);
});
test('a restored missing identity retains its cleanup barrier, and later restores keep earlier replay evidence',async t=>{
 const f=await fixture(t,true);assert.equal((await f.recovery.status(f.run.id)).absent_users,1);const review=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,f.snapshot);assert.equal((await f.recovery.status(f.run.id)).absent_users,0);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones WHERE user_id=$1',[f.fresh])).rows[0]!.n,1);const credential=await f.access.issueCredential(f.run.id,review.review_id);await f.access.release(f.run.id,credential,credential.email);
 const checkpoint=await createCleanupCheckpoint(f.db,f.journal,f.dataset);assert.equal(checkpoint.operations,1);const previous=(await f.db.query('SELECT job_id FROM recovery_cleanup_operations WHERE run_id=$1',[f.run.id])).rows[0]!.job_id;const next=await f.recovery.quarantine(f.dataset);assert.notEqual(next.id,f.run.id);await f.recovery.prepare(next.id,checkpoint);while(await f.recovery.step(next.id)){/* same range, new replay context */}
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM recovery_cleanup_operations')).rows[0]!.n,2);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM recovery_cleanup_operations WHERE job_id=$1',[previous])).rows[0]!.n,1);assert.equal((await f.db.query("SELECT count(*)::int AS n FROM recovery_events WHERE run_id=$1 AND action='recovery_released'",[f.run.id])).rows[0]!.n,1);
});

test('recreating a person absent from the backup also restores project ordering before collection can resume',async t=>{
 const f=await fixture(t),collector=randomUUID(),workspace='/synthetic/recreated';
 const barrier={collector_id:collector,workspace_key:createHash('sha256').update(JSON.stringify(['macos',workspace])).digest('hex'),latest_sequence:'7',confirmed_sequence:'6'};
 const base={version:1 as const,dataset_id:f.dataset,operation_id:randomUUID(),user_id:f.fresh,target_email:'fresh-admin@example.invalid',actor_id:f.seed.userId,from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:clock().toISOString()};
 const project_barriers=await f.journal.writeProjects(base,(async function*(){yield [barrier];})());await f.journal.accept({...base,project_barriers});
 const checkpoint=await f.journal.createCheckpoint(f.dataset,'b'.repeat(64)),snapshot=structuredClone(f.snapshot);snapshot.checkpoint={checkpoint_id:checkpoint.checkpoint_id,digest:checkpoint.digest};snapshot.users.find(user=>user.id===f.fresh)!.cleanup_generation=1;
 await f.recovery.prepare(f.run.id,checkpoint);while(await f.recovery.step(f.run.id)){/* missing user is still fenced */}
 const review=await f.access.review(f.run.id,snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,snapshot);
 const credential=await f.access.issueCredential(f.run.id,review.review_id);await f.access.release(f.run.id,credential,credential.email);
 const temporary=await f.identity.login(credential.email,credential.temporary_password),active=await f.identity.changePassword(temporary.token,credential.temporary_password,'fresh-project-recovery-password');
 await f.db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));const installation=randomUUID();await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成恢复凭据')",[installation,f.fresh,'a'.repeat(64)]);
 const result=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),occurred_at:clock().toISOString(),event_type:'Stop',source_session_id:'after-restore',payload:{},project:{collector_id:collector,platform:'macos',workspace,unresolved_reason:null,observation:{id:randomUUID(),sequence:'1',observed_at:'2026-09-21T12:00:00.000Z',state:'repository',reason:null,git_root:workspace,remotes:[{name:'origin',direction:'fetch',address:'https://old.example.invalid/repo.git'}]}}},{admissionEpoch:1,receivedAt:clock()});
 assert.equal(result.outcome,'committed');assert.equal(result.outcome==='committed'?result.project_outcome:null,'superseded');
 const item=(await createProjectInventoryService(f.db,f.identity,{clock}).list(active.token)).items[0]!;
 assert.equal(item.current_available,false);assert.equal(item.confirmed_at,null);assert.deepEqual(item.remotes,[]);
 assert.equal((await f.db.query('SELECT 1 FROM project_observations WHERE collector_id=$1',[collector])).rowCount,0,'the restored ordering barrier must reject the old cache as a fact');
});
test('even a still-active employee cannot reuse a restored password, and a future super grant cannot bootstrap early',async t=>{
 const f=await fixture(t),snapshot=structuredClone(f.snapshot);snapshot.users.find(user=>user.id===f.seed.userId)!.status='active';await assert.rejects(f.access.review(f.run.id,snapshot,'old-admin@example.invalid'),{code:'recovery_bootstrap_not_authorized'});
 const future=structuredClone(snapshot);future.grants.find(grant=>grant.user_id===f.fresh)!.valid_from='2026-09-25T12:00:00Z';await assert.rejects(f.access.review(f.run.id,future,'fresh-admin@example.invalid'),{code:'recovery_bootstrap_not_authorized'});
 const review=await f.access.review(f.run.id,snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,snapshot);const credential=await f.access.issueCredential(f.run.id,review.review_id);await f.access.release(f.run.id,credential,credential.email);assert.equal((await f.db.query('SELECT status FROM users WHERE id=$1',[f.seed.userId])).rows[0]!.status,'active');await assert.rejects(f.identity.login('old-admin@example.invalid','old-admin-password'),{code:'invalid_credentials'});
});

test('release waits for system job requeue while stale user-authorized imports remain cancelled',async t=>{
 const f=await fixture(t,false,true),review=await f.access.review(f.run.id,f.snapshot,'fresh-admin@example.invalid');await f.access.apply(f.run.id,review.review_id,f.snapshot);const credential=await f.access.issueCredential(f.run.id,review.review_id);await assert.rejects(f.access.release(f.run.id,credential,credential.email),{code:'recovery_background_pending'});assert.equal(await f.access.resumeBackground(f.run.id),true);assert.equal(await f.access.resumeBackground(f.run.id),false);assert.equal((await f.db.query("SELECT status FROM jobs WHERE dedupe_key='restore-user-import'")).rows[0]!.status,'cancelled');await f.access.release(f.run.id,credential,credential.email);
 const derive=createSessionDerivationService(f.db,{clock});let steps=0;while(await derive.runOne())assert.ok(++steps<50);assert.ok((await f.db.query('SELECT derived_run_id FROM sessions WHERE id=$1',[f.backgroundSession])).rows[0]!.derived_run_id);
});

test('configuration administrator source survives recovery; offline release proof never becomes its login password', async t => {
 const f=await fixture(t),snapshot=structuredClone(f.snapshot);
 snapshot.users.find(user=>user.id===f.fresh)!.management_source='environment';
 const review=await f.access.review(f.run.id,snapshot,'fresh-admin@example.invalid');
 await f.access.apply(f.run.id,review.review_id,snapshot);
 const credential=await f.access.issueCredential(f.run.id,review.review_id);
 await assert.rejects(f.identity.syncConfigurationAdministrator({email:credential.email,name:'配置管理员',password:'recovery-configured-password'}),{code:'recovery_quarantined'});
 await f.access.release(f.run.id,credential,credential.email);
 await assert.rejects(f.identity.login(credential.email,credential.temporary_password),{code:'invalid_credentials'});
 await f.identity.syncConfigurationAdministrator({email:credential.email,name:'配置管理员',password:'recovery-configured-password'});
 const login=await f.identity.login(credential.email,'recovery-configured-password');
 assert.equal(login.user.management_source,'environment');assert.equal(login.user.must_change_password,false);
 await assert.rejects(f.identity.changePassword(login.token,'recovery-configured-password','forbidden-new-password'),{code:'configuration_managed_account'});
});
