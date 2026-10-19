import {SESSION_DERIVATION_VERSION} from './session-derivation.js';
export interface SessionTimeCandidate {
 billing_session_id:string;model_name:string|null;business_date:string;tokens:string|null;
 scope_from:string;scope_to:string;observed_start_at:string;
 relation:'time_inferred'|'ambiguous';reason:'unique_observed_window'|'multiple_bills_in_window'|'competing_hook_sessions';
}
export interface SessionTimeCandidates {
 state:'unavailable'|'none'|'available';reason:string|null;basis:'observed_prompt_windows_seconds';items:SessionTimeCandidate[];
}
export const emptyTimeCandidates=():SessionTimeCandidates=>({state:'unavailable',reason:'official_source_unconfigured',basis:'observed_prompt_windows_seconds',items:[]});
/** Read-only extension of the authorized session-usage query. Uses its scopes,
 * valid_links and $2 session/$3 owner/$4 from/$5 to bindings in one DB snapshot.
 * Time candidates never enter relationship evidence or the quantity aggregate. */
export const timeCandidateCtes=`candidate_context AS MATERIALIZED (
 SELECT s.id,s.user_id,r.id AS run_id,
  COALESCE(r.state='published' AND r.metric_version='${SESSION_DERIVATION_VERSION}' AND r.cleanup_generation=u.cleanup_generation AND r.source_generation=j.generation,false) AS current,
  (s.history_redacted OR s.history_expired OR s.first_at<$4 OR s.last_at>=$5 OR COALESCE(r.from_at<d.retention_cutoff,false)
   OR EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.from_at<=s.last_at AND t.to_at>s.first_at)) AS partial
 FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d
 LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=s.user_id
 LEFT JOIN jobs j ON j.kind='derive_session' AND j.dedupe_key='derive:'||s.id::text
 WHERE s.id=$2 AND s.user_id=$3
), candidate_windows AS MATERIALIZED (
 SELECT t.turn_index,floor(extract(epoch FROM t.prompt_at)) AS first_second,floor(extract(epoch FROM t.last_at)) AS last_second
 FROM candidate_context c JOIN session_turns t ON t.run_id=c.run_id WHERE c.current AND NOT c.partial ORDER BY t.turn_index LIMIT 1001
), candidate_records AS MATERIALIZED (
 SELECT jsonb_build_array(o.run_id,o.part,o.page,o.item_index)::text AS key,s.business_date,o.value,
  to_timestamp(p.start_second) AS scope_from,to_timestamp(p.end_second+1) AS scope_to
 FROM scopes s JOIN usage_observations o ON o.run_id=s.published_run_id
 JOIN usage_snapshot_parts p ON p.run_id=o.run_id AND p.part=o.part
 JOIN usage_provider_identities i ON i.provider_account=$1 AND i.user_id=$3 AND i.provider_user_id=o.value->>'provider_user_id'
 WHERE s.ready AND o.value->>'scene'='Chat' AND o.value->>'model_source'='Trae' AND COALESCE(o.value->>'client','') IN('','ide')
  AND NULLIF(o.value->>'billing_session_id','') IS NOT NULL AND o.value->>'start_time' IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM data_identity d WHERE p.start_second<ceil(extract(epoch FROM d.retention_cutoff)))
  AND NOT EXISTS(SELECT 1 FROM valid_links l WHERE l.billing_session_id=o.value->>'billing_session_id')
 ORDER BY s.business_date,o.part,o.page,o.item_index LIMIT 5001
), candidate_matches AS MATERIALIZED (
 SELECT r.key,w.turn_index FROM candidate_records r JOIN candidate_windows w ON (r.value->>'start_time')::numeric BETWEEN w.first_second AND w.last_second
), candidate_window_counts AS (
 SELECT m.turn_index,count(DISTINCT r.value->>'billing_session_id') AS ids FROM candidate_matches m JOIN candidate_records r ON r.key=m.key GROUP BY m.turn_index
), candidate_rows AS MATERIALIZED (
 SELECT r.*,
  (SELECT bool_and(c.ids=1) FROM candidate_matches m JOIN candidate_window_counts c ON c.turn_index=m.turn_index WHERE m.key=r.key) AS unique_window,
  EXISTS(SELECT 1 FROM sessions other WHERE other.user_id=$3 AND other.id<>$2
   AND (r.value->>'start_time')::numeric BETWEEN floor(extract(epoch FROM other.first_at)) AND floor(extract(epoch FROM other.last_at))
   AND EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id=other.id
    AND NOT EXISTS(SELECT 1 FROM data_identity d WHERE e.occurred_at<d.retention_cutoff)
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))) AS competing
 FROM candidate_records r WHERE EXISTS(SELECT 1 FROM candidate_matches m WHERE m.key=r.key)
 ORDER BY r.business_date,r.key LIMIT 201
), candidate_gate AS (
 SELECT CASE WHEN NOT COALESCE((SELECT current FROM candidate_context),false) THEN 'trace_pending'
  WHEN (SELECT partial FROM candidate_context) THEN 'trace_partial'
  WHEN NOT EXISTS(SELECT 1 FROM candidate_windows) THEN 'no_prompt_windows'
  WHEN (SELECT count(*) FROM candidate_windows)>1000 OR (SELECT count(*) FROM candidate_records)>5000 OR (SELECT count(*) FROM candidate_rows)>200 THEN 'candidate_limit'
  WHEN NOT EXISTS(SELECT 1 FROM scopes WHERE ready) THEN 'official_source_unavailable'
  WHEN (SELECT verified_days<expected_days FROM coverage) THEN 'official_source_incomplete' ELSE NULL END AS reason
)`;
export const timeCandidateResultSql=`(SELECT jsonb_build_object(
 'state',CASE WHEN reason IS NOT NULL THEN 'unavailable' WHEN EXISTS(SELECT 1 FROM candidate_rows) THEN 'available' ELSE 'none' END,
 'reason',reason,'basis','observed_prompt_windows_seconds','items',CASE WHEN reason IS NOT NULL THEN '[]'::jsonb ELSE COALESCE((
 SELECT jsonb_agg(jsonb_build_object('billing_session_id',value->>'billing_session_id','model_name',value->>'model_name','business_date',business_date::text,
  'tokens',value->'usage'->>'total_tokens','scope_from',scope_from,'scope_to',scope_to,'observed_start_at',to_timestamp((value->>'start_time')::double precision),
  'relation',CASE WHEN unique_window AND NOT competing THEN 'time_inferred' ELSE 'ambiguous' END,
  'reason',CASE WHEN competing THEN 'competing_hook_sessions' WHEN NOT unique_window THEN 'multiple_bills_in_window' ELSE 'unique_observed_window' END)
 ORDER BY business_date,key) FROM candidate_rows),'[]'::jsonb) END) FROM candidate_gate)`;
