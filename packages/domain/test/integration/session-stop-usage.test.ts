import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stopUsageFixture as fixture} from '../helpers/stop-usage.js';
test('Stop discovery uses session quantities rather than narrow-window quantities through the worker and authorized reader',async t=>{
 const {run,read,requests}=await fixture(t);assert.equal((await run()).status,'succeeded');const result=await read();
 assert.equal(result.groups[0]?.tokens,'176004');assert.ok(requests.some(r=>r.path.endsWith('user_usage_detail')));assert.ok(requests.some(r=>r.body.session_ids instanceof Array&&r.body.session_ids[0]==='official-bill'));
});

test('a new Stop immediately wakes a cooled recurring query instead of waiting five minutes',async t=>{
 const f=await fixture(t);await f.jobs.discoverRecent();await f.run();
 await f.db.query("UPDATE jobs SET available_at=clock_timestamp()+interval '1 day' WHERE kind='usage_attribution'");
 const received=new Date();await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'new-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:received.toISOString(),payload:{last_assistant_message:'续聊'}},{admissionEpoch:1,receivedAt:received});
 const rows=await f.db.query<{available_at:Date}>("SELECT available_at FROM jobs WHERE kind='usage_attribution'");assert.ok(rows.rows[0]!.available_at.getTime()<=received.getTime(),'Stop must schedule the next background query immediately');
});

test('failed refresh retains the last official quantity but exposes it as a failed refresh',async t=>{
 const f=await fixture(t);await f.run();f.control.fail=true;assert.equal((await f.run()).status,'queued');
 const result=await f.read();assert.equal(result.groups[0]?.tokens,'176004');assert.ok(result.session_query?.reasons.includes('query_failed'));
});

test('multiple candidates stay pending without selecting the first bill or issuing a session quantity request',async t=>{
 const f=await fixture(t);f.control.ids=['bill-a','bill-b'];await f.run();const result=await f.read();assert.deepEqual(result.groups,[]);assert.equal(result.session_query?.state,'pending');assert.ok(result.session_query?.reasons.includes('multiple_candidates'));
 assert.equal(f.requests.filter(r=>r.body.session_ids instanceof Array&&r.body.session_ids[0]!=='synthetic-hook').length,0);
});
test('a competing Hook added after publication withdraws inferred quantities immediately',async t=>{
 const f=await fixture(t);await f.run();assert.equal((await f.read()).groups[0]?.tokens,'176004');
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'competing',source_session_id:'competing-hook',event_type:'UserPromptSubmit',occurred_at:f.stop.toISOString(),payload:{prompt:'PRIVATE_OTHER_HOOK'}},{admissionEpoch:1,receivedAt:f.at});
 const result=await f.read();assert.deepEqual(result.groups,[]);assert.ok(result.session_query?.reasons.includes('competing_hook_sessions'));assert.ok(!JSON.stringify(result).includes('PRIVATE_OTHER_HOOK'));
});
test('empty candidate windows remain unknown and later official publication can recover',async t=>{
 const f=await fixture(t);f.control.ids=[];await f.run();const empty=await f.read();assert.deepEqual(empty.groups,[]);assert.equal(empty.session_query?.state,'pending');assert.ok(empty.session_query?.reasons.includes('no_candidate'));
 f.control.ids=['official-bill'];await f.run();assert.equal((await f.read()).groups[0]?.tokens,'176004');
});
test('owner mismatch in the session response cannot publish discovered quantities',async t=>{
 const f=await fixture(t);f.control.onSession=async()=>{f.control.owner='different-owner';};await f.run();assert.deepEqual((await f.read()).groups,[]);
});
test('cleanup during a session HTTP request fences its publication',async t=>{
 const f=await fixture(t);f.control.onSession=async()=>{await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);};await f.run();assert.deepEqual((await f.read()).groups,[]);
});
test('a new Hook event during a provider call prevents a stale publication',async t=>{
 const f=await fixture(t);f.control.onSession=async()=>{await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'concurrent-prompt',source_session_id:'synthetic-hook',event_type:'UserPromptSubmit',occurred_at:f.at.toISOString(),payload:{prompt:'续聊并发'}},{admissionEpoch:1,receivedAt:f.at});};assert.equal((await f.run()).status,'queued');assert.deepEqual((await f.read()).groups,[]);
});

test('session lists and their official channel filter use the same session quantity as the detail',async t=>{
 const f=await fixture(t);await f.run();const all=await f.reader.listMine(f.login.token,{channel:'official'});assert.equal(all.total,1);assert.equal(all.items[0]?.official_tokens,'176004');
});

test('continuation retains distinct billing IDs, deduplicates repeated IDs, and replaces revised quantities instead of accumulating them',async t=>{
 const f=await fixture(t);await f.run();const next=new Date(),second=Math.floor(next.getTime()/1000);f.control.windows.set(second-1,['second-bill']);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'continuation-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:next.toISOString(),payload:{last_assistant_message:'续聊完成'}},{admissionEpoch:1,receivedAt:next});
 assert.equal((await f.read()).session_query?.state,'pending');await f.run();let result=await f.read();assert.equal(result.groups[0]?.tokens,'352008');assert.deepEqual(result.session_query?.billing_ids,['official-bill','second-bill']);
 f.control.tokens=200000;await f.run();result=await f.read();assert.equal(result.groups[0]?.tokens,'400000');
 f.control.windows.set(second-1,['official-bill']);await f.run();result=await f.read();assert.equal(result.groups[0]?.tokens,'200000');assert.equal(result.session_query?.billing_ids.length,1);
});

test('sessions with more than fifty Stop observations can still discover and deduplicate official bills',async t=>{
 const f=await fixture(t);for(let i=1;i<=50;i++){const time=new Date(f.stop.getTime()-i*1000);await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'long-history-'+i,source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:time.toISOString(),payload:{last_assistant_message:'历史轮次'}},{admissionEpoch:1,receivedAt:f.at});}
 await f.run();assert.equal((await f.read()).groups[0]?.tokens,'176004');
});

test('department session filters do not assign an entire cross-department billing session to one department',async t=>{
 const f=await fixture(t),a=(await f.db.query<{id:string}>("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'部门A') RETURNING id")).rows[0]!.id,b=(await f.db.query<{id:string}>("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'部门B') RETURNING id")).rows[0]!.id;
 await f.db.query("UPDATE hook_events SET department_id=CASE WHEN event_type='Stop' THEN $2::uuid ELSE $3::uuid END WHERE session_id=$1",[f.session,a,b]);await f.run();
 const result=await f.reader.listAll(f.login.token,{department_id:a});assert.equal(result.items[0]?.official_tokens,null);assert.equal(result.items[0]?.department_unassigned_records,1);
});

test('unknown client metadata is not treated as IDE evidence for Stop-window inference',async t=>{
 const f=await fixture(t);f.control.client=null;await f.run();const result=await f.read();assert.deepEqual(result.groups,[]);assert.equal(result.session_query?.state,'pending');
});
