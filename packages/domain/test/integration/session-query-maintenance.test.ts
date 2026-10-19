import {submitCleanupConfirmed,confirmCleanupAcceptance} from '../helpers/cleanup-acceptance.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';
import {createCleanupService} from '../../src/cleanup.js';
import {createRetentionService} from '../../src/retention.js';
import {createRecoveryService} from '../../src/recovery.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';

test('confirmed cleanup erases temporary session quantities and fences a response already in flight',async t=>{
 const f=await stopUsageFixture(t),next=new Date(f.at.getTime()-5000);
 f.control.windows.set(Math.floor(next.getTime()/1000)-1,['next-bill']);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'maintenance-next-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:next.toISOString(),payload:{last_assistant_message:'合成续聊'}},{admissionEpoch:1,receivedAt:f.at});
 const id=await f.jobs.enqueue(f.session);
 for(let i=0;i<3;i++)assert.equal(await f.jobs.runOne(),true);
 // The public reader cannot expose unfinished quantities. Physical deletion also
 // must remove these private checkpoint copies, so inspect storage for that proof.
 const temporary=(await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress;
 assert.match(JSON.stringify(temporary),/176004/);
 assert.deepEqual((await f.read()).groups,[]);
 await f.jobs.runOne();
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 t.after(()=>release());f.control.onSession=async()=>{entered();await held;};
 const running=f.jobs.runOne();await started;
 const directory=await mkdtemp(join(tmpdir(),'adi-session-query-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const cleanup=createCleanupService(f.db,f.identity,{clock:()=>f.at,journal:createCleanupJournal(directory)});
 const preview=await cleanup.preview(f.login.token,{user_id:f.user,from:f.stop.toISOString(),to:new Date(f.stop.getTime()+1000).toISOString()});
 await submitCleanupConfirmed(cleanup,f.login.token,{preview_id:preview.preview_id,user_id:f.user,...preview.range,confirmation_email:preview.target.email},randomUUID());
 try{assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});}finally{release();await running;}
 assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{},'late source responses cannot recreate cleared checkpoint copies');
 assert.deepEqual((await f.read()).groups,[]);
});

test('recovery quarantine erases unfinished session quantities and rejects late source writes',async t=>{
 const f=await stopUsageFixture(t),next=new Date(f.at.getTime()-5000);
 f.control.windows.set(Math.floor(next.getTime()/1000)-1,['next-bill']);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'recovery-next-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:next.toISOString(),payload:{last_assistant_message:'合成续聊'}},{admissionEpoch:1,receivedAt:f.at});
 const id=await f.jobs.enqueue(f.session);for(let i=0;i<3;i++)await f.jobs.runOne();
 const temporary=(await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress;assert.match(JSON.stringify(temporary),/176004/);
 await f.jobs.runOne();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 t.after(()=>release());f.control.onSession=async()=>{entered();await held;};const running=f.jobs.runOne();await started;
 const directory=await mkdtemp(join(tmpdir(),'adi-session-query-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const recovery=createRecoveryService(f.db,createCleanupJournal(directory)),dataset=(await f.db.query('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;
 const run=await recovery.quarantine(dataset);
 try{assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});}finally{release();await running;}
 assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});
 assert.equal((await f.jobs.status(id)).status,'cancelled');
 await assert.rejects(f.read());
 // Reopening maintenance on a dataset quarantined by an older release must
 // erase its old checkpoint copies even though the quarantine is idempotent.
 await f.db.query('UPDATE jobs SET progress=$2 WHERE id=$1',[id,temporary]);
 assert.equal((await recovery.quarantine(dataset)).id,run.id);
 assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});
});

test('crossing the retention boundary erases temporary quantities before retained session queries resume',async t=>{
 const f=await stopUsageFixture(t),next=new Date(f.at.getTime()-5000);
 f.control.windows.set(Math.floor(next.getTime()/1000)-1,['next-bill']);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'retention-next-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:next.toISOString(),payload:{last_assistant_message:'合成续聊'}},{admissionEpoch:1,receivedAt:f.at});
 const id=await f.jobs.enqueue(f.session);for(let i=0;i<3;i++)await f.jobs.runOne();
 assert.match(JSON.stringify((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress),/176004/);
 await f.jobs.runOne();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 t.after(()=>release());f.control.onSession=async()=>{entered();await held;};const running=f.jobs.runOne();await started;
 const retention=createRetentionService(f.db,{clock:()=>new Date(f.start.getTime()+30000+365*86400000),batchSize:2});
 let count=0;while((await retention.status()).phase!=='references'){assert.ok(++count<40);await retention.runOne();}
 try{assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});}finally{release();await running;}
 assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});
 assert.equal((await f.reader.detail(f.login.token,f.session)).partial_history,true);
 assert.deepEqual((await f.read()).groups,[]);
});

test('a resumed cleanup removes temporary session quantities left by an older submission',async t=>{
 let durable:Promise<string>|undefined;t.after(async()=>{await durable?.catch(()=>undefined);});
 const f=await stopUsageFixture(t),next=new Date(f.at.getTime()-5000);
 f.control.windows.set(Math.floor(next.getTime()/1000)-1,['next-bill']);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'legacy-cleanup-next-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:next.toISOString(),payload:{last_assistant_message:'合成续聊'}},{admissionEpoch:1,receivedAt:f.at});
 const id=await f.jobs.enqueue(f.session);for(let i=0;i<3;i++)await f.jobs.runOne();
 const temporary=(await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress;
 const directory=await mkdtemp(join(tmpdir(),'adi-session-query-resumed-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const journal=createCleanupJournal(directory);let writes=0;
 const cleanup=createCleanupService(f.db,f.identity,{clock:()=>f.at,journal:{...journal,accept:record=>durable=(async()=>{if(++writes===1)await delay(2500);return journal.accept(record);})()},batchSize:2});
 const preview=await cleanup.preview(f.login.token,{user_id:f.user,from:f.stop.toISOString(),to:new Date(f.stop.getTime()+1000).toISOString()});
 const input={preview_id:preview.preview_id,user_id:f.user,...preview.range,confirmation_email:preview.target.email},key=randomUUID();let unconfirmed=0;
 const submitted=await confirmCleanupAcceptance(()=>cleanup.submit(f.login.token,input,key),()=>{unconfirmed++;});
 assert.ok(unconfirmed>=1,'the slow durable write must exercise an unconfirmed response');
 assert.equal(writes,1,'same-key retries share the in-flight durable write');
 assert.equal((await submitCleanupConfirmed(cleanup,f.login.token,input,key)).job_id,submitted.job_id);
 assert.equal((await cleanup.list(f.login.token,{user_id:f.user})).items.length,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cleanup_tombstones')).rows[0]!.n,1);
 // Model the persisted state of a cleanup submitted before checkpoint erasure
 // existed. The normal cleanup worker must handle this state during resumption.
 await f.db.query('UPDATE jobs SET progress=$2 WHERE id=$1',[id,temporary]);
 let count=0;while(await cleanup.runOne())assert.ok(++count<80);
 assert.equal((await cleanup.status(f.login.token,submitted.job_id)).status,'succeeded');
 assert.deepEqual((await f.db.query('SELECT progress FROM jobs WHERE id=$1',[id])).rows[0]!.progress,{});
 assert.deepEqual((await f.read()).groups,[]);
});
