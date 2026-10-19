import {modelCheckOwnerSql} from './usage-model-checks.js';
export type ModelCheckState='matched'|'cohort_matched'|'difference'|'not_comparable'|'stale'|'pending'|'failed'|'not_checked';
export type RawModelDay={date:string;state:ModelCheckState;user_days:string;oldest_checked_at:string|null;next_check_at:string|null};
export type ModelComparisonGroup={model_source:string;model_type:string;user_days:number;detail_input_tokens:string|null;detail_output_tokens:string|null;official_input_tokens:string|null;official_output_tokens:string|null;models_comparable:boolean};
export type ModelCheckSummary={availability:'available'|'department_scope_not_comparable';scope:'all_clients_all_consumption';as_of:string;days:(Omit<RawModelDay,'user_days'>&{user_days:number})[];groups:ModelComparisonGroup[];truncated:boolean};
/** Appended to the authorized official-usage CTEs. A department slice cannot
 * expose or compare a full member summary, even when the member is selected. */
export const modelReadingCtes=`model_policy AS MATERIALIZED (
 SELECT dataset_id,recovery_id,retention_cutoff FROM data_identity WHERE singleton=true LIMIT 1
), model_candidates AS MATERIALIZED (
 SELECT e.day,e.user_id,c.result,c.checked_at,j.status AS job_status,j.error_code,
  CASE WHEN j.status IN('queued','running','succeeded','failed') THEN j.available_at END AS next_check_at,
  COALESCE(s.ready AND c.source_revision=s.revision AND c.cleanup_generation=u.cleanup_generation
   AND c.owner_key=${modelCheckOwnerSql} AND u.status='active' AND d.recovery_id IS NULL,false) AS current
 FROM expected e JOIN users u ON u.id=e.user_id CROSS JOIN model_policy d
 LEFT JOIN scopes s ON s.user_id=e.user_id AND s.business_date=e.day
 LEFT JOIN usage_model_checks c ON c.scope_id=s.id
 LEFT JOIN usage_provider_identities p ON p.user_id=e.user_id AND p.provider_account=$1
 LEFT JOIN jobs j ON j.kind='usage_model_check' AND j.dedupe_key='usage-model:'||$1||':'||e.user_id::text||':'||e.day::text
 WHERE $5::uuid[] IS NULL
), model_states AS MATERIALIZED (
 SELECT *,CASE WHEN job_status IN('queued','running','failed') AND error_code IS NOT NULL THEN 'failed'
  WHEN result IS NOT NULL AND NOT current THEN 'stale'
  WHEN job_status IN('queued','running') THEN 'pending'
  WHEN result IS NOT NULL AND current THEN result->>'state' ELSE 'not_checked' END AS state
 FROM model_candidates
), model_days AS (
 SELECT day::text AS date,state,count(*)::text AS user_days,min(checked_at) AS oldest_checked_at,min(next_check_at) AS next_check_at
 FROM model_states GROUP BY day,state
), model_groups AS (
 SELECT COALESCE(NULLIF(g->>'model_source',''),'unknown') AS model_source,COALESCE(NULLIF(g->>'model_type',''),'unknown') AS model_type,count(*)::text AS user_days,
  CASE WHEN count(*) FILTER(WHERE g->'detail'->>'input_tokens' IS NULL)>0 THEN NULL ELSE sum((g->'detail'->>'input_tokens')::numeric)::text END AS detail_input_tokens,
  CASE WHEN count(*) FILTER(WHERE g->'detail'->>'output_tokens' IS NULL)>0 THEN NULL ELSE sum((g->'detail'->>'output_tokens')::numeric)::text END AS detail_output_tokens,
  CASE WHEN count(*) FILTER(WHERE g->'official'->>'input_tokens' IS NULL)>0 THEN NULL ELSE sum((g->'official'->>'input_tokens')::numeric)::text END AS official_input_tokens,
  CASE WHEN count(*) FILTER(WHERE g->'official'->>'output_tokens' IS NULL)>0 THEN NULL ELSE sum((g->'official'->>'output_tokens')::numeric)::text END AS official_output_tokens,
  bool_and(COALESCE((g->>'models_comparable')::boolean,false)) AS models_comparable
 FROM model_states CROSS JOIN LATERAL jsonb_array_elements(result->'groups') g
 WHERE current AND state IN('matched','cohort_matched','difference','not_comparable')
 GROUP BY 1,2
)`;
