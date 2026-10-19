import { officialTokenBreakdownSql, officialTokenBreakdown, type RawTokenBreakdown } from './official-token-breakdown.js';
import { localUsageDepartmentSql } from './local-usage-department.js';
import {modelReadingCtes,type RawModelDay,type ModelComparisonGroup,type ModelCheckSummary} from './usage-model-reading.js';
import {incompleteTokenRecordSql} from './official-token-quality.js';
import { officialAmountReasonsSql, amountMissingReasons, type RawAmountMissingReasons } from './official-amount-reasons.js';
import type {Database} from '@adi/storage';
import {DomainError} from './errors.js';

type Period = { from: string; to: string };
export type ModelScope = { userId: string | null; departmentIds: string[] | null };
export type ModelFilter = { scene: 'Chat' | 'CUE' | 'other'; client: 'ide' | 'unspecified'; model_key?: string };

/** The summary and model projections share the complete person/day read set.
 * SQL aliases and the first five bindings stay inside this module; callers pass
 * an already-authorized scope and never assemble snapshot or membership rules.
 */
function personDayRead(account: string, period: Period, scope: ModelScope, projection: 'summary' | 'models') {
 const begin = Date.parse(period.from), end = Date.parse(period.to);
 if ((begin + 28800000) % 86400000 || (end + 28800000) % 86400000) throw new DomainError('official_period_precision', 422);
 const from = new Date(begin + 28800000).toISOString().slice(0, 10);
 const to = new Date(end + 28800000).toISOString().slice(0, 10);
 // Preserve the existing projections while deepening the read module: summary
 // fences a newly advanced retention cutoff immediately; models currently waits
 // for snapshot invalidation. The integration characterization records this
 // difference; changing it needs a separate retention behavior decision.
 const retention = projection === 'summary'
  ? `AND NOT EXISTS(SELECT 1 FROM usage_snapshot_parts vp WHERE vp.run_id=s.verified_run_id AND vp.start_second<ceil(extract(epoch FROM (SELECT retention_cutoff FROM data_identity WHERE singleton=true LIMIT 1))))`
  : '';
 // Summary reports unassigned records even without a department filter. Models
 // need membership allocation only for a department slice; keep that fast path.
 const allocate = projection === 'summary' ? 'true' : '$5::uuid[] IS NOT NULL';
 const ctes = `dates AS (SELECT g::date AS day FROM generate_series(GREATEST($2::date,(SELECT (collection_baseline_at AT TIME ZONE 'Asia/Shanghai')::date FROM data_identity)),$3::date-1,interval '1 day') g),
 scopes AS MATERIALIZED (
  SELECT s.*,v.from_second,v.to_second,v.cleanup_generation,
   COALESCE(v.data_run_id=s.published_run_id AND v.state IN('published','unchanged') AND d.state='published'
    AND v.content_hash LIKE 'scope-v2:%' AND d.content_hash LIKE 'scope-v2:%'
    ${retention}
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.generation>v.cleanup_generation AND t.from_at<to_timestamp(v.to_second+1) AND t.to_at>to_timestamp(v.from_second)),false) AS ready
  FROM usage_scopes s LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id LEFT JOIN usage_snapshot_runs d ON d.id=s.published_run_id
  WHERE s.provider_account=$1 AND s.business_date>=GREATEST($2::date,(SELECT (collection_baseline_at AT TIME ZONE 'Asia/Shanghai')::date FROM data_identity)) AND s.business_date<$3::date AND ($4::uuid IS NULL OR s.user_id=$4)
 ), allocated AS MATERIALIZED (
  SELECT s.id AS scope_id,s.user_id,s.business_date,o.value,a.department_id,
   CASE WHEN o.value->>'scene' IN('Chat','CUE') THEN o.value->>'scene' ELSE 'other' END AS scene,
   CASE WHEN o.value->>'client'='ide' THEN 'ide' WHEN COALESCE(o.value->>'client','')='' THEN 'unspecified' ELSE 'other' END AS client,
   CASE WHEN o.value->>'model_source' IN('Trae','Custom') THEN o.value->>'model_source' ELSE 'unknown' END AS model_source,
   CASE WHEN o.value->>'consumption_source' IN('basic','pay_go','mixed','enterprise_builtin') THEN o.value->>'consumption_source' ELSE 'unknown' END AS consumption_source
  FROM scopes s JOIN usage_observations o ON o.run_id=s.published_run_id JOIN usage_snapshot_parts p ON p.run_id=o.run_id AND p.part=o.part
  LEFT JOIN LATERAL (${localUsageDepartmentSql}) a ON ${allocate} WHERE s.ready
 ), visible AS MATERIALIZED (SELECT * FROM allocated WHERE $5::uuid[] IS NULL OR department_id=ANY($5)),
 expected AS MATERIALIZED (
  SELECT u.id AS user_id,d.day FROM users u CROSS JOIN dates d WHERE ($4::uuid IS NULL OR u.id=$4) AND ($4::uuid IS NOT NULL OR u.status='active')
   AND ($5::uuid[] IS NULL OR EXISTS(SELECT 1 FROM membership_periods m WHERE m.user_id=u.id AND m.department_id=ANY($5) AND m.valid_from<(d.day+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AND (m.valid_to IS NULL OR m.valid_to>d.day::timestamp AT TIME ZONE 'Asia/Shanghai')))
  UNION SELECT user_id,business_date FROM visible
 )`;
 return { ctes, values: [account, from, to, scope.userId, scope.departmentIds] };
}

type TokenBucket={records:number;tokens:string|null;known_tokens:string;missing_token_records:number};
type GapDay={date:string;waiting_user_days:number;overdue_user_days:number;failed_user_days:number;known_gap_user_days:number;next_check_at:string|null};
export type UsageReconciliation={as_of:string;days:GapDay[];scope:'chat_ide_or_unspecified';session_completeness:'unknown';total:TokenBucket;attributed:TokenBucket;unattributed:TokenBucket;conflicting:TokenBucket};
const safeCount=(value:string|number)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new DomainError('metric_overflow',503);return n;};
export async function queryOfficialUsage(db:Database,account:string,period:{from:string;to:string},scope:{userId:string|null;departmentIds:string[]|null},at=new Date()){
 const read=personDayRead(account,period,scope,'summary');
 const epochSql="SELECT concat_ws(':',COALESCE(sum(cleanup_generation),0)::text,COALESCE(sum(ingest_epoch),0)::text,COALESCE(sum(version),0)::text,(SELECT dataset_id::text||':'||COALESCE(recovery_id::text,'')||':'||COALESCE(retention_cutoff::text,'') FROM data_identity WHERE singleton=true LIMIT 1)) AS epoch FROM users WHERE $1::uuid IS NULL OR id=$1";
 const epoch=(await db.query<{epoch:string}>(epochSql,[scope.userId])).rows[0]!.epoch;
 // A single materialized relation map prevents PostgreSQL's underestimated JSON
 // cardinality from choosing quadratic CTE rescans when most bills have links.
 const base=`WITH ${read.ctes}, bill_keys AS MATERIALIZED (
  SELECT DISTINCT user_id,value->>'billing_session_id' AS billing_id,value->>'provider_user_id' AS provider_user_id FROM visible WHERE scene='Chat' AND client<>'other'
 ), valid_evidence AS MATERIALIZED (
  SELECT e.user_id,e.session_id,e.billing_session_id,e.provider_user_id FROM usage_attribution_evidence e
  JOIN bill_keys k ON k.user_id=e.user_id AND k.billing_id=e.billing_session_id AND k.provider_user_id=e.provider_user_id
  JOIN users u ON u.id=e.user_id JOIN usage_provider_identities i ON i.user_id=e.user_id AND i.provider_account=e.provider_account AND i.provider_user_id=e.provider_user_id
  WHERE e.provider_account=$1 AND e.cleanup_generation=u.cleanup_generation
 ), claims AS MATERIALIZED (
  SELECT jsonb_build_array(user_id,billing_session_id,provider_user_id)::text AS key,jsonb_agg(session_id) AS sessions
  FROM valid_evidence GROUP BY user_id,billing_session_id,provider_user_id
 ), claim_map AS MATERIALIZED (
  SELECT COALESCE(jsonb_object_agg(key,sessions),'{}'::jsonb) AS members FROM claims
 ), related AS MATERIALIZED (
  SELECT v.user_id,v.business_date,v.value,COALESCE((SELECT members FROM claim_map)->jsonb_build_array(v.user_id,v.value->>'billing_session_id',v.value->>'provider_user_id')::text,'[]'::jsonb) AS session_ids
  FROM visible v WHERE v.scene='Chat' AND v.client<>'other'
 ), reconciled AS (
  SELECT r.*,CASE jsonb_array_length(session_ids) WHEN 0 THEN 'unattributed' WHEN 1 THEN 'attributed' ELSE 'conflicting' END AS state FROM related r
 ), reconciliation AS (
  SELECT state,count(*)::text AS records,COALESCE(sum((value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,
   count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens
  FROM reconciled GROUP BY ROLLUP(state)
 ), visible_hooks AS MATERIALIZED (
  SELECT e.user_id,e.session_id,(e.occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,e.received_at
  FROM hook_events e WHERE e.occurred_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND e.occurred_at<($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
   AND ($4::uuid IS NULL OR e.user_id=$4) AND ($5::uuid[] IS NULL OR e.department_id=ANY($5))
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
 ), hook_days AS (SELECT user_id,day,min(received_at) AS first_seen_at FROM visible_hooks GROUP BY user_id,day),
 session_days AS MATERIALIZED (
  SELECT user_id,session_id,day FROM visible_hooks
  UNION SELECT r.user_id,s.session_id::uuid,r.business_date FROM related r CROSS JOIN LATERAL jsonb_array_elements_text(r.session_ids) s(session_id)
 ), probe_failures AS (
  SELECT s.user_id,s.day,min(CASE WHEN p.status IN('queued','running') OR (p.payload->>'recurring'='true' AND (p.status='succeeded' OR (p.status='failed' AND p.error_code NOT IN('account_inactive','not_found','stale_usage_context')))) THEN p.available_at END) AS next_at
  FROM session_days s LEFT JOIN usage_attribution_subjects a ON a.provider_account=$1 AND a.user_id=s.user_id AND a.session_id=s.session_id
  LEFT JOIN jobs p ON p.dedupe_key='usage-link:'||$1||':'||s.session_id::text AND p.kind='usage_attribution'
  WHERE a.probe_state='failed' OR (p.error_code IS NOT NULL AND p.error_code<>'account_inactive' AND p.status IN('queued','running','failed')) GROUP BY s.user_id,s.day
 ), known_gaps AS (
  SELECT user_id,business_date FROM reconciled WHERE state<>'attributed'
  UNION SELECT user_id,business_date FROM visible WHERE client<>'other' AND (${incompleteTokenRecordSql})
 ), record_days AS (SELECT DISTINCT user_id,business_date FROM reconciled), day_status AS (
  SELECT e.day,LEAST(CASE WHEN j.status IN('queued','running') OR (j.payload->>'recurring'='true' AND (j.status='succeeded' OR (j.status='failed' AND j.error_code NOT IN('account_inactive','invalid_usage_day','usage_scope_expired')))) THEN j.available_at END,f.next_at) AS available_at,CASE
   WHEN f.user_id IS NOT NULL OR (j.error_code IS NOT NULL AND j.error_code<>'account_inactive' AND j.status IN('queued','running','failed')) THEN 'failed'
   WHEN k.user_id IS NOT NULL OR (s.published_run_id IS NOT NULL AND NOT s.ready) THEN 'known_gap'
   WHEN NOT COALESCE(s.ready,false) OR h.user_id IS NOT NULL OR r.user_id IS NOT NULL THEN CASE
    WHEN $6::timestamptz>=COALESCE(LEAST(h.first_seen_at,j.created_at),GREATEST(e.day::timestamp AT TIME ZONE 'Asia/Shanghai',u.created_at))+interval '24 hours' THEN 'overdue' ELSE 'waiting' END
   ELSE 'observed' END AS state
  FROM expected e JOIN users u ON u.id=e.user_id AND u.status='active'
  LEFT JOIN scopes s ON s.user_id=e.user_id AND s.business_date=e.day
  LEFT JOIN hook_days h ON h.user_id=e.user_id AND h.day=e.day
  LEFT JOIN known_gaps k ON k.user_id=e.user_id AND k.business_date=e.day
  LEFT JOIN record_days r ON r.user_id=e.user_id AND r.business_date=e.day
  LEFT JOIN probe_failures f ON f.user_id=e.user_id AND f.day=e.day
  LEFT JOIN jobs j ON j.dedupe_key='usage:'||$1||':'||e.user_id::text||':'||e.day::text AND j.kind='usage_sync'
 ), gap_days AS (
  SELECT day::text AS date,count(*) FILTER(WHERE state='waiting')::text AS waiting_user_days,count(*) FILTER(WHERE state='overdue')::text AS overdue_user_days,
   count(*) FILTER(WHERE state='failed')::text AS failed_user_days,count(*) FILTER(WHERE state='known_gap')::text AS known_gap_user_days,min(available_at) AS next_check_at
  FROM day_status GROUP BY day ORDER BY day LIMIT 46
 ), ${modelReadingCtes}, coverage AS (
  SELECT count(*)::text AS expected_days,count(s.id) FILTER(WHERE s.ready)::text AS verified_days,
   count(s.id) FILTER(WHERE NOT s.ready AND s.published_run_id IS NOT NULL)::text AS invalidated_days,
   count(s.id) FILTER(WHERE s.active_run_id IS NOT NULL)::text AS refreshing_days,min(s.last_verified_at) FILTER(WHERE s.ready) AS oldest_verified_at
  FROM expected e LEFT JOIN scopes s ON s.user_id=e.user_id AND s.business_date=e.day
 ), grouped AS (
  SELECT scene,client,model_source,consumption_source,NULLIF(value->>'currency','') AS currency,count(*)::text AS records,
   COALESCE(sum((value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens,${officialTokenBreakdownSql},
   COALESCE(sum((value->>'model_call_count')::numeric),0)::text AS known_calls,count(*) FILTER(WHERE value->>'model_call_count' IS NULL)::text AS missing_calls,
   sum((value->>'amount')::numeric)::text AS known_amount,count(*) FILTER(WHERE value->>'amount' IS NULL OR NULLIF(value->>'currency','') IS NULL)::text AS missing_amount,
   ${officialAmountReasonsSql},
   count(*) FILTER(WHERE jsonb_array_length(COALESCE(value->'quality','[]'::jsonb))>0)::text AS quality_records
  FROM visible WHERE client<>'other' GROUP BY scene,client,model_source,consumption_source,NULLIF(value->>'currency','')
 ) SELECT (SELECT row_to_json(coverage) FROM coverage) AS coverage,
  COALESCE((SELECT jsonb_agg(md ORDER BY date,state) FROM model_days md),'[]'::jsonb) AS model_days,
  COALESCE((SELECT jsonb_agg(mg ORDER BY model_source,model_type) FROM (SELECT * FROM model_groups ORDER BY model_source,model_type LIMIT 101) mg),'[]'::jsonb) AS model_groups,
  EXISTS(SELECT 1 FROM model_states WHERE current AND state IN('matched','cohort_matched','difference','not_comparable') AND result->>'truncated'='true') AS model_truncated,
  (SELECT jsonb_agg(r) FROM reconciliation r) AS reconciliation,
  COALESCE((SELECT jsonb_agg(d ORDER BY date) FROM gap_days d),'[]'::jsonb) AS days,
  (SELECT count(*)::text FROM visible WHERE client='other') AS excluded,
  CASE WHEN $5::uuid[] IS NULL THEN (SELECT count(*)::text FROM allocated WHERE department_id IS NULL AND client<>'other') ELSE NULL END AS unassigned,
  COALESCE((SELECT jsonb_agg(g ORDER BY scene,client,model_source,consumption_source,currency) FROM (SELECT * FROM grouped ORDER BY scene,client,model_source,consumption_source,currency LIMIT 201) g),'[]'::jsonb) AS groups`;
 type Group=RawTokenBreakdown&{scene:'Chat'|'CUE'|'other';client:'ide'|'unspecified';model_source:'Trae'|'Custom'|'unknown';consumption_source:'basic'|'pay_go'|'mixed'|'enterprise_builtin'|'unknown';currency:string|null;records:string;known_tokens:string;missing_tokens:string;known_calls:string;missing_calls:string;known_amount:string|null;missing_amount:string;amount_missing_reasons:RawAmountMissingReasons;quality_records:string};
 type RawBucket={state:'attributed'|'unattributed'|'conflicting'|null;records:string;known_tokens:string;missing_tokens:string};
 type RawDay={date:string;waiting_user_days:string;overdue_user_days:string;failed_user_days:string;known_gap_user_days:string;next_check_at:string|null};
 const result=(await db.query<{model_days:RawModelDay[];model_groups:(Omit<ModelComparisonGroup,'user_days'>&{user_days:string})[];model_truncated:boolean;days:RawDay[];reconciliation:RawBucket[];coverage:{expected_days:string;verified_days:string;invalidated_days:string;refreshing_days:string;oldest_verified_at:string|null};excluded:string;unassigned:string|null;groups:Group[]}>(base,[...read.values,at])).rows[0]!;
 if(result.groups.length>200||result.days.length>45||result.model_days.length>360)throw new DomainError('metric_overflow',503);
 if((await db.query<{epoch:string}>(epochSql,[scope.userId])).rows[0]!.epoch!==epoch)throw new DomainError('content_changed',409);
 const bucket=(state:RawBucket['state']):TokenBucket=>{const row=result.reconciliation.find(value=>value.state===state);const records=safeCount(row?.records??0),missing=safeCount(row?.missing_tokens??0),known=row?.known_tokens??'0';return {records,tokens:records>0&&missing===0?known:null,known_tokens:known,missing_token_records:missing};};
 const expected=safeCount(result.coverage.expected_days),verified=safeCount(result.coverage.verified_days);
 const modelCheck:ModelCheckSummary={availability:scope.departmentIds===null?'available':'department_scope_not_comparable',scope:'all_clients_all_consumption',as_of:at.toISOString(),days:result.model_days.map(day=>({...day,user_days:safeCount(day.user_days)})),groups:result.model_groups.slice(0,100).map(group=>({...group,user_days:safeCount(group.user_days)})),truncated:result.model_truncated||result.model_groups.length>100};
 return {model_check:modelCheck as ModelCheckSummary|null,reconciliation:{as_of:at.toISOString(),days:result.days.map(row=>({...row,waiting_user_days:safeCount(row.waiting_user_days),overdue_user_days:safeCount(row.overdue_user_days),failed_user_days:safeCount(row.failed_user_days),known_gap_user_days:safeCount(row.known_gap_user_days)})),scope:'chat_ide_or_unspecified',session_completeness:'unknown',total:bucket(null),attributed:bucket('attributed'),unattributed:bucket('unattributed'),conflicting:bucket('conflicting')} as UsageReconciliation|null,configured:true,source:'trae_openapi' as const,token_basis:'provider_reported' as const,settlement:'unverified' as const,
  coverage:{expected_user_days:expected,verified_user_days:verified,missing_user_days:expected-verified,invalidated_user_days:safeCount(result.coverage.invalidated_days),refreshing_user_days:safeCount(result.coverage.refreshing_days),oldest_verified_at:result.coverage.oldest_verified_at,complete:expected>0&&expected===verified},
  unassigned_records:result.unassigned===null?null:safeCount(result.unassigned),excluded_client_records:safeCount(result.excluded),
  groups:result.groups.map(row=>({token_breakdown:officialTokenBreakdown(row),scene:row.scene,client:row.client,model_source:row.model_source,consumption_source:row.consumption_source,currency:row.currency,records:safeCount(row.records),tokens:row.missing_tokens==='0'?row.known_tokens:null,known_tokens:row.known_tokens,missing_token_records:safeCount(row.missing_tokens),calls:row.missing_calls==='0'?row.known_calls:null,known_calls:row.known_calls,missing_call_records:safeCount(row.missing_calls),amount:row.missing_amount==='0'&&row.currency?row.known_amount:null,known_amount:row.currency?row.known_amount:null,unknown_amount_records:safeCount(row.missing_amount),amount_missing_reasons:amountMissingReasons(row.amount_missing_reasons),quality_records:safeCount(row.quality_records)}))};
}
export type OfficialUsageSummary=Awaited<ReturnType<typeof queryOfficialUsage>>;
export async function modelRevision(db:Database,account:string|null,period:{from:string;to:string},scope:ModelScope){
 return (await db.query<{stamp:string}>(`SELECT md5(jsonb_build_object(
  'cleanup',(SELECT COALESCE(sum(cleanup_generation),0)::text FROM users WHERE $4::uuid IS NULL OR id=$4),
  'scopes',(SELECT md5(string_agg(id::text||':'||revision::text,',' ORDER BY id)) FROM usage_scopes WHERE provider_account=$1 AND ($4::uuid IS NULL OR user_id=$4) AND business_date>=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND business_date<($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date),
  'membership',(SELECT COALESCE(sum(version),0)::text FROM users WHERE $4::uuid IS NULL OR id=$4)
 )::text) AS stamp`,[account,period.from,period.to,scope.userId])).rows[0]!.stamp;
}
type RawCost={currency:string|null;known_amount:string|null;unknown_amount_records:string;amount_missing_reasons:RawAmountMissingReasons};
type RawModel={key:string;name:string|null;model_source:'Trae'|'Custom'|'unknown';records:string;users:string;known_tokens:string;missing_tokens:string;known_calls:string;missing_calls:string;quality_records:string;costs:RawCost[]};
type RawTrend={date:string;records:string;known_tokens:string;missing_tokens:string;known_calls:string;missing_calls:string;expected_users:string;verified_users:string};
type Coverage={expected_user_days:number;verified_user_days:number;missing_user_days:number;oldest_verified_at:string|null;query_through_at:string|null};
export function emptyModels(){return {configured:false,source:'trae_openapi' as const,settlement:'unverified' as const,total:0,items:[] as ReturnType<typeof model>[],trend:[] as ReturnType<typeof trend>[],selected_model:null as Pick<RawModel,'key'|'name'|'model_source'>|null,coverage:{expected_user_days:0,verified_user_days:0,missing_user_days:0,oldest_verified_at:null,query_through_at:null} as Coverage};}
function model(row:RawModel){if(row.costs.length>200)throw new DomainError('metric_overflow',503);return {key:row.key,name:row.name,model_source:row.model_source,records:safeCount(row.records),users:safeCount(row.users),tokens:row.missing_tokens==='0'?row.known_tokens:null,known_tokens:row.known_tokens,missing_token_records:safeCount(row.missing_tokens),calls:row.missing_calls==='0'?row.known_calls:null,known_calls:row.known_calls,missing_call_records:safeCount(row.missing_calls),quality_records:safeCount(row.quality_records),costs:row.costs.map(cost=>({currency:cost.currency,amount:cost.unknown_amount_records==='0'&&cost.currency?cost.known_amount:null,known_amount:cost.currency?cost.known_amount:null,unknown_amount_records:safeCount(cost.unknown_amount_records),amount_missing_reasons:amountMissingReasons(cost.amount_missing_reasons)}))};}
function trend(row:RawTrend){return {date:row.date,records:safeCount(row.records),tokens:row.records!=='0'&&row.missing_tokens==='0'?row.known_tokens:null,known_tokens:row.known_tokens,calls:row.records!=='0'&&row.missing_calls==='0'?row.known_calls:null,missing_token_records:safeCount(row.missing_tokens),expected_users:safeCount(row.expected_users),verified_users:safeCount(row.verified_users)};}

/** Bounded aggregate read; the analytics service owns authorization and revision fences. */
export async function queryModels(db:Database,account:string,period:{from:string;to:string},scope:ModelScope,filter:ModelFilter,page:{limit:number;offset:number}){
 const read=personDayRead(account,period,scope,'models');
 const sql=`WITH ${read.ctes}, daily_coverage AS (
  SELECT d.day,count(e.user_id)::text AS expected_users,count(e.user_id) FILTER(WHERE s.ready)::text AS verified_users,min(s.last_verified_at) FILTER(WHERE s.ready) AS oldest_verified_at,max(s.to_second) FILTER(WHERE s.ready) AS through_second
  FROM dates d LEFT JOIN expected e ON e.day=d.day LEFT JOIN scopes s ON s.user_id=e.user_id AND s.business_date=e.day GROUP BY d.day
 ), filtered AS MATERIALIZED (
  SELECT *,NULLIF(value->>'model_name','') AS name,encode(sha256(convert_to(jsonb_build_array(model_source,NULLIF(value->>'model_name',''))::text,'UTF8')),'hex') AS key
  FROM visible WHERE scene=$6 AND client=$7
 ), cost_groups AS (
  SELECT key,NULLIF(value->>'currency','') AS currency,sum((value->>'amount')::numeric)::text AS known_amount,
   count(*) FILTER(WHERE value->>'amount' IS NULL OR NULLIF(value->>'currency','') IS NULL)::text AS unknown_amount_records,
   ${officialAmountReasonsSql}
  FROM filtered GROUP BY key,NULLIF(value->>'currency','')
 ), ranked_costs AS (SELECT *,row_number() OVER(PARTITION BY key ORDER BY currency) AS ordinal FROM cost_groups),
 costs AS (SELECT key,jsonb_agg(jsonb_build_object('currency',currency,'known_amount',known_amount,'unknown_amount_records',unknown_amount_records,'amount_missing_reasons',amount_missing_reasons) ORDER BY currency) AS values FROM ranked_costs WHERE ordinal<=201 GROUP BY key),
 grouped AS MATERIALIZED (
  SELECT key,name,model_source,count(*)::text AS records,count(DISTINCT user_id)::text AS users,
   COALESCE(sum((value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens,${officialTokenBreakdownSql},
   COALESCE(sum((value->>'model_call_count')::numeric),0)::text AS known_calls,count(*) FILTER(WHERE value->>'model_call_count' IS NULL)::text AS missing_calls,
   count(*) FILTER(WHERE jsonb_array_length(COALESCE(value->'quality','[]'::jsonb))>0)::text AS quality_records
  FROM filtered GROUP BY key,name,model_source
 ), page AS (SELECT g.*,COALESCE(c.values,'[]'::jsonb) AS costs FROM grouped g LEFT JOIN costs c USING(key) ORDER BY g.known_tokens::numeric DESC,g.key LIMIT $8 OFFSET $9),
 trend AS (
  SELECT d.day::text AS date,count(f.key)::text AS records,COALESCE(sum((f.value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,
   count(f.key) FILTER(WHERE f.value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens,
   COALESCE(sum((f.value->>'model_call_count')::numeric),0)::text AS known_calls,count(f.key) FILTER(WHERE f.value->>'model_call_count' IS NULL)::text AS missing_calls,
   d.expected_users,d.verified_users
  FROM daily_coverage d LEFT JOIN filtered f ON f.business_date=d.day AND ($10::text IS NULL OR f.key=$10) GROUP BY d.day,d.expected_users,d.verified_users
 ) SELECT (SELECT count(*)::text FROM grouped) AS total,
  COALESCE((SELECT jsonb_agg(p ORDER BY p.known_tokens::numeric DESC,p.key) FROM page p),'[]'::jsonb) AS items,
  COALESCE((SELECT jsonb_agg(t ORDER BY t.date) FROM trend t),'[]'::jsonb) AS trend,
  (SELECT jsonb_build_object('key',key,'name',name,'model_source',model_source) FROM grouped WHERE key=$10) AS selected,
  (SELECT jsonb_build_object('expected',COALESCE(sum(expected_users::bigint),0)::text,'verified',COALESCE(sum(verified_users::bigint),0)::text,'oldest',min(oldest_verified_at),'through',to_timestamp(max(through_second)+1)) FROM daily_coverage) AS coverage`;
 const row=(await db.query<{total:string;items:RawModel[];trend:RawTrend[];selected:Pick<RawModel,'key'|'name'|'model_source'>|null;coverage:{expected:string;verified:string;oldest:string|null;through:string|null}}>(sql,[...read.values,filter.scene,filter.client,page.limit,page.offset,filter.model_key??null])).rows[0]!;
 if(filter.model_key&&!row.selected)throw new DomainError('model_selection_missing',422);
 const expected=safeCount(row.coverage.expected),verified=safeCount(row.coverage.verified);
 return {...emptyModels(),configured:true,total:safeCount(row.total),items:row.items.map(model),trend:row.trend.map(trend),selected_model:row.selected,coverage:{expected_user_days:expected,verified_user_days:verified,missing_user_days:expected-verified,oldest_verified_at:row.coverage.oldest,query_through_at:row.coverage.through}};
}
