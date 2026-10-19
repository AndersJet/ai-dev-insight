import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {capacityDatabase,digest} from './session-list-capacity-fixture.mjs';
import {readCapacityDiagnostic,readReadyCapacityStops,capacityReadyStopGroups,maximumCapacityStop,assessCapacityFreshResponse,capacityStopWithinDeadline} from './session-list-capacity-traffic.mjs';

const fixture=JSON.parse(await readFile(new URL('../.run/session-list-capacity/config.json',import.meta.url))),report=JSON.parse(await readFile(process.argv[2]));
assert.equal(fixture.synthetic,true);assert.equal(fixture.scale,'smoke');assert.equal(report.scale,'smoke');assert.equal(report.mixed.pass,true);assert.equal(report.actual_fixture.sessions,500);
const stops=globalThis.structuredClone(report.mixed.stop_observations),db=capacityDatabase(fixture.schema,false,1),checks=[];
const legacySql=`SELECT k.client_event_id,e.received_at,e.capture_generation,s.id,s.user_id,s.source_session_id,q.observed_at,q.hook_key,r.source_generation,r.computed_at AS derived_at,r.cleanup_generation AS derived_cleanup,u.cleanup_generation AS current_cleanup,
 md5(jsonb_build_array(s.first_at,s.last_at,s.history_redacted,s.history_expired,COALESCE((SELECT jsonb_agg(jsonb_build_array(h.id,h.occurred_at,h.capture_generation) ORDER BY h.occurred_at,h.id) FROM hook_events h WHERE h.session_id=s.id),'[]'::jsonb))::text) AS current_key
 FROM event_keys k JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at JOIN sessions s ON s.id=e.session_id
 JOIN users u ON u.id=s.user_id LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.state='published'
 LEFT JOIN session_usage_queries q ON q.session_id=s.id AND q.provider_account=$2 WHERE k.client_event_id=ANY($1::text[])`;
const ids=stops.map(s=>s.client_event_id),ordered=rows=>rows.map(r=>r.client_event_id).sort();
async function compare(target,name){
 const old=(await readCapacityDiagnostic(target,legacySql,[ids,fixture.provider_account])).rows,newRows=await readReadyCapacityStops(target,stops,fixture.provider_account),groups=capacityReadyStopGroups(newRows,globalThis.structuredClone(stops)),accepted=[...groups.values()].flat().map(s=>s.row);
 const oldAccepted=old.filter(r=>r.derived_at&&r.source_generation>=r.capture_generation&&r.derived_cleanup===r.current_cleanup&&r.observed_at&&r.hook_key===r.current_key);
 assert.deepEqual(ordered(accepted),ordered(oldAccepted));assert.equal(newRows.length,old.length);
 for(const row of newRows)assert.equal(row.received_at.getTime(),old.find(r=>r.client_event_id===row.client_event_id).received_at.getTime());
 checks.push({name,ready_stops:accepted.length,persisted_stops:newRows.length,groups:groups.size});return {groups,rows:newRows};
}
try{
 const baseline=await compare(db,'real Worker-published baseline');assert.equal(baseline.rows.length,9);assert.equal([...baseline.groups.values()].flat().length,9);
 const group=[...baseline.groups.values()].find(g=>g.length===4),row=group[0].row,source=report.mixed.sources.find(s=>s.source_session_id===row.source_session_id),probe=maximumCapacityStop(group,source);
 const query=new globalThis.URLSearchParams({...fixture.period,user_id:row.user_id,search:row.source_session_id,channel:'all',limit:'20'}),started=performance.now(),response=await globalThis.fetch('http://127.0.0.1:4188/api/v1/admin/sessions?'+query,{headers:{cookie:'adi_session='+fixture.admin_token}}),body=await response.json(),actual={code:response.ok?'ok':body.error.code,data:body.data};
 assert.equal(assessCapacityFreshResponse(actual,row.source_session_id,row.id,source.expected_tokens,row.user_id,probe).correct,true);
 const captured=(await readCapacityDiagnostic(db,`SELECT (s.value->>'source_generation')::int AS generation FROM session_list_snapshots h JOIN session_list_snapshot_entries e ON e.id=(h.owner_entries->>$2)::uuid JOIN LATERAL jsonb_array_elements(e.payload->'sessions') s(value) ON s.value->>'id'=$3 WHERE h.id=$1 AND e.user_id=$2::uuid`,[body.data.snapshot.id,row.user_id,row.id])).rows[0];
 assert.ok(captured.generation>=probe.capture_generation);checks.push({name:'actual API time/token/records/channel plus captured owner-entry source generation',snapshot_id:body.data.snapshot.id,captured_generation:captured.generation,max_stop_generation:probe.capture_generation,elapsed_ms:performance.now()-started});
 for(const [name,modify] of [
  ['old snapshot',r=>{r.data.snapshot.as_of=new Date(Date.parse(probe.received_at)-1).toISOString();}],
  ['old session time',r=>{r.data.items.find(i=>i.id===row.id).last_at=new Date(Date.parse(probe.at)-1).toISOString();}],
  ['wrong records with correct tokens',r=>{r.data.items.find(i=>i.id===row.id).official_records++;}],
  ['wrong channel with correct records',r=>{r.data.items.find(i=>i.id===row.id).channel=probe.expected_channel==='official'?'pending':'official';}],
  ['wrong source identity',r=>{r.data.items.find(i=>i.id===row.id).source_session_id='wrong-source';}],
 ]){const negative=globalThis.structuredClone(actual);modify(negative);assert.equal(assessCapacityFreshResponse(negative,row.source_session_id,row.id,source.expected_tokens,row.user_id,probe).correct,false);checks.push({name,rejected:true});}
 const disordered=globalThis.structuredClone(group);disordered[0].stop.at='2026-10-09T17:00:20.000Z';disordered[1].stop.at='2026-10-09T17:00:10.000Z';for(const item of disordered.slice(2))item.stop.at='2026-10-09T17:00:00.000Z';disordered[0].row.received_at=new Date('2026-10-09T17:00:10.000Z');disordered[1].row.received_at=new Date('2026-10-09T17:00:30.000Z');for(const item of disordered.slice(2))item.row.received_at=new Date('2026-10-09T17:00:00.000Z');
 const maximum=maximumCapacityStop(disordered,source);assert.equal(maximum.at,'2026-10-09T17:00:20.000Z');assert.equal(maximum.received_at,'2026-10-09T17:00:30.000Z');checks.push({name:'independent maxima from different Stops',pass:true});
 assert.equal(capacityStopWithinDeadline({elapsed_ms:60001,derived_ready_ms:0}),false);assert.equal(capacityStopWithinDeadline({elapsed_ms:0,derived_ready_ms:60001}),false);assert.equal(capacityStopWithinDeadline({elapsed_ms:60000,derived_ready_ms:60000}),true);checks.push({name:'late official or derived observation still rejected individually',pass:true});
 await promisify(execFile)('docker',['compose','-f','deploy/product/compose.session-capacity.yml','stop','api','worker','collector']);
 const rollback=new Error('observer_proof_rollback');
 try{await db.transaction(async sql=>{
  // Mutation cases are deliberately rollback-only. The actual exported helper
  // SQL is used on this one transaction; its READ ONLY declaration is suppressed
  // only because these negative fixtures are already inside a write transaction.
  const target={transaction:fn=>fn({query:(statement,values)=>statement.startsWith('SET TRANSACTION')?Promise.resolve({rows:[],rowCount:0}):sql.query(statement,values)})};
  const metadata=(await sql.query('SELECT derived_run_id FROM sessions WHERE id=$1',[row.id])).rows[0],run=metadata.derived_run_id;
  await sql.query('UPDATE session_derivations SET source_generation=$2 WHERE id=$1',[run,Math.min(...group.map(s=>s.row.capture_generation))]);
  const mixed=await compare(target,'same session early Stop eligible; later generation insufficient');assert.equal(mixed.groups.get(row.id).length,1);
  await sql.query('UPDATE session_derivations SET source_generation=$2,state=$3 WHERE id=$1',[run,row.source_generation,'building']);const qOnly=await compare(target,'q complete but derivation unpublished');assert.equal(qOnly.groups.has(row.id),false);
  await sql.query("UPDATE session_derivations SET state='published' WHERE id=$1",[run]);await sql.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[row.user_id]);const cleanup=await compare(target,'current cleanup differs');assert.equal(cleanup.groups.has(row.id),false);
  await sql.query('UPDATE users SET cleanup_generation=cleanup_generation-1 WHERE id=$1',[row.user_id]);await sql.query("UPDATE session_usage_queries SET hook_key='observer-stale-key' WHERE session_id=$1 AND provider_account=$2",[row.id,fixture.provider_account]);const stale=await compare(target,'q fingerprint stale');assert.equal(stale.groups.has(row.id),false);throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 const restored=await compare(db,'all negative metadata changes rolled back');assert.equal([...restored.groups.values()].flat().length,9);
 const artifact=new URL('../.run/session-list-capacity/observer-equivalence-'+Date.now()+'.json',import.meta.url);await writeFile(artifact,JSON.stringify({at:new Date().toISOString(),pass:true,schema:fixture.schema,source_sha256:{traffic:digest(await readFile(new URL('./session-list-capacity-traffic.mjs',import.meta.url))),proof:digest(await readFile(new URL(import.meta.url)))},checks,scope:'Real nine persisted Stops and real Worker-published derivations/q; actual API and captured snapshot metadata inspected. Negative metadata mutations rollback-only with all services stopped; per-Stop receive times and eligible membership equal the former gate. Pure API adversarial cases call the actual runner assessment helper. No production data, clocks, budgets or facts changed.'},null,2)+'\n');console.log(JSON.stringify({artifact:artifact.pathname,pass:true,checks}));
}finally{await db.close();}
