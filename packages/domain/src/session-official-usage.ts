import { officialTokenBreakdownSql, officialTokenBreakdown, type RawTokenBreakdown } from './official-token-breakdown.js';
import type {SessionOfficialUsageDto} from '@adi/contracts';
import {readSessionQuery,sessionQueryRowsSql} from './session-usage-query.js';
import { localUsageDepartmentSql } from './local-usage-department.js';
import {emptyTimeCandidates,timeCandidateCtes,timeCandidateResultSql,type SessionTimeCandidates} from './session-time-candidates.js';
import { officialAmountReasonsSql, amountMissingReasons, type RawAmountMissingReasons } from './official-amount-reasons.js';
import type { Database } from '@adi/storage';
import { DomainError } from './errors.js';
import type { OfficialUsageSummary } from './official-usage.js';


/** History reads share evidence identity and cleanup rules, but keep each
 * projection's authenticated history gate and map shape. Count claims before
 * filtering to the requested/matched sessions, including out-of-page conflicts.
 */
export function verifiedLinksSql(projection: 'list' | 'detail' | 'owner') {
 if(projection==='owner')return `SELECT e.*,count(*) OVER(PARTITION BY e.billing_session_id) AS claims
  FROM usage_attribution_evidence e JOIN users u ON u.id=e.user_id
  JOIN usage_provider_identities i ON i.user_id=e.user_id AND i.provider_account=e.provider_account AND i.provider_user_id=e.provider_user_id
  WHERE e.provider_account=$1 AND e.user_id=$2 AND e.cleanup_generation=u.cleanup_generation`;
 const list = projection === 'list';
 return `SELECT ${list ? 'e.user_id,e.session_id,e.billing_session_id,e.provider_user_id' : 'e.*'},count(*) OVER(PARTITION BY ${list ? 'e.user_id,' : ''}e.billing_session_id) AS claims
  FROM usage_attribution_evidence e ${list ? 'JOIN owners o ON o.user_id=e.user_id ' : ''}JOIN users u ON u.id=e.user_id
  JOIN usage_provider_identities i ON i.user_id=e.user_id AND i.provider_account=e.provider_account AND i.provider_user_id=e.provider_user_id
  WHERE ${list ? '$12::boolean AND e.provider_account=$10' : 'e.provider_account=$1 AND e.user_id=$3'} AND e.cleanup_generation=u.cleanup_generation
   AND ${list ? '($13::uuid=u.id OR $14::boolean)' : "((u.status='active' AND e.ingest_epoch=u.ingest_epoch) OR ($6::uuid=u.id OR $7::boolean))"}`;
}

// Both session projections keep their existing snapshot validity semantics.
// The separate immediate retention fence in the person-day summary is not
// imported here; cutoff behavior is characterized in integration tests.
export const sessionSnapshotReadySql = `COALESCE(v.data_run_id=s.published_run_id AND v.state IN('published','unchanged') AND d.state='published'
   AND v.content_hash LIKE 'scope-v2:%' AND d.content_hash LIKE 'scope-v2:%'
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.generation>v.cleanup_generation AND t.from_at<to_timestamp(v.to_second+1) AND t.to_at>to_timestamp(v.from_second)),false)`;

type Group=OfficialUsageSummary['groups'][number]&{model_name:string|null};
// Neither a successful Hook probe nor verified person-days enumerate every
// bill belonging to a session. Keep this separate from known-link matching.
export const unknownSessionCoverage=()=>({state:'unknown' as const,reason:'billing_id_inventory_unavailable' as const});
export function emptySessionOfficialUsage():Omit<SessionOfficialUsageDto,'period'>{
 return {configured:false,source:'trae_openapi' as const,settlement:'unverified' as const,groups:[] as Group[],
  session_coverage:unknownSessionCoverage(),time_candidates:emptyTimeCandidates(),
  attribution:{state:'unlinked' as 'unlinked'|'linked'|'partial'|'conflict',linked_ids:0,conflicting_ids:0,unmatched_ids:0,evidence:'single_hook_query' as const,probe_state:'not_queried' as string,pending:false,requested_at:null as string|null,probe_revision:null as number|null,observed_at:null as string|null},
  coverage:{revision:null as string|null,expected_days:0,verified_days:0,missing_days:0,invalidated_days:0,oldest_verified_at:null as string|null,query_through_at:null as string|null}};
}
const count=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new DomainError('metric_overflow',503);return n;};
export async function querySessionOfficialUsage(db:Database,account:string,sessionId:string,userId:string,period:{from:string;to:string},historyReader:{userId:string;super:boolean},stopWindowEnabled=false){
 // This is the authenticated history-read path, never the worker evidence
 // reader or publisher. The caller supplies its freshly resolved identity;
 // account suspension revokes login/new probes, not already-authorized history.
 if(historyReader.userId!==userId&&!historyReader.super)throw new DomainError('not_found',404);
 const begin=Date.parse(period.from),end=Date.parse(period.to);if((begin+28800000)%86400000||(end+28800000)%86400000)throw new DomainError('official_period_precision',422);
 const fenceSql=`SELECT u.cleanup_generation,u.ingest_epoch,u.status,p.provider_user_id,COALESCE(r.revision,0)::text AS revision FROM users u
  LEFT JOIN usage_provider_identities p ON p.user_id=u.id AND p.provider_account=$1 LEFT JOIN usage_attribution_revisions r ON r.user_id=u.id AND r.provider_account=$1 WHERE u.id=$2`;
 const before=JSON.stringify((await db.query(fenceSql,[account,userId])).rows[0]);
 // At most 5,000 evidence keys belong to one session. Materialize their unique
 // owner lookup once: a row-by-row join can otherwise rescan the CTE thousands
 // of times when PostgreSQL underestimates the filtered window-function rows.
 const sql=`WITH valid_links AS MATERIALIZED (
  ${verifiedLinksSql('detail')}
 ), links AS MATERIALIZED (SELECT * FROM valid_links WHERE session_id=$2),
 link_map AS (SELECT COALESCE(jsonb_object_agg(billing_session_id,provider_user_id) FILTER(WHERE claims=1),'{}'::jsonb) AS members FROM links),
 scopes AS MATERIALIZED (
  SELECT s.*,v.to_second,${sessionSnapshotReadySql} AS ready
  FROM usage_scopes s LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id LEFT JOIN usage_snapshot_runs d ON d.id=s.published_run_id
  WHERE s.provider_account=$1 AND s.user_id=$3 AND s.business_date>=($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND s.business_date<($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
 ), records AS MATERIALIZED (
  SELECT s.business_date,o.value,o.value->>'billing_session_id' AS billing_session_id,
   CASE WHEN o.value->>'client'='ide' THEN 'ide' ELSE 'unspecified' END AS client,
   CASE WHEN o.value->>'model_source' IN('Trae','Custom') THEN o.value->>'model_source' ELSE 'unknown' END AS model_source,
   CASE WHEN o.value->>'consumption_source' IN('basic','pay_go','mixed','enterprise_builtin') THEN o.value->>'consumption_source' ELSE 'unknown' END AS consumption_source
  FROM scopes s JOIN usage_observations o ON o.run_id=s.published_run_id
  WHERE s.ready AND o.value->>'scene'='Chat' AND COALESCE(o.value->>'client','') IN('','ide')
   AND (SELECT members FROM link_map)->>(o.value->>'billing_session_id')=o.value->>'provider_user_id'
 ), expected AS (
  SELECT g::date AS day FROM sessions s CROSS JOIN LATERAL generate_series(
   GREATEST((s.first_at AT TIME ZONE 'Asia/Shanghai')::date,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date),
   LEAST((s.last_at AT TIME ZONE 'Asia/Shanghai')::date,($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-1),interval '1 day') g WHERE s.id=$2
  UNION SELECT business_date FROM records
 ), coverage AS (
  SELECT count(*)::text AS expected_days,count(*) FILTER(WHERE s.ready)::text AS verified_days,
   count(*) FILTER(WHERE NOT s.ready AND s.published_run_id IS NOT NULL)::text AS invalidated_days,
   min(s.last_verified_at) FILTER(WHERE s.ready) AS oldest_verified_at,to_timestamp(max(s.to_second) FILTER(WHERE s.ready)+1) AS query_through_at
  FROM expected e LEFT JOIN scopes s ON s.business_date=e.day
 ), ${timeCandidateCtes}, grouped AS (
  SELECT NULLIF(value->>'model_name','') AS model_name,client,model_source,consumption_source,NULLIF(value->>'currency','') AS currency,count(*)::text AS records,
   COALESCE(sum((value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens,${officialTokenBreakdownSql},
   COALESCE(sum((value->>'model_call_count')::numeric),0)::text AS known_calls,count(*) FILTER(WHERE value->>'model_call_count' IS NULL)::text AS missing_calls,
   sum((value->>'amount')::numeric)::text AS known_amount,count(*) FILTER(WHERE value->>'amount' IS NULL OR NULLIF(value->>'currency','') IS NULL)::text AS missing_amount,
   ${officialAmountReasonsSql},
   count(*) FILTER(WHERE jsonb_array_length(COALESCE(value->'quality','[]'::jsonb))>0)::text AS quality_records
  FROM records GROUP BY NULLIF(value->>'model_name',''),client,model_source,consumption_source,NULLIF(value->>'currency','')
 ) SELECT ${timeCandidateResultSql} AS time_candidates,(SELECT row_to_json(coverage) FROM coverage) AS coverage,
  (SELECT json_build_object('probe_state',a.probe_state,'observed_at',a.observed_at,'requested_at',a.requested_at,'revision',a.generation)
   FROM usage_attribution_subjects a WHERE a.provider_account=$1 AND a.session_id=$2) AS probe,
  EXISTS(SELECT 1 FROM jobs j JOIN users u ON u.id=$3 AND u.status='active' WHERE j.dedupe_key='usage-link:'||$1||':'||$2::text AND j.kind='usage_attribution' AND j.payload->>'provider_account'=$1 AND j.payload->>'session_id'=$2::text AND j.status IN('queued','running')) AS pending,
  (SELECT md5(COALESCE(string_agg(id::text||':'||revision::text||':'||ready::text,',' ORDER BY id),'')) FROM scopes) AS source_revision,
  (SELECT count(*)::text FROM links WHERE claims=1) AS linked,(SELECT count(*)::text FROM links WHERE claims>1) AS conflicting,
  (SELECT count(DISTINCT billing_session_id)::text FROM records) AS matched,
  COALESCE((SELECT jsonb_agg(g ORDER BY model_name,model_source,consumption_source,currency,client) FROM (SELECT * FROM grouped ORDER BY model_name,model_source,consumption_source,currency,client LIMIT 201) g),'[]'::jsonb) AS groups`;
 type RawGroup=RawTokenBreakdown&Pick<Group,'model_name'|'client'|'model_source'|'consumption_source'|'currency'>&{records:string;known_tokens:string;missing_tokens:string;known_calls:string;missing_calls:string;known_amount:string|null;missing_amount:string;amount_missing_reasons:RawAmountMissingReasons;quality_records:string};
 const result=(await db.query<{time_candidates:SessionTimeCandidates;coverage:{expected_days:string;verified_days:string;invalidated_days:string;oldest_verified_at:string|null;query_through_at:string|null};probe:{probe_state:string;observed_at:string|null;requested_at:string;revision:number}|null;pending:boolean;source_revision:string;linked:string;conflicting:string;matched:string;groups:RawGroup[]}>(sql,[account,sessionId,userId,period.from,period.to,historyReader.userId,historyReader.super])).rows[0]!;
 if(result.groups.length>200)throw new DomainError('metric_overflow',503);
 const sessionQuery=stopWindowEnabled?await readSessionQuery(db,account,sessionId,userId,historyReader):null;
 if(JSON.stringify((await db.query(fenceSql,[account,userId])).rows[0])!==before)throw new DomainError('content_changed',409);
 const linked=count(result.linked),conflicting=count(result.conflicting),unmatched=linked-count(result.matched),expected=count(result.coverage.expected_days),verified=count(result.coverage.verified_days);
 return {...emptySessionOfficialUsage(),configured:true,time_candidates:result.time_candidates,
  attribution:{state:conflicting?(linked?'partial':'conflict') as 'partial'|'conflict':!linked?'unlinked' as const:unmatched?'partial' as const:'linked' as const,linked_ids:linked,conflicting_ids:conflicting,unmatched_ids:unmatched,evidence:'single_hook_query' as const,probe_state:result.probe?.probe_state??'not_queried',pending:result.pending,requested_at:result.probe?new Date(result.probe.requested_at).toISOString():null,probe_revision:result.probe?.revision??null,observed_at:result.probe?.observed_at??null},
  coverage:{revision:result.source_revision,expected_days:expected,verified_days:verified,missing_days:expected-verified,invalidated_days:count(result.coverage.invalidated_days),oldest_verified_at:result.coverage.oldest_verified_at,query_through_at:result.coverage.query_through_at},
  ...(sessionQuery?{session_query:{state:sessionQuery.state,reasons:sessionQuery.reasons,observed_at:sessionQuery.observed_at,billing_ids:sessionQuery.billing_ids,revision:sessionQuery.revision}}:{}),
  groups:sessionQuery?sessionQuery.groups:result.groups.map(row=>({token_breakdown:officialTokenBreakdown(row),model_name:row.model_name,scene:'Chat' as const,client:row.client,model_source:row.model_source,consumption_source:row.consumption_source,currency:row.currency,records:count(row.records),tokens:row.missing_tokens==='0'?row.known_tokens:null,known_tokens:row.known_tokens,missing_token_records:count(row.missing_tokens),calls:row.missing_calls==='0'?row.known_calls:null,known_calls:row.known_calls,missing_call_records:count(row.missing_calls),amount:row.missing_amount==='0'&&row.currency?row.known_amount:null,known_amount:row.currency?row.known_amount:null,unknown_amount_records:count(row.missing_amount),amount_missing_reasons:amountMissingReasons(row.amount_missing_reasons),quality_records:count(row.quality_records)}))};
}

const sessionListSourcesSql=`owners AS MATERIALIZED (SELECT DISTINCT user_id FROM matched),
 valid_links AS MATERIALIZED (
  ${verifiedLinksSql('list')}
 ), relevant_links AS MATERIALIZED (SELECT v.* FROM valid_links v JOIN matched m ON m.id=v.session_id),
 link_maps AS MATERIALIZED (
  SELECT user_id,min(provider_user_id) AS provider_user_id,COALESCE(jsonb_object_agg(billing_session_id,session_id::text) FILTER(WHERE claims=1),'{}'::jsonb) AS members FROM relevant_links GROUP BY user_id
 ), conflicts AS (SELECT session_id,count(*) FILTER(WHERE claims>1)::integer AS count FROM relevant_links GROUP BY session_id),
 scopes AS MATERIALIZED (
  SELECT s.*,${sessionSnapshotReadySql} AS ready
  FROM usage_scopes s JOIN owners o ON o.user_id=s.user_id LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id LEFT JOIN usage_snapshot_runs d ON d.id=s.published_run_id
  WHERE $12::boolean AND s.provider_account=$10 AND s.business_date>=($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND s.business_date<($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
 ), allocated_records AS MATERIALIZED (
  SELECT (m.members->>(o.value->>'billing_session_id'))::uuid AS session_id,o.value,allocation.department_id
  FROM scopes s JOIN link_maps m ON m.user_id=s.user_id JOIN usage_observations o ON o.run_id=s.published_run_id
  JOIN usage_snapshot_parts p ON p.run_id=o.run_id AND p.part=o.part
  LEFT JOIN LATERAL (${localUsageDepartmentSql}) allocation ON true
  WHERE s.ready AND m.members ? (o.value->>'billing_session_id') AND o.value->>'provider_user_id'=m.provider_user_id
   AND o.value->>'scene'='Chat' AND COALESCE(o.value->>'client','') IN('','ide')
 ), session_queries AS MATERIALIZED (SELECT q.session_id FROM session_usage_queries q JOIN matched m ON m.id=q.session_id WHERE $12::boolean AND $15::boolean AND q.provider_account=$10),
 query_records AS MATERIALIZED (
  ${sessionQueryRowsSql('$10','($13::uuid=qu.id OR $14::boolean)')} AND $12::boolean AND $15::boolean AND q.session_id IN(SELECT id FROM matched)
 ), records AS MATERIALIZED (
  SELECT session_id,value FROM allocated_records WHERE ($4::uuid IS NULL OR department_id=$4) AND session_id NOT IN(SELECT session_id FROM session_queries)
  UNION ALL SELECT session_id,value FROM query_records WHERE $4::uuid IS NULL OR department_id=$4
 ), unassigned AS (
  SELECT session_id,count(*)::integer AS records FROM (SELECT session_id FROM allocated_records WHERE department_id IS NULL AND session_id NOT IN(SELECT session_id FROM session_queries) UNION ALL SELECT session_id FROM query_records WHERE department_id IS NULL) unallocated GROUP BY session_id
 ), official AS (
  SELECT session_id,count(*)::integer AS records,
   CASE WHEN count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)=0 THEN sum((value->'usage'->>'total_tokens')::numeric)::text END AS tokens,
   count(DISTINCT jsonb_build_array(value->>'model_source',value->>'model_name')) FILTER(WHERE NULLIF(value->>'model_name','') IS NOT NULL)::integer AS model_count,
   min(NULLIF(value->>'model_name','')) AS model FROM records GROUP BY session_id
 ), pending_days AS (
  SELECT DISTINCT m.id AS session_id FROM matched m JOIN jobs j ON j.payload->>'user_id'=m.user_id::text JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE $12::boolean AND j.kind='usage_sync' AND j.payload->>'provider_account'=$10 AND j.status IN('queued','running')
   AND j.payload->>'business_date'>=((m.first_at AT TIME ZONE 'Asia/Shanghai')::date)::text AND j.payload->>'business_date'<=((m.last_at AT TIME ZONE 'Asia/Shanghai')::date)::text
 ), pending_links AS (
  SELECT DISTINCT j.payload->>'session_id' AS session_id FROM jobs j JOIN matched m ON m.id::text=j.payload->>'session_id' JOIN users u ON u.id=m.user_id AND u.status='active'
  WHERE $12::boolean AND j.kind='usage_attribution' AND j.payload->>'provider_account'=$10 AND j.status IN('queued','running')
 ), classified AS MATERIALIZED (
  SELECT m.*,COALESCE(o.records,0) AS official_records,o.tokens AS official_tokens,CASE WHEN o.model_count=1 THEN o.model END AS model,COALESCE(o.model_count,0) AS model_count,
   COALESCE(a.records,0) AS department_unassigned_records,COALESCE(c.count,0) AS attribution_conflicts,COALESCE(p.models,'[]'::jsonb) AS personal_models,
   CASE WHEN (COALESCE(o.records,0)+COALESCE(a.records,0))>0 AND jsonb_array_length(COALESCE(p.models,'[]'::jsonb))>0 THEN 'mixed' WHEN (COALESCE(o.records,0)+COALESCE(a.records,0))>0 THEN 'official'
    WHEN jsonb_array_length(COALESCE(p.models,'[]'::jsonb))>0 THEN 'custom' WHEN d.session_id IS NOT NULL OR l.session_id IS NOT NULL THEN 'pending' ELSE 'unknown' END AS channel
  FROM matched m LEFT JOIN official o ON o.session_id=m.id LEFT JOIN conflicts c ON c.session_id=m.id LEFT JOIN unassigned a ON a.session_id=m.id
  JOIN users u ON u.id=m.user_id LEFT JOIN session_personal_models p ON p.session_id=m.id AND p.user_id=u.id AND p.cleanup_generation=u.cleanup_generation
  LEFT JOIN pending_days d ON d.session_id=m.id LEFT JOIN pending_links l ON l.session_id=m.id::text
 ), filtered AS MATERIALIZED (
  SELECT * FROM classified WHERE $11='all' OR channel=$11 OR (channel='mixed' AND $11 IN('official','custom'))
 )`;

export async function sessionSourceRevision(db:Database,account:string|null,owner:string|null,department:string|null,period:{from:string;to:string},stopWindowEnabled=false){
 const result=await db.query<{stamp:string}>(`SELECT md5(jsonb_build_object(
  'usage',(SELECT md5(string_agg(id::text||':'||revision::text,',' ORDER BY id)) FROM usage_scopes WHERE provider_account=$1 AND ($2::uuid IS NULL OR user_id=$2) AND business_date>=($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND business_date<($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date),
  'links',(SELECT md5(string_agg(user_id::text||':'||revision::text,',' ORDER BY user_id)) FROM usage_attribution_revisions WHERE provider_account=$1 AND ($2::uuid IS NULL OR user_id=$2)),
  'personal',(SELECT md5(string_agg(user_id::text||':'||revision::text,',' ORDER BY user_id)) FROM personal_model_revisions WHERE $2::uuid IS NULL OR user_id=$2),
  'department_scope',$3::uuid,
  'membership',(SELECT COALESCE(sum(version),0)::text FROM users WHERE $2::uuid IS NULL OR id=$2),
  'pending_days',(SELECT md5(string_agg(j.id::text,',' ORDER BY j.id)) FROM jobs j JOIN users u ON u.id::text=j.payload->>'user_id' AND u.status='active' WHERE j.kind='usage_sync' AND j.payload->>'provider_account'=$1 AND j.status IN('queued','running') AND ($2::uuid IS NULL OR u.id=$2) AND j.payload->>'business_date'>=(($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AND j.payload->>'business_date'<(($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text),
  'stop_window_enabled',$6::boolean,
  'hook_queries',(SELECT md5(string_agg(s.id::text||':'||s.first_at::text||':'||s.last_at::text||':'||COALESCE(j.generation,0)::text,',' ORDER BY s.id)) FROM sessions s LEFT JOIN jobs j ON j.kind='derive_session' AND j.dedupe_key='derive:'||s.id::text WHERE $6::boolean AND $1 IS NOT NULL AND EXISTS(SELECT 1 FROM session_usage_queries q WHERE q.provider_account=$1 AND q.user_id=s.user_id) AND ($2::uuid IS NULL OR s.user_id=$2)),
  'session_queries',(SELECT md5(string_agg(q.session_id::text||':'||q.revision::text,',' ORDER BY q.session_id)) FROM session_usage_queries q WHERE $6::boolean AND q.provider_account=$1 AND ($2::uuid IS NULL OR q.user_id=$2)),
  'pending_links',(SELECT md5(string_agg(j.id::text,',' ORDER BY j.id)) FROM jobs j JOIN sessions s ON s.id::text=j.payload->>'session_id' JOIN users u ON u.id=s.user_id AND u.status='active' WHERE j.kind='usage_attribution' AND j.payload->>'provider_account'=$1 AND j.status IN('queued','running') AND ($2::uuid IS NULL OR u.id=$2))
 )::text) AS stamp`,[account,owner,department,period.from,period.to,stopWindowEnabled]);
 return result.rows[0]!.stamp;
}

type SessionListRow = { id: string; user_id: string; name: string; email: string; source_session_id: string; first_at: string; last_key: string; prompt_turns: number; title: string | null; total: string; channel:'official'|'pending'|'custom'|'mixed'|'unknown';model:string|null;model_count:number;official_tokens:string|null;official_records:number;department_unassigned_records:number;attribution_conflicts:number;personal_models:string[] };

/** Complete list read after the caller resolves identity, scope and cursor.
 * Bindings and source CTEs are internal; neither search parameters nor request
 * flags may supply reader identity. Public callers recheck authorization after
 * the read and compare sessionSourceRevision before returning a page.
 */
export async function querySessionList(db: Database, query: {
 period: { from: string; to: string }; owner: string | null; department: string | null;
 search: string; after: { at: string; id: string } | null; limit: number;
 account: string | null; channel: 'all' | 'official' | 'pending' | 'custom';
 sourceEnabled: boolean; stopWindowEnabled?:boolean; reader: { userId: string; super: boolean };
}) {
 const { period, owner, department, search, after, limit, account, channel, sourceEnabled, reader } = query;
 if (!reader.super && reader.userId !== owner) throw new DomainError('not_found', 404);
    const pattern = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const matching = `SELECT g.* FROM grouped g WHERE $5='' OR g.source_session_id ILIKE $6 OR g.email ILIKE $6 OR g.id IN(SELECT session_id FROM search_hits)`;
    // The all channel's search/order are Hook-only. Keep its full count, but
    // enrich just this page. Other channels must classify before selecting a
    // page; evidence claims still include competing sessions outside the page.
    const matches = channel === 'all' ? `all_matched AS MATERIALIZED (${matching}),
      page_candidates AS MATERIALIZED (
        SELECT * FROM all_matched WHERE $7::timestamptz IS NULL OR (last_at,id)<($7::timestamptz,$8::uuid)
        ORDER BY last_at DESC,id DESC LIMIT $9
      ), matched AS MATERIALIZED (SELECT * FROM page_candidates)` : `matched AS MATERIALIZED (${matching})`;
    const totalRelation = channel === 'all' ? 'all_matched' : 'filtered';
    return db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      // JSON expansion and partitioned evidence checks can inflate the plan
      // estimate even for a small page. Keep JIT startup out of this interactive
      // read without changing the pool's policy for other queries.
      await client.query('SET LOCAL jit=off');
      return (await client.query<{ total: string; items: SessionListRow[] }>(`WITH visible AS MATERIALIZED (
      SELECT e.id,e.occurred_at,e.session_id,e.user_id,e.event_type FROM hook_events e
      WHERE e.occurred_at>=$1 AND e.occurred_at<$2 AND ($3::uuid IS NULL OR e.user_id=$3) AND ($4::uuid IS NULL OR e.department_id=$4)
      AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
    ), grouped_events AS MATERIALIZED (
      SELECT session_id,user_id,min(occurred_at) AS first_at,max(occurred_at) AS last_at,
        count(*) FILTER(WHERE event_type='UserPromptSubmit')::integer AS prompt_turns
      FROM visible GROUP BY session_id,user_id
    ), grouped AS (
      SELECT s.id,s.user_id,u.display_name AS name,u.email_key AS email,s.source_session_id,e.first_at,e.last_at,e.prompt_turns
      FROM grouped_events e JOIN sessions s ON s.id=e.session_id JOIN users u ON u.id=e.user_id
    ), search_hits AS MATERIALIZED (
      SELECT DISTINCT v.session_id FROM visible v JOIN hook_events p ON p.id=v.id AND p.occurred_at=v.occurred_at
      WHERE $5<>'' AND v.event_type='UserPromptSubmit' AND p.occurred_at>=$1 AND p.occurred_at<$2 AND p.payload->>'prompt' ILIKE $6
    ), ${matches}, ${sessionListSourcesSql}, page AS (
      SELECT * FROM filtered WHERE $7::timestamptz IS NULL OR (last_at,id)<($7::timestamptz,$8::uuid) ORDER BY last_at DESC,id DESC LIMIT $9
    ), entries AS (
      SELECT g.id,g.user_id,g.name,g.email,g.source_session_id,g.first_at::text AS first_at,g.last_at::text AS last_key,g.prompt_turns,g.channel,g.model,g.model_count,g.official_tokens,g.official_records,g.department_unassigned_records,g.attribution_conflicts,g.personal_models,
        (SELECT left(p.payload->>'prompt',160) FROM hook_events p
          WHERE p.session_id=g.id AND p.event_type='UserPromptSubmit' AND p.occurred_at>=$1 AND p.occurred_at<$2
          AND ($3::uuid IS NULL OR p.user_id=$3) AND ($4::uuid IS NULL OR p.department_id=$4)
          AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=p.user_id AND t.from_at<=p.occurred_at AND t.to_at>p.occurred_at)
          ORDER BY p.occurred_at,p.id LIMIT 1) AS title
      FROM page g
    ) SELECT (SELECT count(*)::text FROM ${totalRelation}) AS total,COALESCE(jsonb_agg(to_jsonb(entries) ORDER BY last_key::timestamptz DESC,id DESC),'[]'::jsonb) AS items FROM entries`, [period.from, period.to, owner, department, search, pattern, after?.at ?? null, after?.id ?? null, limit + 1,account,channel,sourceEnabled,reader.userId,reader.super,query.stopWindowEnabled===true])).rows[0]!;
    });
}
