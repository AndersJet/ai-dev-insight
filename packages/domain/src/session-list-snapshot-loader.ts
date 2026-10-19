import type {Queryable} from '@adi/storage';
import {DomainError} from './errors.js';
import {localUsageDepartmentSql} from './local-usage-department.js';
import {sessionSnapshotReadySql,verifiedLinksSql} from './session-official-usage.js';
import {sessionQueryRowsSql} from './session-usage-query.js';

export interface SessionListSnapshotValue {total_tokens:string|null;model_name:string|null;model_source:string|null}
export interface SessionListSnapshotRecord {department_id:string|null;value:SessionListSnapshotValue}
export interface SessionListSnapshotLegacyRecord extends SessionListSnapshotRecord {business_date:string}
export interface SessionListSnapshotEvent {at_us:number;id:string;department_id:string|null;event_type:string;prompt_excerpt?:string}
export interface SessionListSnapshotSession {
 id:string;source_session_id:string;history_redacted:boolean;history_expired:boolean;source_generation:number;
 events:SessionListSnapshotEvent[];personal_models:string[];has_session_query:boolean;
 query_records:SessionListSnapshotRecord[];legacy_records:SessionListSnapshotLegacyRecord[];
 conflicts:number;pending_days:string[];pending_link:boolean;
}
export interface SessionListSnapshotOwner {user_id:string;name:string;email:string;cleanup_generation:number;sessions:SessionListSnapshotSession[]}

const safeInteger=(value:string|number)=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new DomainError('metric_overflow',503);return n;};
const businessDate=(at:number)=>new Date(Math.floor(at/1000)+28800000).toISOString().slice(0,10);

/** Build one owner's reusable metadata and quantity sources inside the publisher's
 * existing repeatable-read transaction. This function never opens a transaction
 * or publishes data; the publisher owns authorization/cleanup/recovery fences.
 * Ordinary Hook bodies stay in PostgreSQL. Only the existing 160-character
 * first-prompt preview is retained, so full-text searches must query pinned facts.
 */
export async function loadSessionListSnapshotOwner(client:Queryable,account:string|null,owner:string,period:{from:string;to:string},stopWindowEnabled:boolean):Promise<SessionListSnapshotOwner>{
 const header=(await client.query<{user_id:string;name:string;email:string;cleanup_generation:number;pending_days:string[]}>(`
  SELECT u.id AS user_id,u.display_name AS name,u.email_key AS email,u.cleanup_generation,
   ARRAY(SELECT DISTINCT j.payload->>'business_date' FROM jobs j WHERE u.status='active' AND j.kind='usage_sync'
    AND j.payload->>'provider_account'=$1 AND j.payload->>'user_id'=u.id::text AND j.status IN('queued','running')
    AND j.payload->>'business_date'>=(($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text
    AND j.payload->>'business_date'<(($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text
    ORDER BY j.payload->>'business_date') AS pending_days
  FROM users u WHERE u.id=$2`,[account,owner,period.from,period.to])).rows[0];
 if(!header)throw new DomainError('content_changed',409);
 type RawEvent={session_id:string;source_session_id:string;history_redacted:boolean;history_expired:boolean;source_generation:number;id:string;at_us:string;department_id:string|null;event_type:string;prompt_excerpt:string|null};
 const events=(await client.query<RawEvent>(`
  SELECT s.id AS session_id,s.source_session_id,s.history_redacted,s.history_expired,COALESCE(j.generation,0) AS source_generation,
   e.id,(extract(epoch FROM e.occurred_at)*1000000)::bigint::text AS at_us,e.department_id,e.event_type,
   CASE WHEN e.event_type='UserPromptSubmit' THEN left(e.payload->>'prompt',160) END AS prompt_excerpt
  FROM hook_events e JOIN sessions s ON s.id=e.session_id AND s.user_id=e.user_id
  LEFT JOIN jobs j ON j.kind='derive_session' AND j.dedupe_key='derive:'||s.id::text
  WHERE e.user_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
  ORDER BY s.id,e.occurred_at,e.id`,[owner,period.from,period.to])).rows;
 const sessions=new Map<string,SessionListSnapshotSession>();
 for(const event of events){
  let session=sessions.get(event.session_id);
  if(!session){
   session={id:event.session_id,source_session_id:event.source_session_id,history_redacted:event.history_redacted,history_expired:event.history_expired,source_generation:safeInteger(event.source_generation),
    events:[],personal_models:[],has_session_query:false,query_records:[],legacy_records:[],conflicts:0,pending_days:[],pending_link:false};
   sessions.set(session.id,session);
  }
  session.events.push({at_us:safeInteger(event.at_us),id:event.id,department_id:event.department_id,event_type:event.event_type,
   ...(event.prompt_excerpt===null?{}:{prompt_excerpt:event.prompt_excerpt})});
 }
 const ids=[...sessions.keys()];
 if(!ids.length)return {user_id:header.user_id,name:header.name,email:header.email,cleanup_generation:safeInteger(header.cleanup_generation),sessions:[]};
 type RawProperties={id:string;personal_models:string[];has_session_query:boolean;pending_link:boolean};
 const properties=(await client.query<RawProperties>(`WITH pending_links AS MATERIALIZED (
  SELECT DISTINCT j.payload->>'session_id' AS session_id FROM jobs j
  JOIN sessions s ON s.id::text=j.payload->>'session_id' JOIN users u ON u.id=s.user_id AND u.status='active'
  WHERE j.kind='usage_attribution' AND j.payload->>'provider_account'=$1 AND j.status IN('queued','running')
   AND s.user_id=$2 AND s.id=ANY($3::uuid[])
 ) SELECT s.id,COALESCE(p.models,'[]'::jsonb) AS personal_models,l.session_id IS NOT NULL AS pending_link,
  EXISTS(SELECT 1 FROM session_usage_queries q WHERE $4::boolean AND q.provider_account=$1 AND q.session_id=s.id AND q.user_id=s.user_id) AS has_session_query
 FROM sessions s JOIN users u ON u.id=s.user_id
 LEFT JOIN session_personal_models p ON p.session_id=s.id AND p.user_id=u.id AND p.cleanup_generation=u.cleanup_generation
 LEFT JOIN pending_links l ON l.session_id=s.id::text WHERE s.user_id=$2 AND s.id=ANY($3::uuid[])`,[account,owner,ids,stopWindowEnabled])).rows;
 for(const row of properties){
  const session=sessions.get(row.id)!;session.personal_models=row.personal_models;session.has_session_query=row.has_session_query;session.pending_link=row.pending_link;
  const first=businessDate(session.events[0]!.at_us),last=businessDate(session.events.at(-1)!.at_us);
  session.pending_days=header.pending_days.filter(day=>day>=first&&day<=last);
 }
 if(account!==null){
  type RawLegacy={records:(SessionListSnapshotLegacyRecord&{session_id:string})[];conflicts:{session_id:string;count:number}[]};
  const legacy=(await client.query<RawLegacy>(`WITH matched AS MATERIALIZED (
   SELECT id,user_id FROM sessions WHERE user_id=$2 AND id=ANY($3::uuid[])
  ), valid_links AS MATERIALIZED (${verifiedLinksSql('owner')}),
  relevant_links AS MATERIALIZED (SELECT v.* FROM valid_links v JOIN matched m ON m.id=v.session_id AND m.user_id=v.user_id),
  link_map AS MATERIALIZED (
   SELECT min(provider_user_id) AS provider_user_id,COALESCE(jsonb_object_agg(billing_session_id,session_id::text) FILTER(WHERE claims=1),'{}'::jsonb) AS members FROM relevant_links
  ), scopes AS MATERIALIZED (
   SELECT s.*,${sessionSnapshotReadySql} AS ready FROM usage_scopes s
   LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id LEFT JOIN usage_snapshot_runs d ON d.id=s.published_run_id
   WHERE s.provider_account=$1 AND s.user_id=$2
    AND s.business_date>=($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND s.business_date<($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
  ), records AS (
   SELECT (m.members->>(o.value->>'billing_session_id'))::uuid AS session_id,s.business_date::text AS business_date,allocation.department_id,
    jsonb_build_object('total_tokens',o.value->'usage'->>'total_tokens','model_name',NULLIF(o.value->>'model_name',''),'model_source',o.value->>'model_source') AS value
   FROM scopes s CROSS JOIN link_map m JOIN usage_observations o ON o.run_id=s.published_run_id
   JOIN usage_snapshot_parts p ON p.run_id=o.run_id AND p.part=o.part LEFT JOIN LATERAL (${localUsageDepartmentSql}) allocation ON true
   WHERE s.ready AND m.members ? (o.value->>'billing_session_id') AND o.value->>'provider_user_id'=m.provider_user_id
    AND o.value->>'scene'='Chat' AND COALESCE(o.value->>'client','') IN('','ide')
  ) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM records r),'[]'::jsonb) AS records,
   COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM (SELECT session_id,count(*) FILTER(WHERE claims>1)::integer AS count FROM relevant_links GROUP BY session_id) c),'[]'::jsonb) AS conflicts`,[account,owner,ids,period.from,period.to])).rows[0]!;
  for(const {session_id,...record} of legacy.records)sessions.get(session_id)!.legacy_records.push(record);
  for(const row of legacy.conflicts)sessions.get(row.session_id)!.conflicts=safeInteger(row.count);
  if(stopWindowEnabled){
   type RawQuery=SessionListSnapshotRecord&{session_id:string};
   const queryRecords=(await client.query<RawQuery>(`WITH matched AS MATERIALIZED (
    SELECT id,user_id FROM sessions WHERE user_id=$2 AND id=ANY($3::uuid[])
   ) SELECT q.session_id,q.department_id,
    jsonb_build_object('total_tokens',q.value->'usage'->>'total_tokens','model_name',NULLIF(q.value->>'model_name',''),'model_source',q.value->>'model_source') AS value
   FROM (${sessionQueryRowsSql('$1','true')}) q`,[account,owner,ids])).rows;
   for(const {session_id,...record} of queryRecords)sessions.get(session_id)!.query_records.push(record);
  }
 }
 return {user_id:header.user_id,name:header.name,email:header.email,cleanup_generation:safeInteger(header.cleanup_generation),sessions:[...sessions.values()]};
}
