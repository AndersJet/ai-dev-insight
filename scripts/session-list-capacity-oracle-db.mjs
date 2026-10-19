import {assessStaticStopWindowCompetition,STATIC_COMPETITION_FENCES} from './session-list-capacity-oracle.mjs';

const read=(db,sql,values)=>db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query('SET LOCAL jit=off');return tx.query(sql,values);});
const projectedBills=`(SELECT jsonb_agg(jsonb_build_object('id',b->>'id','basis',b->>'basis')) FROM jsonb_array_elements(q.result->'bills')b)`;

/** Fixed independent fixture source inputs. Capture once at seed time, before
 * runtime queries can replace a continuation's initial source. No body search
 * or product safe-bill/query relation is used to create expected quantities. */
export async function captureStaticStopFixtureOracle(db,account){
 const rows=(await read(db,`SELECT f.id AS session_id,f.user_id,f.channel AS initial_channel,p.department AS department_id,
  s.first_at::text AS initial_first_at,q.hook_key AS initial_hook_key,q.cleanup_generation AS initial_cleanup_generation,q.ingest_epoch AS initial_ingest_epoch,q.provider_user_id,
  d.dataset_id,q.result->'windows' AS windows,${projectedBills} AS bills
  FROM capacity_fixture_sessions f JOIN sessions s ON s.id=f.id JOIN capacity_fixture_people p ON p.user_id=f.user_id
  JOIN session_usage_queries q ON q.session_id=f.id AND q.provider_account=$1 CROSS JOIN data_identity d
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(q.result->'bills')b WHERE b->>'basis'='stop_window') ORDER BY f.n`,[account])).rows;
 return rows.map(({windows,bills,...row})=>({...row,bills:bills.map(b=>({...b,...(b.basis==='stop_window'?{source_window:{ids:windows.find(w=>w.ids.length===1&&w.ids[0]===b.id)?.ids??[],start_seconds:(windows.find(w=>w.ids.length===1&&w.ids[0]===b.id)?.start_seconds??[]).map(String)}}:{})}))}));
}

/** Expected static-source transitions for the version actually returned by the
 * API. Captured job generation pins the committed Hook inputs; current session
 * last_at is never substituted for an older snapshot's bounds. This metadata
 * inspection runs only after the timed workload. It neither serves expired data
 * nor changes the planned live-source/missing-event denominators. */
export async function assessSnapshotStaticStopOracle(db,fixture,snapshot,sources){
 if(!Array.isArray(fixture.static_stop_oracle))return {status:'inconclusive',inconclusive:[{reason:'missing_fixed_fixture_stop_oracle'}],snapshot_id:snapshot.id,channel_adjustments:[],suppressed_session_ids:[]};
 const continuations=sources.filter(s=>s.continuation),continuedIds=new Set(continuations.map(s=>s.session_id)),continuedOwners=new Set(continuations.map(s=>s.user_id));
 const staticSessions=fixture.static_stop_oracle.filter(s=>continuedOwners.has(s.user_id)&&!continuedIds.has(s.session_id));
 if(!staticSessions.length)return {status:'complete',snapshot_id:snapshot.id,as_of:snapshot.as_of,channel_adjustments:[],suppressed_session_ids:[],inconclusive:[]};
 const owners=[...new Set(staticSessions.map(s=>s.user_id))];
 const header=(await read(db,`SELECT s.id,s.as_of,s.safety_fence,d.dataset_id,d.recovery_id,d.retention_cutoff::text
  FROM session_list_snapshots s CROSS JOIN data_identity d WHERE s.id=$1`,[snapshot.id])).rows[0];
 if(!header||header.recovery_id||header.dataset_id!==header.safety_fence.dataset_id||header.retention_cutoff!==header.safety_fence.retention_cutoff)return {status:'inconclusive',snapshot_id:snapshot.id,channel_adjustments:[],suppressed_session_ids:[],inconclusive:[{reason:'snapshot_safety_or_header_unavailable'}]};
 const payloads=(await read(db,`SELECT e.user_id,e.cleanup_generation,e.payload FROM session_list_snapshots s
  JOIN LATERAL jsonb_each_text(s.owner_entries)m ON true JOIN session_list_snapshot_entries e ON e.id=m.value::uuid WHERE s.id=$1 AND e.user_id=ANY($2::uuid[])`,[snapshot.id,owners])).rows;
 const captured=new Map(payloads.flatMap(o=>o.payload.sessions.map(s=>[s.id,{...s,user_id:o.user_id,cleanup_generation:o.cleanup_generation}])));
 const competitorSessions=[];
 for(const source of continuations.filter(s=>owners.includes(s.user_id))){
  const capturedSession=captured.get(source.session_id);
  if(!capturedSession)return {status:'inconclusive',snapshot_id:snapshot.id,channel_adjustments:[],suppressed_session_ids:[],inconclusive:[{reason:'captured_continuation_missing',session_id:source.session_id}]};
  const row=(await read(db,`SELECT $1::uuid AS session_id,$2::uuid AS user_id,floor(extract(epoch FROM min(e.occurred_at)))::bigint::text AS first_floor_seconds,
   floor(extract(epoch FROM max(e.occurred_at)))::bigint::text AS last_floor_seconds,
   bool_or((d.retention_cutoff IS NULL OR e.occurred_at>=d.retention_cutoff)AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)) AS has_retained_hook
   FROM hook_events e CROSS JOIN data_identity d WHERE e.session_id=$1 AND e.user_id=$2 AND e.capture_generation<=$3`,[source.session_id,source.user_id,capturedSession.source_generation])).rows[0];
  competitorSessions.push({...row,history_redacted:capturedSession.history_redacted,history_expired:capturedSession.history_expired,captured_generation:capturedSession.source_generation});
 }
 const current=new Map();
 for(let i=0;i<staticSessions.length;i+=100){
  const rows=(await read(db,`SELECT s.id,u.cleanup_generation,u.ingest_epoch,s.history_redacted,s.history_expired,q.hook_key,q.cleanup_generation AS query_cleanup_generation,q.ingest_epoch AS query_ingest_epoch,q.provider_user_id,
   qp.user_id IS NOT NULL AS provider_identity_current,(d.retention_cutoff IS NULL OR s.first_at>=d.retention_cutoff) AS retention_eligible,
   NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.from_at<=s.last_at AND t.to_at>s.first_at) AS cleanup_clear,${projectedBills} AS bills
   FROM sessions s JOIN users u ON u.id=s.user_id JOIN session_usage_queries q ON q.session_id=s.id AND q.provider_account=$1
   LEFT JOIN usage_provider_identities qp ON qp.provider_account=q.provider_account AND qp.user_id=q.user_id AND qp.provider_user_id=q.provider_user_id CROSS JOIN data_identity d WHERE s.id=ANY($2::uuid[])`,[fixture.provider_account,staticSessions.slice(i,i+100).map(s=>s.session_id)])).rows;
  for(const row of rows)current.set(row.id,row);
 }
 const billIds=staticSessions.flatMap(s=>s.bills.map(b=>b.id)),claims=(await read(db,`SELECT q.session_id,b->>'id' AS bill_id FROM session_usage_queries q CROSS JOIN LATERAL jsonb_array_elements(q.result->'bills')b
  WHERE q.provider_account=$1 AND q.user_id=ANY($2::uuid[]) AND b->>'id'=ANY($3::text[])`,[fixture.provider_account,owners,billIds])).rows;
 const claimMap=new Map();for(const c of claims){const set=claimMap.get(c.bill_id)??new Set();set.add(c.session_id);claimMap.set(c.bill_id,set);}
 const inputs=staticSessions.map(s=>{const c=current.get(s.session_id),cap=captured.get(s.session_id),fences=Object.fromEntries(STATIC_COMPETITION_FENCES.map(k=>[k,false]));
  if(c&&cap){Object.assign(fences,{hook_key_current:cap.source_generation===0&&c.hook_key===s.initial_hook_key,
   cleanup_generation_current:c.cleanup_generation===s.initial_cleanup_generation&&c.query_cleanup_generation===s.initial_cleanup_generation&&cap.cleanup_generation===s.initial_cleanup_generation,
   ingest_epoch_current:c.ingest_epoch===s.initial_ingest_epoch&&c.query_ingest_epoch===s.initial_ingest_epoch,
   provider_identity_current:c.provider_identity_current&&c.provider_user_id===s.provider_user_id,recovery_clear:header.recovery_id===null&&header.dataset_id===s.dataset_id,
   retention_eligible:c.retention_eligible,cleanup_clear:c.cleanup_clear,history_clear:!cap.history_redacted&&!cap.history_expired&&!c.history_redacted&&!c.history_expired,
   bill_claims_clear:s.bills.every(b=>{const set=claimMap.get(b.id);return set?.size===1&&set.has(s.session_id);})});
   if(JSON.stringify(c.bills)!==JSON.stringify(s.bills.map(({id,basis})=>({id,basis}))))fences.hook_key_current=false;
  }
  return {...s,known_fences:fences};
 });
 const model=assessStaticStopWindowCompetition({staticSessions:inputs,competitorSessions});
 return {...model,snapshot_id:snapshot.id,as_of:snapshot.as_of,scope:'Independent fixed initial window facts plus captured committed-generation Hook bounds and explicitly checked unchanged safety/claim fences. No product safe-bills relation or API quantity supplies expected channel.',competitor_sessions:competitorSessions,static_candidate_count:staticSessions.length};
}
