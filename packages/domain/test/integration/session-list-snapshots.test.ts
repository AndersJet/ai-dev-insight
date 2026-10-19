import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {loadSessionListSnapshotOwner} from '../../src/session-list-snapshot-loader.js';
import {createSessionListSnapshotPublisher,readSessionListSafetyFence,sessionListSafetyFenceMatches,type SessionListSnapshotLoader} from '../../src/session-list-snapshot-publisher.js';
import {runCleanupBatch,type CleanupBatchRequest} from '../../src/cleanup-worker.js';
import type {Database,Transaction} from '../../../storage/src/index.js';

test('complete snapshots reuse unchanged owner entries and detect equal-time Hook additions from metadata generations',async t=>{
 const f=await stopUsageFixture(t);await f.run();
 const other=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'snapshot-other@example.invalid','Other owner')",[other]);
 const loaded:string[]=[],loader:SessionListSnapshotLoader=async(client,...args)=>{
  const state=(await client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0]!;
  assert.equal(state.readonly,'on');assert.equal(state.isolation,'repeatable read');loaded.push(args[1]);return loadSessionListSnapshotOwner(client,...args);
 };
 const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true,loadOwner:loader});
 assert.equal(await publisher.runOne(true),true);const first=(await publisher.latest())!;
 assert.equal(Object.keys(first.owner_entries).length,2);assert.equal(loaded.length,2);
 loaded.length=0;assert.equal(await publisher.runOne(true),true);const second=(await publisher.latest())!;
 assert.deepEqual(second.owner_entries,first.owner_entries);assert.equal(loaded.length,0);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:'synthetic-hook',event_type:'Notification',occurred_at:f.start.toISOString(),payload:{message:'equal-time addition'}},{admissionEpoch:1,receivedAt:f.at});
 assert.equal(await publisher.runOne(true),true);const third=(await publisher.latest())!;
 assert.deepEqual(loaded,[f.user]);assert.equal(third.owner_entries[other],first.owner_entries[other]);assert.notEqual(third.owner_entries[f.user],first.owner_entries[f.user]);
 const payload=(await f.db.query<{payload:Awaited<ReturnType<typeof loadSessionListSnapshotOwner>>}>('SELECT payload FROM session_list_snapshot_entries WHERE id=$1',[third.owner_entries[f.user]])).rows[0]!.payload;
 assert.equal(payload.sessions[0]?.events.length,3);assert.equal(payload.sessions[0]?.query_records.length,0,'new Hook invalidates the old official signature');
});

test('reader safety fences can restrict cleanup to protected owners while preserving full-precision dataset authority',async t=>{
 const f=await stopUsageFixture(t),other=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'scoped-fence@example.invalid','Unrelated owner')",[other]);
 await f.db.query("UPDATE data_identity SET retention_cutoff=$1::timestamptz+interval '1 microsecond'",[f.start]);
 const broad=await readSessionListSafetyFence(f.db),scoped=await readSessionListSafetyFence(f.db,false,[f.user]);
 assert.equal(Object.keys(broad.cleanup).length,2);assert.deepEqual(Object.keys(scoped.cleanup),[f.user]);
 assert.equal(scoped.dataset_id,broad.dataset_id);assert.equal(scoped.retention_cutoff,broad.retention_cutoff);
 assert.match(scoped.retention_cutoff??'',/\d{6}\+00$/);assert.equal(sessionListSafetyFenceMatches(broad,scoped,[f.user]),true);
 await f.db.query('UPDATE users SET cleanup_generation=1 WHERE id=$1',[other]);
 assert.equal(sessionListSafetyFenceMatches(broad,await readSessionListSafetyFence(f.db,false,[f.user]),[f.user]),true);
 assert.equal(sessionListSafetyFenceMatches(broad,await readSessionListSafetyFence(f.db)),false);
 assert.deepEqual((await readSessionListSafetyFence(f.db,false,[])).cleanup,{});
 assert.deepEqual((await readSessionListSafetyFence(f.db,false,[randomUUID()])).cleanup,{});
});

test('ordinary ingestion after the MVCC read belongs to the next complete snapshot and does not cancel publication',async t=>{
 const f=await stopUsageFixture(t);let changed=false;
 const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true,loadOwner:async(client,...args)=>{
  const result=await loadSessionListSnapshotOwner(client,...args);
  if(!changed){changed=true;await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:'synthetic-hook',event_type:'Notification',occurred_at:f.start.toISOString(),payload:{message:'after snapshot read'}},{admissionEpoch:1,receivedAt:f.at});}
  return result;
 }});
 assert.equal(await publisher.runOne(true),true);const first=(await publisher.latest())!;
 const read=async(id:string)=>(await f.db.query<{payload:Awaited<ReturnType<typeof loadSessionListSnapshotOwner>>}>('SELECT payload FROM session_list_snapshot_entries WHERE id=$1',[id])).rows[0]!.payload;
 assert.equal((await read(first.owner_entries[f.user]!)).sessions[0]?.events.length,2);
 assert.equal(await publisher.runOne(true),true);const next=(await publisher.latest())!;
 assert.equal((await read(next.owner_entries[f.user]!)).sessions[0]?.events.length,3);
 assert.equal((await read(first.owner_entries[f.user]!)).sessions[0]?.events.length,2,'fixed snapshots keep immutable old owner payloads');
});

test('cleanup committed between read and publication rejects the whole candidate without storing private entries',async t=>{
 const f=await stopUsageFixture(t);
 const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true,loadOwner:async(client,...args)=>{
  const result=await loadSessionListSnapshotOwner(client,...args);await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);return result;
 }});
 await assert.rejects(publisher.runOne(true),{code:'stale_session_list_snapshot'});
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,0);
});

test('a one-microsecond cutoff change during a first publication rejects the candidate without relying on old entry deletion',async t=>{
 const f=await stopUsageFixture(t);
 await f.db.query('UPDATE data_identity SET retention_cutoff=$1',[f.start]);
 const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true,loadOwner:async(client,...args)=>{
  const result=await loadSessionListSnapshotOwner(client,...args);
  await f.db.query("UPDATE data_identity SET retention_cutoff=retention_cutoff+interval '1 microsecond'");
  return result;
 }});
 await assert.rejects(publisher.runOne(true),{code:'stale_session_list_snapshot'});
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,0);
});

test('dataset safety changes physically clear all cached private entries and trigram search is an actual partial GIN index',async t=>{
 const f=await stopUsageFixture(t),publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true});
 await publisher.runOne(true);assert.ok(await publisher.latest());
 await f.db.query('UPDATE data_identity SET retention_cutoff=$1',[new Date(f.start.getTime()-1000)]);
 assert.equal(await publisher.latest(),null);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,0);
 const index=(await f.db.query("SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid='hook_prompt_trgm'::regclass")).rows[0]!.definition;
 assert.match(index,/USING gin/);assert.match(index,/gin_trgm_ops/);assert.match(index,/UserPromptSubmit/);
 await publisher.runOne(true);assert.ok(await publisher.latest());
 await f.db.query("WITH r AS(INSERT INTO recovery_runs(id,dataset_id,state) SELECT gen_random_uuid(),dataset_id,'quarantined' FROM data_identity RETURNING id) UPDATE data_identity SET recovery_id=(SELECT id FROM r)");
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
 await assert.rejects(publisher.runOne(true),{code:'recovery_quarantined'});
});

test('cleanup removes old owner snapshot copies in batches while preserving a new cleanup generation',async t=>{
 const f=await stopUsageFixture(t),publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true});
 await publisher.runOne(true);const before=(await publisher.latest())!;
 await f.db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=1 WHERE id=$1',[f.user]);await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.user,f.start,new Date(f.at.getTime()+1000)]);});
 await publisher.runOne(true);const current=(await publisher.latest())!;
 const request:CleanupBatchRequest={user_id:f.user,from_at:f.start,to_at:f.at,cleanup_generation:1,executor_id:f.user,journal_digest:'synthetic',phase:'derived',progress:{}};
 for(let n=0;request.phase==='derived'&&n<15;n++)await f.db.transaction(client=>runCleanupBatch(client,request,randomUUID(),1,'cleanup_sessions',async(phase,progress)=>{request.phase=phase;request.progress=progress;}));
 assert.equal(request.phase,'models');
 assert.equal((await f.db.query('SELECT 1 FROM session_list_snapshot_entries WHERE id=$1',[before.owner_entries[f.user]])).rowCount,0);
 assert.equal((await f.db.query('SELECT 1 FROM session_list_snapshot_entries WHERE id=$1',[current.owner_entries[f.user]])).rowCount,1);
 assert.equal((await f.db.query('SELECT 1 FROM session_list_snapshots WHERE id=$1',[before.id])).rowCount,0);
});

test('unchanged owners are republished before expiration and a new Beijing day rebuilds the complete owner view',async t=>{
 const f=await stopUsageFixture(t);let time=f.at.getTime(),loads=0;
 const publisher=createSessionListSnapshotPublisher(f.db,{clock:()=>new Date(time),providerAccount:'stop-test',stopWindowEnabled:true,loadOwner:async(client,...args)=>{loads++;return loadSessionListSnapshotOwner(client,...args);}});
 await publisher.runOne();const initial=(await publisher.latest())!;
 assert.equal(initial.expires_at.getTime()-initial.as_of.getTime(),60000);
 assert.equal(await publisher.runOne(),false);
 time+=55000;await publisher.runOne();const refreshed=(await publisher.latest())!;
 assert.equal(loads,1);assert.deepEqual(refreshed.owner_entries,initial.owner_entries);
 time+=10000;assert.ok(await publisher.latest(),'unchanged content remains available after the original snapshot expired');
 time+=86400000;await publisher.runOne();const nextDay=(await publisher.latest())!;
 assert.equal(loads,2);assert.notEqual(nextDay.owner_entries[f.user],initial.owner_entries[f.user]);
});

test('two forced publications with the same millisecond as_of select the later complete publication',async t=>{
 const f=await stopUsageFixture(t),publisher=createSessionListSnapshotPublisher(f.db,{clock:()=>f.at,providerAccount:'stop-test',stopWindowEnabled:true});
 await publisher.runOne(true);const first=(await publisher.latest())!;
 await f.db.query('UPDATE users SET display_name=$2 WHERE id=$1',[f.user,'Later forced publication']);
 await publisher.runOne(true);const latest=(await publisher.latest())!;
 const expected=(await f.db.query<{id:string}>('SELECT id FROM session_list_snapshots ORDER BY as_of DESC,created_at DESC,id DESC LIMIT 1')).rows[0]!.id;
 assert.equal(latest.as_of.getTime(),first.as_of.getTime());assert.notEqual(latest.id,first.id);assert.equal(latest.id,expected);
 const owner=(await f.db.query<{name:string}>("SELECT payload->>'name' AS name FROM session_list_snapshot_entries WHERE id=$1",[latest.owner_entries[f.user]])).rows[0]!;
 assert.equal(owner.name,'Later forced publication');
});

test('a loader failure cannot publish partial owner mappings or private staged entries',async t=>{
 const f=await stopUsageFixture(t);const other=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'snapshot-failing@example.invalid','Failing owner')",[other]);let loaded=0;
 const publisher=createSessionListSnapshotPublisher(f.db,{loadOwner:async(client,...args)=>{const payload=await loadSessionListSnapshotOwner(client,...args);if(++loaded===2)throw new Error('synthetic owner load failed');return payload;}});
 await assert.rejects(publisher.runOne(),/synthetic owner load failed/);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,0);
});

function observeEntryWrites(db:Database,onWrite:(client:Transaction,text:string,values:unknown[]|undefined)=>Promise<void>){
 return new Proxy(db,{get(target,key,receiver){
  if(key==='transaction')return <T>(action:(client:Transaction)=>Promise<T>)=>target.transaction(client=>action(new Proxy(client,{get(sql,property,queryReceiver){
   if(property==='query')return async(text:string,values?:unknown[])=>{if(/^\s*INSERT INTO session_list_snapshot_entries/.test(text))await onWrite(sql,text,values);return sql.query(text,values);};
   return Reflect.get(sql,property,queryReceiver);
  }})));
  return Reflect.get(target,key,receiver);
 }});
}

test('owner writes have bounded batches and an actual large owner is stored alone without truncating its metadata',async t=>{
 const f=await stopUsageFixture(t);
 await f.db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'batch-'||n||'@example.invalid','Batch owner '||n FROM generate_series(1,8) n");
 // Persist real synthetic facts, so the loader produces a genuinely large
 // metadata value. Repeated IDs or fake projected objects are not used.
 await f.db.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,installation_id,session_id,event_type,payload,capture_generation)
  SELECT gen_random_uuid(),$1::timestamptz+n*interval '1 millisecond',$1,$2,$3,$4,'UserPromptSubmit',jsonb_build_object('prompt',repeat('Synthetic prompt metadata ',6)||n),0
  FROM generate_series(1,20000) n`,[f.start,f.user,f.installation,f.session]);
 const writes:Array<{bytes:number;rows:number;owner:string}> = [];
 const observed=observeEntryWrites(f.db,async(_client,_text,values)=>{
  assert.equal(typeof values?.[0],'string');const encoded=String(values![0]);
  const rows: Array<{user_id:string}> = JSON.parse(encoded);writes.push({bytes:Buffer.byteLength(encoded),rows:rows.length,owner:rows[0]!.user_id});
 });
 const publisher=createSessionListSnapshotPublisher(observed,{providerAccount:'stop-test',stopWindowEnabled:true});
 assert.equal(await publisher.runOne(true),true);
 assert.ok(writes.length>=2);assert.equal(writes.reduce((n,b)=>n+b.rows,0),9);
 assert.ok(writes.every(b=>b.rows<=8&& (b.bytes<=1024*1024||b.rows===1)));
 assert.ok(writes.some(b=>b.bytes>1024*1024&&b.rows===1&&b.owner===f.user));
 const snapshot=(await publisher.latest())!;
 const count=(await f.db.query<{events:number}>("SELECT jsonb_array_length(payload->'sessions'->0->'events')::int AS events FROM session_list_snapshot_entries WHERE id=$1",[snapshot.owner_entries[f.user]])).rows[0]!.events;
 assert.equal(count,20002);assert.equal(Object.keys(snapshot.owner_entries).length,9);
});

test('a real PostgreSQL failure in the second owner write batch rolls back the first batch and the complete publication',async t=>{
 const f=await stopUsageFixture(t);
 await f.db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'rollback-'||n||'@example.invalid','Rollback owner '||n FROM generate_series(1,8) n");
 let writes=0;
 const observed=observeEntryWrites(f.db,async client=>{
  if(++writes===2){
   assert.equal((await client.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,8,'the first batch must really have executed');
   await client.query('SELECT * FROM synthetic_missing_snapshot_batch_relation');
  }
 });
 const publisher=createSessionListSnapshotPublisher(observed,{providerAccount:'stop-test',stopWindowEnabled:true});
 await assert.rejects(publisher.runOne(true),{code:'42P01'});assert.equal(writes,2);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
});
