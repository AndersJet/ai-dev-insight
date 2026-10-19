import {randomBytes,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {capacityDatabase} from './session-list-capacity-fixture.mjs';
import {syntheticPayloadEvent} from './session-list-capacity-events.mjs';

export async function readCapacityDiagnostic(db,statement,values=[]){
 return db.transaction(async sql=>{
  await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  await sql.query('SET LOCAL jit=off');
  return sql.query(statement,values);
 });
}

export async function readReadyCapacityStops(db,clientEvents,providerAccount){
 const wanted=JSON.stringify(clientEvents.map(stop=>({installation_id:stop.installation,client_event_id:stop.client_event_id})));
 return (await readCapacityDiagnostic(db,`WITH wanted AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb) x(installation_id uuid,client_event_id text)
 ), candidates AS MATERIALIZED (
  SELECT k.client_event_id,e.received_at,e.capture_generation,s.id,s.user_id,s.source_session_id,q.observed_at,q.hook_key,r.source_generation,r.computed_at AS derived_at,r.cleanup_generation AS derived_cleanup,u.cleanup_generation AS current_cleanup
  FROM wanted JOIN event_keys k ON k.installation_id=wanted.installation_id AND k.client_event_id=wanted.client_event_id
  JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at JOIN sessions s ON s.id=e.session_id
  JOIN users u ON u.id=s.user_id LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.state='published'
  LEFT JOIN session_usage_queries q ON q.session_id=s.id AND q.provider_account=$2
 ), ready AS MATERIALIZED (
  SELECT * FROM candidates WHERE derived_at IS NOT NULL AND source_generation>=capture_generation AND derived_cleanup=current_cleanup AND observed_at IS NOT NULL
 ), fingerprints AS MATERIALIZED (
  SELECT s.id,md5(jsonb_build_array(s.first_at,s.last_at,s.history_redacted,s.history_expired,COALESCE((SELECT jsonb_agg(jsonb_build_array(h.id,h.occurred_at,h.capture_generation) ORDER BY h.occurred_at,h.id) FROM hook_events h WHERE h.session_id=s.id),'[]'::jsonb))::text) AS current_key
  FROM sessions s JOIN (SELECT DISTINCT id FROM ready) selected ON selected.id=s.id
 ) SELECT candidates.*,fingerprints.current_key,COALESCE(candidates.derived_at IS NOT NULL AND candidates.source_generation>=candidates.capture_generation AND candidates.derived_cleanup=candidates.current_cleanup AND candidates.observed_at IS NOT NULL,false) AS derived_ready
 FROM candidates LEFT JOIN fingerprints ON fingerprints.id=candidates.id`,[wanted,providerAccount])).rows;
}

export function capacityReadyStopGroups(rows,stops){
 const byClient=new Map(stops.map(stop=>[stop.client_event_id,stop])),groups=new Map();
 for(const row of rows){
  const stop=byClient.get(row.client_event_id);if(!stop)throw new Error('unknown_capacity_stop');
  Object.assign(stop,{received_at:row.received_at.toISOString(),capture_generation:row.capture_generation,source_generation:row.source_generation,derived_at:row.derived_at?.toISOString()??null,published_at:row.observed_at?.toISOString()??null});
  if(!row.derived_ready||!row.derived_at||row.source_generation<row.capture_generation||row.derived_cleanup!==row.current_cleanup||!row.observed_at||!row.current_key||row.hook_key!==row.current_key)continue;
  const group=groups.get(row.id)??[];group.push({row,stop});groups.set(row.id,group);
 }
 return groups;
}
export function maximumCapacityStop(group,source){return {at:new Date(Math.max(...group.map(s=>Date.parse(s.stop.at)))).toISOString(),received_at:new Date(Math.max(...group.map(s=>s.row.received_at.getTime()))).toISOString(),capture_generation:Math.max(...group.map(s=>s.row.capture_generation)),expected_records:source.expected_records,expected_channel:source.expected_channel};}
export function assessCapacityFreshResponse(result,source,id,expectedTokens,userId,stop){
 const row=Array.isArray(result.data?.items)?result.data.items.find(i=>i.id===id&&i.user_id===userId&&i.source_session_id===source):undefined;
 const visible=!!row&&Date.parse(row.last_at)>=Date.parse(stop.at)&&Date.parse(result.data?.snapshot?.as_of??'')>=Date.parse(stop.received_at);
 return {correct:result.code==='ok'&&visible&&row?.official_tokens===expectedTokens&&row?.official_records===stop.expected_records&&row?.channel===stop.expected_channel,tokens:row?.official_tokens??null,records:row?.official_records??null,channel:row?.channel??null,snapshot:result.data?.snapshot??null,row_last_at:row?.last_at??null,code:result.code==='ok'?'quantities_records_channel_or_snapshot_not_ready':result.code};
}
export const capacityStopWithinDeadline=sample=>sample.elapsed_ms<=60000&&sample.derived_ready_ms<=60000;


/** Whole-plan PK count; one fixed MVCC view and unchanged per-query deadlines. */
export async function countPlannedCapacityFacts(db,assignments,planned,prefix,providerAccount){
 return db.transaction(async client=>{
     await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query('SET LOCAL jit=off');
     // Include every scheduled identity, including packets that never reached
     // admission or persistence. The generator uses exactly these group/person
     // assignments; no observed Stop/source/session can shrink this set.
     const wanted=Array.from({length:planned},(_,n)=>({installation:assignments[Math.floor(n/20)].person.installation,client_event_id:prefix+'-event-'+n}));
     const total={events:0,event_keys:0,missing_hooks:0,stops:0,published:0};
     for(let i=0;i<wanted.length;i+=500){const row=(await client.query(`WITH wanted AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($1::jsonb) x(installation uuid,client_event_id text))
      SELECT count(k.event_id)::int event_keys,count(e.id)::int events,count(e.id) FILTER(WHERE e.event_type='Stop')::int stops,count(k.event_id) FILTER(WHERE e.id IS NULL)::int missing_hooks
      FROM wanted w LEFT JOIN event_keys k ON k.installation_id=w.installation AND k.client_event_id=w.client_event_id
      LEFT JOIN LATERAL(SELECT id,event_type FROM hook_events WHERE id=k.event_id AND occurred_at=k.occurred_at OFFSET 0)e ON true`,[JSON.stringify(wanted.slice(i,i+500))])).rows[0];
      for(const key of ['events','event_keys','missing_hooks','stops'])total[key]+=row[key];
     }
     const plannedNames=[...new Map(assignments.map(a=>[JSON.stringify([a.person.user_id,a.source_session_id]),{user_id:a.person.user_id,source_session_id:a.source_session_id}])).values()];
     for(let i=0;i<plannedNames.length;i+=500){const row=(await client.query(`WITH wanted AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($1::jsonb) x(user_id uuid,source_session_id text))
      SELECT count(q.session_id)::int published FROM wanted w
      LEFT JOIN LATERAL(SELECT id FROM sessions WHERE user_id=w.user_id AND source_session_id=w.source_session_id OFFSET 0)s ON true
      LEFT JOIN session_usage_queries q ON q.session_id=s.id AND q.provider_account=$2`,[JSON.stringify(plannedNames.slice(i,i+500)),providerAccount])).rows[0];total.published+=row.published;
     }
     return total;
 });
}

/** Open-loop synthetic events: every scheduled event is retained and reported.
 * HTTP ACK, persistence, actual source publication and readable quantities are
 * separate measurements. Slow delivery never reduces the scheduled workload. */
export function startMixedTraffic(fixture,durationMs,readFresh){
 const db=capacityDatabase(fixture.schema),prefix='synthetic-live-'+randomUUID();
 const continuationUsers=new Set(fixture.long_sessions.map(s=>s.user_id)),newSourcePeople=fixture.people.filter(p=>!continuationUsers.has(p.user_id));
 const burstMs=Math.min(60000,Math.floor(durationMs/3)),burstAt=Math.min(600000,Math.floor(durationMs/3));
 const before=Math.floor(burstAt/1000*10),during=Math.floor(burstMs/1000*50),after=Math.floor((durationMs-burstAt-burstMs)/1000*10),planned=before+during+after;
 const assignments=Array.from({length:Math.ceil(planned/20)},(_,group)=>{
  const continuation=group%100===0?fixture.long_sessions[Math.floor(group/100)%fixture.long_sessions.length]:null;
  const person=continuation?fixture.people.find(p=>p.user_id===continuation.user_id):newSourcePeople[group%newSourcePeople.length];
  return {continuation,person,source_session_id:continuation?.source_session_id??prefix+'-'+group};
 });
 const stats={planned_events:planned,sent:0,http_ack:0,http_failures:0,http_errors:{},max_schedule_lag_ms:0,peak_http_active:0,source_sessions:0,new_source_sessions:0,stop_events:0,persisted_events:null,persisted_stops:null,published_queries:null,readable_queries:0,freshness:[],freshness_errors:[],finalization_errors:[],sources:[],distribution:{new_source_users:newSourcePeople.length,continuation_users:continuationUsers.size,continuation_every_groups:100,scope:'New sources rotate through ordinary users; heavy users receive real long-history continuations. Live Stop windows therefore do not create unplanned cross-session ambiguity with a later continuation; dedicated PostgreSQL regressions verify actual competing claims.'},rates:{steady_eps:10,burst_eps:50,burst_at_ms:burstAt,burst_ms:burstMs,duration_ms:durationMs},prefix};
 stats.observer_scope='Published derivation generation and current cleanup are checked before calculating one Hook fingerprint per session. One actual API response with maximum eligible Stop time/receive time proves every individually recorded eligible Stop; limits, source generations and start times are unchanged.';
 stats.observer_source_groups=0;
 const stops=[],inFlight=new Set();let generated=false,monitorStopping=false;
 const start=performance.now();
 const generator=(async()=>{
  for(let n=0;n<planned;n++){
   const offset=n<before?n*100:n<before+during?burstAt+(n-before)*20:burstAt+burstMs+(n-before-during)*100;
   if(performance.now()-start<offset)await delay(offset-(performance.now()-start));
   stats.max_schedule_lag_ms=Math.max(stats.max_schedule_lag_ms,performance.now()-start-offset);
   const group=Math.floor(n/20),step=n%20,groupEvents=Math.min(20,planned-group*20),{continuation,person,source_session_id}=assignments[group];
   const bytes=n%1000===0?524288:n%100<1?65536:n%10===0?8192:1024;
   const content=randomBytes(Math.ceil(bytes*.75)).toString('base64').slice(0,bytes),at=new Date().toISOString(),client_event_id=prefix+'-event-'+n;
   const {event_type,payload}=groupEvents>=5?syntheticPayloadEvent(step,groupEvents,content,prefix+'-'+group):{event_type:step===0?'SessionStart':'Notification',payload:step===0?{context:content}:{message:content}};
   const value={schema_version:2,installation_id:person.installation,client_event_id,occurred_at:at,event_type,source_session_id,payload};
   if(step===0){stats.source_sessions++;if(!continuation)stats.new_source_sessions++;const initial=continuation?fixture.item_oracle[continuation.id]:null,records=Number(initial?.official_records??0)+8;stats.sources.push({source_session_id,user_id:person.user_id,department:person.department,continuation:!!continuation,initial_events:continuation?.initial_events??0,session_id:continuation?.id??null,scheduled_events:groupEvents,has_stop:groupEvents>=5,expected_tokens:String(records*100),expected_records:records,expected_channel:['custom','mixed'].includes(initial?.channel)?'mixed':'official'});}
   if(event_type==='Stop'){stats.stop_events++;stops.push({source_session_id,client_event_id,installation:person.installation,at,expected_tokens:stats.sources.at(-1).expected_tokens,received_at:null,published_at:null,observed:false});}
   stats.sent++;
   const task=(async()=>{try{
    const response=await globalThis.fetch('http://127.0.0.1:4189/hooks',{method:'POST',headers:{authorization:'Bearer '+person.token,'content-type':'application/json'},body:JSON.stringify(value),signal:globalThis.AbortSignal.timeout(15000)});
    const body=await response.text();if(response.status===200&&body==='')stats.http_ack++;else{stats.http_failures++;const key='http_'+response.status;stats.http_errors[key]=(stats.http_errors[key]??0)+1;}
   }catch(error){stats.http_failures++;stats.http_errors[error.name]=(stats.http_errors[error.name]??0)+1;}})();
   inFlight.add(task);stats.peak_http_active=Math.max(stats.peak_http_active,inFlight.size);task.finally(()=>inFlight.delete(task));
   if(inFlight.size>500){stats.http_errors.generator_backpressure=(stats.http_errors.generator_backpressure??0)+1;await Promise.race(inFlight);}
  }
  await Promise.all(inFlight);generated=true;
 })().catch(error=>{stats.finalization_errors.push({stage:'generator',code:error.code??error.name,at:new Date().toISOString()});generated=true;});
 const monitor=(async()=>{while(!monitorStopping){
  try{
   const pending=stops.filter(s=>!s.observed);
   if(pending.length){
    const rows=await readReadyCapacityStops(db,pending,fixture.provider_account),groups=capacityReadyStopGroups(rows,stops);
    for(const group of groups.values()){
     if(monitorStopping)break;
     stats.observer_source_groups++;const row=group[0].row;if(row.hook_key!==row.current_key)continue;
     const source=stats.sources.find(s=>s.source_session_id===row.source_session_id),probe=maximumCapacityStop(group,source);
     const read=await readFresh(row.source_session_id,row.id,source.expected_tokens,row.user_id,probe);
     if(read.correct){const observedAt=new Date();for(const {row,stop:s} of group){s.observed=true;const elapsed=observedAt.getTime()-row.received_at.getTime(),derivedMs=row.derived_at.getTime()-row.received_at.getTime();stats.freshness.push({client_event_id:s.client_event_id,source_session_id:s.source_session_id,received_at:s.received_at,published_at:s.published_at,capture_generation:row.capture_generation,source_generation:row.source_generation,derived_at:row.derived_at.toISOString(),derived_ready_ms:derivedMs,hook_key:row.hook_key,current_key:row.current_key,snapshot:read.snapshot??null,row_last_at:read.row_last_at??null,readable_at:observedAt.toISOString(),elapsed_ms:elapsed,official_list_ready_ms:elapsed,official_tokens:read.tokens,official_records:read.records,channel:read.channel});}}
     else stats.freshness_errors.push({source_session_id:row.source_session_id,client_event_ids:group.map(s=>s.row.client_event_id),code:read.code,at:new Date().toISOString()});
    }
   }
  }catch(error){stats.freshness_errors.push({code:error.code??error.name,at:new Date().toISOString()});}
  if(generated&&stops.every(s=>s.observed))break;
  await delay(1000);
 }})();
 return {
  snapshot:()=>({...stats,stop_observations:stops.map(s=>({...s})),freshness_samples:stats.freshness.length}),
  async finish(){
   let states=[],continuations=[];
   const failure=(stage,error)=>stats.finalization_errors.push({stage,code:error.code??error.name,at:new Date().toISOString()});
   try{
    await generator;const deadline=Date.now()+65000;
    while(stops.some(s=>!s.observed)&&Date.now()<deadline)await delay(1000);
    monitorStopping=true;await monitor;
    const names=stats.sources.map(s=>s.source_session_id);
    try{const counts=await countPlannedCapacityFacts(db,assignments,planned,prefix,fixture.provider_account);
     stats.persisted_events=counts.events;stats.persisted_stops=counts.stops;stats.published_queries=counts.published;
     stats.persisted_event_keys=counts.event_keys;stats.event_keys_without_hook=counts.missing_hooks;
     stats.final_count_scope='All scheduled (installation,client_event_id) identities and all planned (user,source) identities; bounded 500-row PK batches in one repeatable-read read-only JIT-off transaction. q count is existing rows, not observed Stops or proven new tasks.';
    }catch(error){failure('counts',error);}
    try{states=(await readCapacityDiagnostic(db,`SELECT j.kind,j.status,j.error_code,count(*)::int jobs FROM jobs j JOIN sessions s ON s.id::text=j.payload->>'session_id' WHERE s.source_session_id=ANY($1::text[]) GROUP BY 1,2,3`,[names])).rows;}catch(error){failure('jobs',error);}
    try{continuations=(await readCapacityDiagnostic(db,`SELECT s.id,s.source_session_id,r.source_generation,r.checkpoint->>'processed' AS processed,r.state,r.summary,(SELECT count(*)::int FROM hook_events e WHERE e.session_id=s.id) AS expected_events FROM sessions s LEFT JOIN session_derivations r ON r.id=s.derived_run_id WHERE s.source_session_id=ANY($1::text[])`,[stats.sources.filter(s=>s.continuation).map(s=>s.source_session_id)])).rows;}catch(error){failure('continuations',error);}
   }catch(error){failure('finish',error);}finally{monitorStopping=true;await monitor.catch(error=>failure('monitor',error));await db.close().catch(error=>failure('database_close',error));}
   stats.readable_queries=stops.filter(s=>s.observed).length;stats.observed_stop_count=stats.readable_queries;stats.published_query_rows=stats.published_queries;
   stats.stop_observations=stops.map(s=>({...s}));
   const missing=stops.filter(s=>!s.observed).map(s=>({...s}));
   return {...stats,job_states:states,continuations,missing,pass:stats.finalization_errors.length===0&&!stats.freshness_errors.some(e=>['57014','database_io_timeout','database_unavailable'].includes(e.code))&&stats.sent===planned&&stats.http_ack===planned&&stats.http_failures===0&&stats.persisted_events===planned&&stats.event_keys_without_hook===0&&stats.persisted_stops===stats.stop_events&&stats.readable_queries===stats.stop_events&&stats.freshness.every(capacityStopWithinDeadline)&&states.every(s=>s.status==='succeeded'&&s.error_code===null)&&continuations.every(s=>s.state==='published'&&Number(s.processed)===s.expected_events&&s.summary?.event_count===s.expected_events),scope:'Every scheduled Hook, every Stop real derived source-generation publication and every corresponding current API quantity. Freshness starts at service receive time, conservatively including persistence queue time and the first full historical continuation derivation; immutable raw freshness samples retained. Diagnostics use read-only transactions with JIT disabled and unchanged database deadlines; failures remain explicit.'};
  },
 };
}
