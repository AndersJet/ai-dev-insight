import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createSessionDerivationService } from '../../src/session-derivation.js';
import { createSessionReadService } from '../../src/session-reading.js';
const clock = () => new Date('2026-09-24T12:00:00Z');

test('body references preserve microseconds and disambiguate an event UUID reused at another occurrence',async t=>{
 const {db,reader,own,owner,installation,sid,recentId}=await fixture(t);
 await db.query("INSERT INTO hook_events(id,occurred_at,user_id,installation_id,session_id,event_type,payload) VALUES($1,'2026-09-22T00:00:00.123457Z',$2,$3,$4,'UserPromptSubmit','{\"prompt\":\"SECOND_OCCURRENCE\"}')",[recentId,owner,installation,sid]);
 const raw=await reader.fragments(own.token,sid,{mode:'raw'});assert.deepEqual(raw.items.map(row=>row.occurred_at),['2026-09-22T00:00:00.123456Z','2026-09-22T00:00:00.123457Z']);
 await assert.rejects(reader.content(own.token,sid,recentId,{part:'prompt'}),{code:'content_changed'});
 const first=await reader.content(own.token,sid,recentId,{part:'prompt',occurred_at:raw.items[0]!.occurred_at});const second=await reader.content(own.token,sid,recentId,{part:'prompt',occurred_at:raw.items[1]!.occurred_at});assert.equal(first.text,'RECENT_PRIVATE_TEXT');assert.equal(second.text,'SECOND_OCCURRENCE');
 await assert.rejects(reader.content(own.token,sid,recentId,{part:'prompt',occurred_at:'2026-09-22T00:00:00.123458Z'}),{code:'not_found'});
});

test('tool references retain database microseconds and resolve equivalent time zone representations',async t=>{
 const {db,reader,own,sid,installation}=await fixture(t);
 for(const [event_type,at,payload]of [
  ['PreToolUse','2026-09-22T00:00:01.111222Z',{tool_name:'ReadFile',tool_use_id:'precise-tool',tool_input:{file:'PRECISE_INPUT'}}],
  ['PostToolUse','2026-09-22T00:00:02.333444Z',{tool_name:'ReadFile',tool_use_id:'precise-tool',tool_response:'PRECISE_OUTPUT'}],
 ] as const)await db.ingest({schema_version:2,installation_id:installation,client_event_id:event_type,occurred_at:at,event_type,source_session_id:'long-session',payload},{admissionEpoch:1,receivedAt:clock()});
 const worker=createSessionDerivationService(db);while(await worker.runOne()){/* finite facts */}
 const pre=(await reader.fragments(own.token,sid)).items.find(row=>row.kind==='PreToolUse')!;assert.equal(pre.pre_ref!.occurred_at,'2026-09-22T00:00:01.111222Z');assert.equal(pre.post_ref!.occurred_at,'2026-09-22T00:00:02.333444Z');
 assert.match((await reader.content(own.token,sid,pre.input_ref!.event_id,{part:'tool_input',occurred_at:pre.input_ref!.occurred_at})).text,/PRECISE_INPUT/);
 assert.equal((await reader.content(own.token,sid,pre.post_ref!.event_id,{part:'tool_response',occurred_at:'2026-09-22T08:00:02.333444+08:00'})).text,'PRECISE_OUTPUT');
 for(const occurred_at of ['2026-02-30T00:00:00Z','2026-09-22T00:00:02.3334449Z'])await assert.rejects(reader.content(own.token,sid,pre.post_ref!.event_id,{part:'tool_response',occurred_at}),{code:'invalid_request'});
});
async function fixture(t: TestContext) {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-07-01Z'), new Date('2026-10-01Z'));
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock });
  const seed = await identity.bootstrap({ email: 'content-root@example.invalid', name: '内容超管' }); const temp = await identity.login('content-root@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(temp.token, seed.temporaryPassword, 'content-root-password');
  const owner = randomUUID(); const installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [owner, 'content-owner@example.invalid', '内容本人']);
  const issued = await identity.resetPassword(root.token, owner, 1); const initial = await identity.login('content-owner@example.invalid', issued.temporaryPassword);
  const own = await identity.changePassword(initial.token, issued.temporaryPassword, 'content-owner-password');
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, owner, 'a'.repeat(64), '内容夹具']);
  const put = (id: string, at: string, payload: Record<string, unknown>) => db.ingest({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at: at, event_type: 'UserPromptSubmit', source_session_id: 'long-session', payload }, { admissionEpoch: 1, receivedAt: clock() });
  const old = await put('old', '2026-07-10T00:00:00Z', { prompt: 'OLD_PRIVATE_TEXT' });
  const recent = await put('recent', '2026-09-22T00:00:00.123456Z', { prompt: 'RECENT_PRIVATE_TEXT' });
  if (old.outcome !== 'committed' || recent.outcome !== 'committed') throw new Error('fixture failed');
  return { db, identity, root, own, owner, installation, sid: recent.sessionId, oldId: old.eventId, recentId: recent.eventId, reader: createSessionReadService(db, identity, { clock }) };
}

test('personal session reads are fixed to the owner and old content cannot escape the 45-day boundary', async t => {
  const { reader, root, own, sid, recentId, oldId } = await fixture(t);
  assert.equal((await reader.listMine(root.token)).items.length, 0);
  const mine = await reader.listMine(own.token); assert.equal(mine.items.length, 1); assert.equal(mine.items[0]?.title, 'RECENT_PRIVATE_TEXT');
  assert.equal((await reader.listAll(root.token)).items.length, 1);
  await assert.rejects(reader.listAll(own.token), { code: 'forbidden' });
  const detail = await reader.detail(own.token, sid); assert.equal(detail.partial_history, true); assert.equal(detail.prompt_turns, 1);
  const page = await reader.fragments(own.token, sid); assert.equal(page.items.length, 1); assert.equal(page.items[0]?.event_id, recentId); assert.ok(!JSON.stringify(page).includes('PRIVATE_TEXT'));
  const body = await reader.content(own.token, sid, recentId, { part: 'prompt' }); assert.equal(body.text, 'RECENT_PRIVATE_TEXT');
  await assert.rejects(reader.content(own.token, sid, oldId, { part: 'payload' }), { code: 'not_found' });
  await assert.rejects(reader.detail(own.token, sid, { from: '2026-07-01T00:00:00Z', to: '2026-09-24T00:00:00Z' }), { code: 'invalid_period' });
});


test('new observations mark the existing trace pending until the next snapshot is published', async t => {
  const { reader, db, own, sid, installation } = await fixture(t);
  const worker = createSessionDerivationService(db);
  while (await worker.runOne()) { /* Drain the finite fixture. */ }
  assert.equal((await reader.detail(own.token, sid)).projection_ready, true);
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'late-stop', occurred_at: '2026-09-22T00:00:01Z', event_type: 'Stop', source_session_id: 'long-session', payload: { last_assistant_message: '新增回答' } }, { admissionEpoch: 1, receivedAt: clock() });
  const pending = await reader.detail(own.token, sid);
  assert.equal(pending.projection_ready, false);
  assert.ok(pending.quality.includes('projection_pending'));
  assert.equal((await reader.fragments(own.token, sid)).projection_ready, false);
  while (await worker.runOne()) { /* Publish the following snapshot. */ }
  assert.equal((await reader.detail(own.token, sid)).projection_ready, true);
  assert.equal((await reader.fragments(own.token, sid)).items.length, 2);
});

test('turn snapshot versions survive token renewal and change only with a different published trace', async t => {
  const { db, identity, own, sid, installation } = await fixture(t);
  const worker = createSessionDerivationService(db);
  while (await worker.runOne()) { /* Publish the finite fixture. */ }
  let now = clock();
  const reader = createSessionReadService(db, identity, { clock: () => now });
  const first = await reader.turns(own.token, sid);
  assert.ok(first.snapshot_version);
  now = new Date(now.getTime() + 1000);
  const renewed = await reader.turns(own.token, sid);
  assert.notEqual(renewed.snapshot, first.snapshot);
  assert.equal(renewed.snapshot_version, first.snapshot_version);
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'snapshot-version-new', occurred_at: '2026-09-22T00:02:00Z', event_type: 'UserPromptSubmit', source_session_id: 'long-session', payload: { prompt: 'NEW_TRACE_VERSION' } }, { admissionEpoch: 1, receivedAt: clock() });
  while (await worker.runOne()) { /* Publish a new trace. */ }
  const changed = await reader.turns(own.token, sid);
  assert.ok(changed.snapshot_version);
  assert.notEqual(changed.snapshot_version, first.snapshot_version);
});

test('the turn directory pages recent turns and pins their numbering while late prompts create a new snapshot', async t => {
  const { reader, db, own, sid, installation } = await fixture(t);
  const put = (key: string, at: string) => db.ingest({ schema_version: 2, installation_id: installation, client_event_id: key, occurred_at: at, event_type: 'UserPromptSubmit', source_session_id: 'long-session', payload: { prompt: key } }, { admissionEpoch: 1, receivedAt: clock() });
  await put('第二条近期提示', '2026-09-22T00:01:00Z');
  const worker = createSessionDerivationService(db);
  while (await worker.runOne()) { /* Finite fixture. */ }
  const first = await reader.turns(own.token, sid, { limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.items[0]?.prompt_preview, 'RECENT_PRIVATE_TEXT'); assert.equal(first.items[0]?.turn_index, 2); assert.ok(first.next_cursor); assert.ok(first.snapshot);
  await put('迟到插入提示', '2026-09-22T00:00:30Z');
  while (await worker.runOne()) { /* Replace published numbering. */ }
  const second = await reader.turns(own.token, sid, { limit: 1, cursor: first.next_cursor! });
  assert.equal(second.items[0]?.prompt_preview, '第二条近期提示'); assert.equal(second.items[0]?.turn_index, 3);
  const pinned = await reader.fragments(own.token, sid, { turn: 3, snapshot: first.snapshot! });
  assert.equal(pinned.items.length, 1);
  assert.equal((await reader.content(own.token, sid, pinned.items[0]!.event_id, { part: 'prompt' })).text, '第二条近期提示');
  const fresh = await reader.turns(own.token, sid);
  assert.deepEqual(fresh.items.map(turn => turn.prompt_preview), ['RECENT_PRIVATE_TEXT', '迟到插入提示', '第二条近期提示']);
});

test('microsecond event pages do not repeat or skip facts and cleanup invalidates earlier cursors and content references', async t => {
  const { reader, db, own, owner, sid, installation, recentId } = await fixture(t);
  const second = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'micro-next', occurred_at: '2026-09-22T00:00:00.123457Z', event_type: 'UserPromptSubmit', source_session_id: 'long-session', payload: { prompt: '相邻微秒' } }, { admissionEpoch: 1, receivedAt: clock() });
  if (second.outcome !== 'committed') throw new Error('fixture failed');
  const first = await reader.fragments(own.token, sid, { mode: 'raw', limit: 1 }); assert.equal(first.items[0]?.event_id, recentId); assert.ok(first.next_cursor);
  const next = await reader.fragments(own.token, sid, { mode: 'raw', limit: 1, cursor: first.next_cursor! }); assert.equal(next.items[0]?.event_id, second.eventId); assert.equal(next.next_cursor, null);
  await db.transaction(async client => {
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [owner]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)', [owner, '2026-09-22T00:00:00.123456Z', '2026-09-22T00:00:00.123457Z']);
  });
  await assert.rejects(reader.fragments(own.token, sid, { mode: 'raw', limit: 1, cursor: first.next_cursor! }), { code: 'invalid_cursor' });
  await assert.rejects(reader.content(own.token, sid, recentId, { part: 'prompt' }), { code: 'not_found' });
  assert.equal((await reader.listMine(own.token)).items[0]?.title, '相邻微秒');
  assert.deepEqual((await reader.fragments(own.token, sid, { mode: 'raw' })).items.map(event => event.event_id), [second.eventId]);
});

test('a tool response arriving after the next prompt stays with its unique original invocation across batches and rebuild',async t=>{
 const {db,reader,own,installation}=await fixture(t);
 const events=[
  ['UserPromptSubmit',{prompt:'FIRST_TURN'}],
  ['PreToolUse',{tool_use_id:'slow-a',tool_name:'Read',tool_input:{file:'FIRST_FILE'}}],
  ['UserPromptSubmit',{prompt:'SECOND_TURN'}],
  ['PreToolUse',{tool_use_id:'fast-b',tool_name:'Read',tool_input:{file:'SECOND_FILE'}}],
  ['PostToolUse',{tool_use_id:'fast-b',tool_name:'Read',tool_response:'SECOND_RESULT'}],
  ['PostToolUse',{tool_use_id:'slow-a',tool_name:'Read',tool_response:'LATE_FIRST_RESULT'}],
 ] as const;
 let sid='';const ids:string[]=[];
 for(const [i,[event_type,payload]] of events.entries()){
  const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`cross-prompt-${i}`,occurred_at:`2026-09-22T10:00:0${i}Z`,event_type,source_session_id:'cross-prompt',payload},{admissionEpoch:1,receivedAt:clock()});assert.equal(saved.outcome,'committed');if(saved.outcome==='committed'){sid=saved.sessionId;ids.push(saved.eventId);}
 }
 const worker=createSessionDerivationService(db,{batchSize:1,clock});let count=0;while(await worker.runOne(sid))assert.ok(++count<12);
 const first=await reader.fragments(own.token,sid,{turn:1});assert.deepEqual(first.items.map(row=>row.event_id),[ids[0],ids[1],ids[5]]);
 const pre=first.items.find(row=>row.kind==='PreToolUse')!;assert.equal(pre.post_ref?.event_id,ids[5]);assert.equal(pre.duration_ms,'4000');assert.equal((await reader.content(own.token,sid,pre.post_ref!.event_id,{part:'tool_response',occurred_at:pre.post_ref!.occurred_at})).text,'LATE_FIRST_RESULT');
 const second=await reader.fragments(own.token,sid,{turn:2});assert.deepEqual(second.items.map(row=>row.event_id),[ids[2],ids[3],ids[4]]);assert.equal(second.items.find(row=>row.kind==='PreToolUse')?.post_ref?.event_id,ids[4]);
 const page=await reader.turns(own.token,sid,{limit:1});assert.equal(page.items[0]?.events,3);assert.equal((await reader.turns(own.token,sid,{limit:1,cursor:page.next_cursor!})).items[0]?.events,3);
 await worker.enqueueRebuild(sid);const resumed=createSessionDerivationService(db,{batchSize:2,clock});count=0;while(await resumed.runOne(sid))assert.ok(++count<8);assert.deepEqual((await reader.fragments(own.token,sid,{turn:1})).items.map(row=>row.event_id),[ids[0],ids[1],ids[5]]);
 assert.equal((await reader.detail(own.token,sid)).events,6);assert.equal((await reader.detail(own.token,sid)).prompt_turns,2);
});

test('a delayed completion notification after two prompt responses does not declare the later turn complete',async t=>{
 const {db,reader,own,installation}=await fixture(t);const events=[
  ['UserPromptSubmit',{prompt:'FIRST_QUERY'}],['Stop',{last_assistant_message:'FIRST_RESPONSE',stop_hook_active:false}],
  ['UserPromptSubmit',{prompt:'SECOND_QUERY'}],['Stop',{last_assistant_message:'SECOND_RESPONSE',stop_hook_active:false}],
  ['Notification',{notification_type:'idle_prompt',message:'任务完成'}],
 ] as const;let sid='';let notification='';
 for(const [i,[event_type,payload]] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`late-notice-${i}`,event_type,source_session_id:'late-notice',occurred_at:`2026-09-22T11:00:0${i}Z`,payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;if(i===4)notification=saved.eventId;}
 const worker=createSessionDerivationService(db,{batchSize:2,clock});let count=0;while(await worker.runOne(sid))assert.ok(++count<8);
 const detail=await reader.detail(own.token,sid);assert.equal(detail.status,'unknown');assert.ok(detail.quality.includes('completion_association_ambiguous'));assert.equal((await reader.fragments(own.token,sid)).items.find(row=>row.event_id===notification)?.turn_index,null);assert.equal((await reader.fragments(own.token,sid,{mode:'raw'})).items.length,5);
});

test('continuing after a completion observation reopens the turn and preserves equal Stop bodies as distinct facts',async t=>{
 const {db,reader,own,installation}=await fixture(t);const events=[
  ['UserPromptSubmit',{prompt:'CONTINUE_QUERY'}],['Stop',{last_assistant_message:'REPEATED_STOP_TEXT',loop_count:0,stop_hook_active:false}],
  ['Notification',{notification_type:'idle_prompt'}],['PreToolUse',{tool_use_id:'continue-read',tool_name:'Read'}],
  ['Stop',{last_assistant_message:'REPEATED_STOP_TEXT',loop_count:1,stop_hook_active:true}],
 ] as const;let sid='';const stops:string[]=[];
 for(const [i,[event_type,payload]] of events.entries()){const envelope={schema_version:2 as const,installation_id:installation,client_event_id:`continue-${i}`,event_type,source_session_id:'continue-query',occurred_at:`2026-09-22T12:00:0${i}Z`,payload};const saved=await db.ingest(envelope,{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;if(event_type==='Stop')stops.push(saved.eventId);if(i===4)assert.equal((await db.ingest(envelope,{admissionEpoch:1,receivedAt:clock()})).outcome,'duplicate');}
 const worker=createSessionDerivationService(db,{batchSize:1,clock});let count=0;while(await worker.runOne(sid))assert.ok(++count<10);
 const detail=await reader.detail(own.token,sid);assert.equal(detail.status,'unknown');assert.equal(detail.prompt_turns,1);assert.equal(detail.events,5);
 const trace=await reader.fragments(own.token,sid,{turn:1});assert.deepEqual(trace.items.filter(row=>row.kind==='Stop').map(row=>row.event_id),stops);for(const id of stops)assert.equal((await reader.content(own.token,sid,id,{part:'response'})).text,'REPEATED_STOP_TEXT');
});

test('distinct tool starts sharing an ID do not force a response onto an arbitrary start',async t=>{
 const {db,reader,own,installation}=await fixture(t);const events=[
  ['UserPromptSubmit',{prompt:'AMBIGUOUS_TOOL'}],
  ['PreToolUse',{tool_use_id:'reused-id',tool_name:'Read',tool_input:{file:'ONE'}}],
  ['PreToolUse',{tool_use_id:'reused-id',tool_name:'Read',tool_input:{file:'TWO'}}],
  ['PostToolUse',{tool_use_id:'reused-id',tool_name:'Read',tool_response:'UNASSIGNED_RESULT'}],
 ] as const;let sid='';
 for(const [i,[event_type,payload]] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`ambiguous-tool-${i}`,event_type,source_session_id:'ambiguous-tool',occurred_at:`2026-09-22T13:00:0${i}Z`,payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;}
 const worker=createSessionDerivationService(db,{batchSize:1,clock});let count=0;while(await worker.runOne(sid))assert.ok(++count<8);
 const post=(await reader.fragments(own.token,sid)).items.find(row=>row.kind==='PostToolUse')!;assert.equal(post.pre_ref,null);assert.equal(post.turn_index,null);assert.ok((await reader.detail(own.token,sid)).quality.includes('tool_identity_conflict'));assert.equal((await reader.fragments(own.token,sid,{mode:'raw'})).items.length,4);
});

test('a completed snapshot from older rules is queued once for background upgrade and becomes readable again',async t=>{
 const {db,reader,own,sid}=await fixture(t);const worker=createSessionDerivationService(db,{clock});let count=0;while(await worker.runOne(sid))assert.ok(++count<8);assert.equal((await reader.detail(own.token,sid)).projection_ready,true);
 await db.query("UPDATE session_derivations SET metric_version='session-v7' WHERE id=(SELECT derived_run_id FROM sessions WHERE id=$1)",[sid]);assert.equal((await reader.detail(own.token,sid)).projection_ready,false);
 const upgraded=createSessionDerivationService(db,{clock});assert.equal(await upgraded.discoverStale(),1);assert.equal(await createSessionDerivationService(db,{clock}).discoverStale(),0);count=0;while(await upgraded.runOne(sid))assert.ok(++count<8);
 assert.equal((await reader.detail(own.token,sid)).projection_ready,true);assert.equal((await reader.detail(own.token,sid)).events,1);assert.equal(await createSessionDerivationService(db,{clock}).discoverStale(),0);
});

test('a return with no observed tool start remains unassigned after a newer prompt',async t=>{
 const {db,reader,own,installation}=await fixture(t);const events=[['UserPromptSubmit',{prompt:'OLD_QUERY'}],['UserPromptSubmit',{prompt:'NEW_QUERY'}],['PostToolUse',{tool_use_id:'missing-start',tool_name:'Read',tool_response:'OLD_OR_UNKNOWN_RESULT'}]] as const;let sid='';
 for(const [i,[event_type,payload]] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`missing-pre-${i}`,event_type,source_session_id:'missing-pre',occurred_at:`2026-09-22T14:00:0${i}Z`,payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;}
 const worker=createSessionDerivationService(db,{clock});while(await worker.runOne(sid)){/* finite facts */}
 const post=(await reader.fragments(own.token,sid)).items.find(row=>row.kind==='PostToolUse')!;assert.equal(post.turn_index,null);assert.equal(post.pre_ref,null);assert.equal((await reader.fragments(own.token,sid,{turn:2})).items.length,1);assert.ok((await reader.detail(own.token,sid)).quality.includes('incomplete_tool_pairs'));
});

test('a uniquely identified return with reversed timestamps can link to its observed start without inventing duration',async t=>{
 const {db,reader,own,installation}=await fixture(t);const events=[['UserPromptSubmit',{prompt:'CLOCK_CONFLICT'}],['PostToolUse',{tool_use_id:'reversed-call',tool_name:'Read',tool_response:'EARLY_RESULT'}],['PreToolUse',{tool_use_id:'reversed-call',tool_name:'Read',tool_input:{file:'LATE_START'}}]] as const;let sid='';let postId='';
 for(const [i,[event_type,payload]] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`reversed-${i}`,event_type,source_session_id:'reversed-call',occurred_at:`2026-09-22T15:00:0${i}Z`,payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;if(i===1)postId=saved.eventId;}
 const worker=createSessionDerivationService(db,{clock,batchSize:1});let count=0;while(await worker.runOne(sid))assert.ok(++count<6);
 const trace=await reader.fragments(own.token,sid,{turn:1});const pre=trace.items.find(row=>row.kind==='PreToolUse')!;assert.equal(pre.post_ref?.event_id,postId);assert.equal(pre.duration_ms,null);assert.equal(pre.input_ref?.event_id,pre.event_id);assert.ok((await reader.detail(own.token,sid)).quality.includes('clock_order_conflict'));assert.equal(trace.items.find(row=>row.kind==='PostToolUse')?.turn_index,1);
});

test('Stop reentry counts preserve zero, missing and invalid values without creating prompt turns',async t=>{
 const {db,reader,own,installation}=await fixture(t);let sid='';const payloads:Record<string,unknown>[]=[{loop_count:0,stop_hook_active:false},{loop_count:2,stop_hook_active:true},{loop_count:1},{},{loop_count:-1},{loop_count:1.5},{loop_count:'3'},{loop_count:null}];
 const events=[{type:'UserPromptSubmit',payload:{prompt:'STOP_COUNTER'}},...payloads.map(payload=>({type:'Stop',payload:{...payload,last_assistant_message:'STOP_BODY'}})),{type:'UserPromptSubmit',payload:{prompt:'NEXT_QUERY'}},{type:'Stop',payload:{loop_count:0,last_assistant_message:'NEXT_STOP'}}];
 for(const [i,event] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`stop-count-${i}`,event_type:event.type,source_session_id:'stop-count',occurred_at:new Date(Date.parse('2026-09-22T16:00:00Z')+i*1000).toISOString(),payload:event.payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;}
 const worker=createSessionDerivationService(db,{clock,batchSize:1});let n=0;while(await worker.runOne(sid))assert.ok(++n<16);
 const stops=(await reader.fragments(own.token,sid)).items.filter(row=>row.kind==='Stop');assert.deepEqual(stops.map(row=>row.stop?.reentry_count),[0,2,1,null,null,null,null,null,0]);assert.deepEqual(stops.map(row=>row.stop?.count_state),['valid','valid','valid','missing','invalid','invalid','invalid','missing','valid']);assert.equal(stops[0]?.stop?.hook_active,false);assert.equal(stops[1]?.stop?.hook_active,true);
 const detail=await reader.detail(own.token,sid);assert.equal(detail.prompt_turns,2);assert.equal(detail.status,'unknown');for(const flag of ['stop_reentry_count_missing','stop_reentry_count_invalid','stop_reentry_count_reset'])assert.ok(detail.quality.includes(flag),flag);
 await worker.enqueueRebuild(sid);n=0;while(await worker.runOne(sid))assert.ok(++n<16);assert.deepEqual((await reader.fragments(own.token,sid,{mode:'raw'})).items.filter(row=>row.kind==='Stop').map(row=>row.stop?.reentry_count),stops.map(row=>row.stop?.reentry_count));
});

test('Stop numeric validation remains exact and a new prompt resets the comparison baseline',async t=>{
 const {db,reader,own,installation}=await fixture(t);let sid='';const entries=[['UserPromptSubmit',{prompt:'ONE'}],['Stop',{loop_count:2147483647}],['UserPromptSubmit',{prompt:'TWO'}],['Stop',{loop_count:0}],['Stop',{loop_count:2147483648}],['Stop',{loop_count:0}]] as const;
 for(const [i,[event_type,payload]] of entries.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`exact-count-${i}`,event_type,source_session_id:'exact-count',occurred_at:new Date(Date.parse('2026-09-23T02:00:00Z')+i*1000).toISOString(),payload},{admissionEpoch:1,receivedAt:clock()});if(saved.outcome!=='committed')throw new Error('fixture failed');sid=saved.sessionId;if(i===5)await db.query("UPDATE hook_events SET payload=jsonb_set(payload,'{loop_count}','1e-3000'::jsonb) WHERE id=$1 AND occurred_at=$2",[saved.eventId,'2026-09-23T02:00:05Z']);}
 const worker=createSessionDerivationService(db,{clock,batchSize:1});let n=0;while(await worker.runOne(sid))assert.ok(++n<12);
 const stops=(await reader.fragments(own.token,sid)).items.filter(row=>row.kind==='Stop');assert.deepEqual(stops.map(row=>row.stop),[{reentry_count:2147483647,count_state:'valid',hook_active:null},{reentry_count:0,count_state:'valid',hook_active:null},{reentry_count:null,count_state:'invalid',hook_active:null},{reentry_count:null,count_state:'invalid',hook_active:null}]);assert.ok(!(await reader.detail(own.token,sid)).quality.includes('stop_reentry_count_reset'));
});
