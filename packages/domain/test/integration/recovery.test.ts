import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {createIdentityService} from '../../src/identity.js';
import {createSessionDerivationService} from '../../src/session-derivation.js';
import {createRecoveryService} from '../../src/recovery.js';

const clock=()=>new Date('2026-09-24T12:00:00Z');
test('an isolated restored dataset replays a later cleanup without reopening old credentials or restoring deleted content',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const identity=createIdentityService(db,{clock,emailDomains:['example.invalid']});const root=await identity.bootstrap({email:'recovery-root@example.invalid',name:'恢复管理员'});const login=await identity.login('recovery-root@example.invalid',root.temporaryPassword);const actor=await identity.changePassword(login.token,root.temporaryPassword,'recovery-root-password');
 const installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'恢复前设备')",[installation,root.userId,'e'.repeat(64)]);
 const put=(id:string,at:string)=>db.ingest({schema_version:2,installation_id:installation,client_event_id:id,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:'restored-cross-day',payload:{prompt:id==='target'?'REMOVED_ORIGINAL':'KEEP_ORIGINAL'}},{admissionEpoch:1,receivedAt:clock()});
 await put('before','2026-09-21T01:00:00Z');const target=await put('target','2026-09-22T01:00:00Z');await put('after','2026-09-23T01:00:00Z');if(target.outcome!=='committed')throw new Error('fixture');
 const derive=createSessionDerivationService(db,{clock});while(await derive.runOne()){/* old backup has published copies */}
 const dataset=(await db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;
 const directory=await mkdtemp(join(tmpdir(),'adi-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory);const operation=randomUUID();
 await journal.publish({version:1,dataset_id:dataset,operation_id:operation,user_id:root.userId,target_email:'recovery-root@example.invalid',actor_id:randomUUID(),from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:'2026-09-24T10:00:00.000Z'},(async function*(){yield [target.sessionId];})());
 const checkpoint=await journal.createCheckpoint(dataset,'a'.repeat(64));const recovery=createRecoveryService(db,journal);const run=await recovery.quarantine(dataset);await assert.rejects(identity.requireUser(actor.token),{code:'recovery_quarantined'});await assert.rejects(identity.login('recovery-root@example.invalid','recovery-root-password'),{code:'recovery_quarantined'});assert.deepEqual(await put('late','2026-09-23T03:00:00Z'),{outcome:'rejected',reason:'recovery_quarantined'});
 assert.equal((await recovery.prepare(run.id,checkpoint)).operations,1);let count=0;while(await recovery.step(run.id))assert.ok(++count<100);assert.equal((await recovery.status(run.id)).state,'awaiting_identity_review');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,2);assert.equal((await db.query('SELECT count(*)::int AS n FROM session_fragments')).rows[0]!.n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM login_sessions')).rows[0]!.n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM installations WHERE enabled')).rows[0]!.n,0);
 await assert.rejects(identity.resolve(actor.token),{code:'recovery_quarantined'});assert.equal(await recovery.step(run.id),false);assert.equal((await recovery.quarantine(dataset)).id,run.id);
});

async function smallFixture(t:import('node:test').TestContext,receiptOnly=false){
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'restore-subject@example.invalid','恢复目标')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试设备')",[installation,user,'f'.repeat(64)]);
 const put=(name:string,at:string)=>db.ingest({schema_version:2,installation_id:installation,client_event_id:name,occurred_at:at,event_type:'UserPromptSubmit',source_session_id:'restore-session',payload:{prompt:name}},{admissionEpoch:1,receivedAt:clock()});const target=await put('target','2026-09-22T01:00:00Z');await put('keep','2026-09-23T01:00:00Z');if(target.outcome!=='committed')throw new Error('fixture');
 const dataset=(await db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;const directory=await mkdtemp(join(tmpdir(),'adi-replay-boundary-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory);const record={version:1 as const,dataset_id:dataset,operation_id:randomUUID(),user_id:user,target_email:'restore-subject@example.invalid',actor_id:randomUUID(),from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:'2026-09-24T10:00:00.000Z'};
 if(receiptOnly)await journal.accept(record);else await journal.publish(record,(async function*(){yield[target.sessionId];})());const checkpoint=await journal.createCheckpoint(dataset,'a'.repeat(64));return {db,user,dataset,directory,journal,record,session:target.sessionId,checkpoint};
}
test('corrupt later journal parts block the entire replay before deleting any restored facts',async t=>{
 const f=await smallFixture(t);const record={...f.record,operation_id:'ffffffff-ffff-4fff-bfff-ffffffffffff',cleanup_generation:2};await f.journal.publish(record,(async function*(){yield[f.session];})());
 f.checkpoint=await f.journal.createCheckpoint(f.dataset,'a'.repeat(64));const {writeFile}=await import('node:fs/promises');await writeFile(join(f.directory,f.dataset,record.operation_id,'part-000000.json'),'corrupted');const recovery=createRecoveryService(f.db,f.journal),run=await recovery.quarantine(f.dataset);await assert.rejects(recovery.prepare(run.id,f.checkpoint));await assert.rejects(recovery.step(run.id),{code:'recovery_not_prepared'});
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,2);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,0);assert.equal((await recovery.status(run.id)).state,'preparing');
});
test('replay resumes after a committed deletion batch and repeated preparation adds no duplicate barriers',async t=>{
 const f=await smallFixture(t),first=createRecoveryService(f.db,f.journal),run=await first.quarantine(f.dataset);await first.prepare(run.id,f.checkpoint);await first.step(run.id);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,1);
 const restarted=createRecoveryService(f.db,createCleanupJournal(f.directory));await restarted.prepare(run.id,f.checkpoint);let steps=0;while(await restarted.step(run.id))assert.ok(++steps<100);await restarted.prepare(run.id,f.checkpoint);assert.equal(await restarted.step(run.id),false);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);assert.equal((await restarted.status(run.id)).state,'awaiting_identity_review');
});
test('a backup after the original cleanup keeps later valid derived content at the recorded generation',async t=>{
 const f=await smallFixture(t);await f.db.query("DELETE FROM hook_events WHERE user_id=$1 AND occurred_at<'2026-09-23Z'",[f.user]);await f.db.query("DELETE FROM event_keys WHERE occurred_at<'2026-09-23Z'");await f.db.query('UPDATE users SET cleanup_generation=1 WHERE id=$1',[f.user]);await f.db.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.user,f.record.from,f.record.to]);const derive=createSessionDerivationService(f.db,{clock});while(await derive.runOne()){/* valid post-cleanup projection */}
 const before=(await f.db.query<{derived_run_id:string}>('SELECT derived_run_id FROM sessions WHERE id=$1',[f.session])).rows[0]!.derived_run_id;assert.ok(before);const recovery=createRecoveryService(f.db,f.journal),run=await recovery.quarantine(f.dataset);await recovery.prepare(run.id,f.checkpoint);let steps=0;while(await recovery.step(run.id))assert.ok(++steps<100);
 assert.equal((await f.db.query('SELECT derived_run_id FROM sessions WHERE id=$1',[f.session])).rows[0]!.derived_run_id,before);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_fragments WHERE run_id=$1',[before])).rows[0]!.n,1);
});
test('dataset mismatch and disappearing inventory never silently become a successful empty replay',async t=>{
 const f=await smallFixture(t),recovery=createRecoveryService(f.db,f.journal);await assert.rejects(recovery.quarantine(randomUUID()),{code:'dataset_identity_changed'});assert.equal((await f.db.query('SELECT recovery_id FROM data_identity')).rows[0]!.recovery_id,null);const run=await recovery.quarantine(f.dataset);await recovery.prepare(run.id,f.checkpoint);await rm(join(f.directory,f.dataset,f.record.operation_id),{recursive:true});await assert.rejects(recovery.prepare(run.id,f.checkpoint),{code:'recovery_checkpoint_mismatch'});assert.equal((await recovery.status(run.id)).state,'preparing');
});
test('records for a person absent from the old backup remain recorded without inventing an identity',async t=>{
 const f=await smallFixture(t),missing=randomUUID();
 for(const generation of [1,2])await f.journal.publish({...f.record,operation_id:randomUUID(),user_id:missing,target_email:'missing-restored-user@example.invalid',cleanup_generation:generation},(async function*(){/* no retained sessions */})());
 f.checkpoint=await f.journal.createCheckpoint(f.dataset,'a'.repeat(64)); const recovery=createRecoveryService(f.db,f.journal),run=await recovery.quarantine(f.dataset);await recovery.prepare(run.id,f.checkpoint);let steps=0;while(await recovery.step(run.id))assert.ok(++steps<100);const status=await recovery.status(run.id);assert.equal(status.operations,3);assert.equal(status.absent_users,1);assert.equal(status.serving,false);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM users')).rows[0]!.n,1);
});

test('an accepted but unsealed cleanup is replayed from its durable range after restoring an older backup',async t=>{
 const f=await smallFixture(t,true),recovery=createRecoveryService(f.db,f.journal),run=await recovery.quarantine(f.dataset);await recovery.prepare(run.id,f.checkpoint);let steps=0;while(await recovery.step(run.id))assert.ok(++steps<100);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM hook_events')).rows[0]!.n,1);assert.equal((await recovery.status(run.id)).state,'awaiting_identity_review');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);
});
