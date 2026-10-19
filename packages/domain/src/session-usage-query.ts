import { officialTokenBreakdownSql, officialTokenBreakdown, type RawTokenBreakdown } from './official-token-breakdown.js';
import type {Database,Queryable,Transaction} from '@adi/storage';
import {DomainError} from './errors.js';
import type {ProviderUsageItem,ProviderUsagePage,TraeUsageProvider} from './usage-provider.js';
import {officialAmountReasonsSql,amountMissingReasons,type RawAmountMissingReasons} from './official-amount-reasons.js';
import type {OfficialUsageSummary} from './official-usage.js';

type Window={event_id:string;at:string;from:number;to:number;ids:string[];start_seconds:number[]};
type Bill={id:string;basis:'single_hook_query'|'stop_window';items:ProviderUsageItem[];observed_at:string;response_hash:string;request_id:string|null};
export type SessionQueryResult={windows:Window[];bills:Bill[];reasons:string[]};
export type SessionQueryContext={key:string;stops:{event_id:string;at:string}[];partial:boolean};
type MemberProgress={event_id:string;at:string;from:number;to:number;page:number;total:number|null;total_pages:number|null;rows:number;ids:string[];start_seconds:number[]};
export type SessionQueryProgress={context:SessionQueryContext;direct:ProviderUsagePage;result:SessionQueryResult;member:MemberProgress|null;queried_ids:string[];complete:boolean};
export async function sessionQueryContext(db:Queryable,session:string):Promise<SessionQueryContext>{
 const row=(await db.query<{key:string;stops:{event_id:string;at:string}[];partial:boolean}>(`SELECT md5(jsonb_build_array(s.first_at,s.last_at,s.history_redacted,s.history_expired,
  COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id,e.occurred_at,e.capture_generation) ORDER BY e.occurred_at,e.id) FROM hook_events e WHERE e.session_id=s.id),'[]'::jsonb))::text) AS key,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('event_id',e.id,'at',e.occurred_at) ORDER BY e.occurred_at,e.id) FROM hook_events e WHERE e.session_id=s.id AND e.event_type='Stop'),'[]'::jsonb) AS stops,
  (s.history_redacted OR s.history_expired OR COALESCE(s.first_at<d.retention_cutoff,false) OR EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.from_at<=s.last_at AND t.to_at>s.first_at)) AS partial
  FROM sessions s CROSS JOIN data_identity d WHERE s.id=$1`,[session])).rows[0];
 if(!row)throw new DomainError('not_found',404);return row;
}
const eligible=(row:ProviderUsageItem)=>row.scene==='Chat'&&(row.client==='ide'||!row.client)&&!!row.billing_session_id;
function validatePage(page:ProviderUsagePage,owner:string){
 if(!/^[a-f0-9]{64}$/.test(page.response_hash)||!Number.isFinite(Date.parse(page.observed_at))||page.items.length>5000)throw new DomainError('usage_evidence_invalid',422);
 if(page.items.some(row=>row.provider_user_id!==owner))throw new DomainError('usage_evidence_owner_mismatch',409);
}
/** Provider requests occur outside publisher locks. Member windows discover IDs;
 * only session responses become quantities. These never enter the person-day ledger. */
export function startSessionQuery(context:SessionQueryContext,direct:ProviderUsagePage,previous?:SessionQueryProgress):SessionQueryProgress{
 const progress:SessionQueryProgress={context,direct,result:{windows:[],bills:[],reasons:[]},member:null,queried_ids:[],complete:false};
 if(context.partial){progress.result.reasons=['trace_partial'];progress.complete=true;return progress;}
 const ids=[...new Set(direct.items.filter(eligible).map(row=>row.billing_session_id!))];
 if(ids.length){progress.result.bills=ids.map(id=>({id,basis:'single_hook_query',items:direct.items.filter(row=>eligible(row)&&row.billing_session_id===id),observed_at:direct.observed_at,response_hash:direct.response_hash,request_id:direct.request_id}));progress.complete=true;return progress;}
 if(!context.stops.length){progress.result.reasons=['no_stop'];progress.complete=true;return progress;}
 // Reuse only completed windows from the same unfinished round when inputs grow.
 // A newly scheduled periodic round starts from scratch to detect late candidates.
 if(previous&&!previous.complete&&!previous.context.partial&&previous.context.stops.every(old=>context.stops.some(s=>s.event_id===old.event_id&&s.at===old.at))){
  progress.result.windows=previous.result.windows.filter(w=>context.stops.some(s=>s.event_id===w.event_id&&s.at===w.at));
  const found=new Set(progress.result.windows.filter(w=>w.ids.length===1).map(w=>w.ids[0]!));
  progress.queried_ids=previous.queried_ids.filter(id=>found.has(id));
  progress.result.bills=previous.result.bills.filter(b=>b.basis==='stop_window'&&found.has(b.id));
 }
 return progress;
}
function finishProgress(progress:SessionQueryProgress){
 const {result}=progress;
 result.reasons=[...new Set(result.windows.flatMap(w=>w.ids.length===0?['no_candidate']:w.ids.length>1?['multiple_candidates']:[]))];
 if(progress.queried_ids.some(id=>!result.bills.some(b=>b.id===id)))result.reasons.push('session_response_empty');
 progress.complete=result.windows.length===progress.context.stops.length&&result.windows.every(w=>w.ids.length!==1||progress.queried_ids.includes(w.ids[0]!));
}
/** One source request per step, including a single member page. */
export async function advanceSessionQuery(progress:SessionQueryProgress,owner:string,provider:Pick<TraeUsageProvider,'getMemberUsage'|'getSessionUsage'>,beforeRequest:()=>Promise<void>=async()=>{}){
 if(progress.complete)return;
 const bill=progress.result.windows.find(w=>w.ids.length===1&&!progress.queried_ids.includes(w.ids[0]!));
 if(bill){
  const id=bill.ids[0]!;await beforeRequest();const response=await provider.getSessionUsage(id);validatePage(response,owner);
  const q=response.query.parameters;if(response.query.endpoint!=='session_usage_detail'||!('session_ids'in q)||q.session_ids.length!==1||q.session_ids[0]!==id)throw new DomainError('usage_evidence_scope_mismatch',409);
  if(response.pagination&&(response.pagination.page!==1||response.pagination.total!==response.items.length||response.pagination.total_pages>1))throw new DomainError('usage_evidence_partial',409);
  if(response.items.some(r=>!eligible(r)||r.client!=='ide'||r.billing_session_id!==id||r.model_source!=='Trae'))throw new DomainError('usage_evidence_scope_mismatch',409);
  progress.queried_ids.push(id);
  if(response.items.length)progress.result.bills.push({id,basis:'stop_window',items:response.items,observed_at:response.observed_at,response_hash:response.response_hash,request_id:response.request_id});
 }else{
  const stop=progress.context.stops.find(s=>!progress.result.windows.some(w=>w.event_id===s.event_id));
  if(!stop){finishProgress(progress);return;}
  const second=Math.floor(Date.parse(stop.at)/1000);
  const member=progress.member??{event_id:stop.event_id,at:stop.at,from:second-1,to:second+1,page:1,total:null,total_pages:null,rows:0,ids:[],start_seconds:[]};
  await beforeRequest();const response=await provider.getMemberUsage({start_time:member.from,end_time:member.to,user_ids:[owner],page:member.page,page_size:200});validatePage(response,owner);
  const q=response.query.parameters;if(response.query.endpoint!=='user_usage_detail'||!('start_time'in q)||q.start_time!==member.from||q.end_time!==member.to||q.user_ids?.length!==1||q.user_ids[0]!==owner||q.page!==member.page)throw new DomainError('usage_evidence_scope_mismatch',409);
  const pagination=response.pagination;
  if(!pagination||pagination.page!==member.page||pagination.total_pages>25||pagination.total>5000||(member.total!==null&&(member.total!==pagination.total||member.total_pages!==pagination.total_pages)))throw new DomainError('usage_evidence_partial',409);
  if(response.items.some(r=>r.start_time===null||BigInt(r.start_time)<BigInt(member.from)||BigInt(r.start_time)>BigInt(member.to)))throw new DomainError('usage_evidence_scope_mismatch',409);
  member.total=pagination.total;member.total_pages=pagination.total_pages;member.rows+=response.items.length;
  if(member.rows>5000)throw new DomainError('usage_evidence_limit',409);
  const candidates=response.items.filter(r=>eligible(r)&&r.client==='ide'&&r.model_source==='Trae');
  member.ids=[...new Set([...member.ids,...candidates.map(r=>r.billing_session_id!)])];member.start_seconds.push(...candidates.map(r=>Number(r.start_time)));
  if(member.page>=pagination.total_pages){
   if(member.rows!==pagination.total)throw new DomainError('usage_evidence_partial',409);
   progress.result.windows.push({event_id:member.event_id,at:member.at,from:member.from,to:member.to,ids:member.ids,start_seconds:member.start_seconds});progress.member=null;
  }else{member.page++;progress.member=member;}
 }
 finishProgress(progress);
}
export async function prepareSessionQuery(context:SessionQueryContext,owner:string,direct:ProviderUsagePage,provider:Pick<TraeUsageProvider,'getMemberUsage'|'getSessionUsage'>,beforeRequest:()=>Promise<void>=async()=>{}):Promise<SessionQueryResult>{
 const progress=startSessionQuery(context,direct);
 while(!progress.complete)await advanceSessionQuery(progress,owner,provider,beforeRequest);
 return progress.result;
}
export async function publishSessionQuery(client:Transaction,account:string,session:string,owner:{user_id:string;provider_user_id:string|null;cleanup_generation:number;ingest_epoch:number},context:SessionQueryContext,result:SessionQueryResult,observedAt:string){
 await client.query('SET LOCAL jit=off');
 if((await sessionQueryContext(client,session)).key!==context.key)throw new DomainError('stale_session_query',409);
 await client.query(`INSERT INTO session_usage_queries(provider_account,session_id,user_id,provider_user_id,cleanup_generation,ingest_epoch,hook_key,observed_at,result)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_account,session_id) DO UPDATE SET provider_user_id=excluded.provider_user_id,cleanup_generation=excluded.cleanup_generation,ingest_epoch=excluded.ingest_epoch,hook_key=excluded.hook_key,observed_at=excluded.observed_at,result=excluded.result,revision=session_usage_queries.revision+1`,[account,session,owner.user_id,owner.provider_user_id,owner.cleanup_generation,owner.ingest_epoch,context.key,observedAt,result]);
}
type Group=OfficialUsageSummary['groups'][number]&{model_name:string|null};
export async function readSessionQuery(db:Database,account:string,session:string,user:string,reader:{userId:string;super:boolean}){
 return db.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');await client.query('SET LOCAL jit=off');return readSessionQuerySnapshot(client,account,session,user,reader);});
}

/** Batch network round trips while retaining the original EXISTS early exits
 * and every same-owner competitor, including sessions outside the current page. */
async function competingBills(db: Queryable, account: string, session: string, user: string, result: SessionQueryResult) {
 const claimed = new Set<string>(), overlapping = new Set<string>();
 const secondsByBill = new Map<string, number[]>();
 for (const window of result.windows) {
  if (window.ids.length !== 1) continue;
  const id = window.ids[0]!;
  let seconds = secondsByBill.get(id);
  if (!seconds) { seconds = []; secondsByBill.set(id, seconds); }
  seconds.push(...window.start_seconds);
 }
 // Batching is not truncation: even large histories retain all bill/window inputs.
 const batchSize = 128;
 for (let offset = 0; offset < result.bills.length; offset += batchSize) {
  const bills = result.bills.slice(offset, offset + batchSize);
  const conflicts = await db.query<{ id: string }>(`SELECT target.id FROM unnest($4::text[]) target(id)
   WHERE EXISTS(SELECT 1 FROM session_usage_queries q JOIN users u ON u.id=q.user_id JOIN sessions s ON s.id=q.session_id
    WHERE q.provider_account=$1 AND q.user_id=$3 AND q.session_id<>$2 AND q.cleanup_generation=u.cleanup_generation AND q.ingest_epoch=u.ingest_epoch
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.result->'bills') b WHERE b->>'id'=target.id)
    AND NOT s.history_redacted AND NOT s.history_expired
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.from_at<=s.last_at AND t.to_at>s.first_at))`,
  [account, session, user, bills.map(bill => bill.id)]);
  for (const row of conflicts.rows) claimed.add(row.id);
  const windows = bills.filter(bill => bill.basis === 'stop_window').map(bill => ({ id: bill.id, seconds: secondsByBill.get(bill.id) ?? [] }));
  if (!windows.some(window => window.seconds.length)) continue;
  const competitors = await db.query<{ id: string }>(`SELECT target.id FROM jsonb_to_recordset($3::jsonb) target(id text, seconds bigint[])
   WHERE EXISTS(SELECT 1 FROM sessions s CROSS JOIN data_identity d
    WHERE s.user_id=$1 AND s.id<>$2 AND NOT s.history_redacted AND NOT s.history_expired
    AND EXISTS(SELECT 1 FROM unnest(target.seconds) n WHERE n BETWEEN floor(extract(epoch FROM s.first_at)) AND floor(extract(epoch FROM s.last_at)))
    AND EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id=s.id AND (d.retention_cutoff IS NULL OR e.occurred_at>=d.retention_cutoff)
     AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)))`,
  [user, session, JSON.stringify(windows)]);
  for (const row of competitors.rows) overlapping.add(row.id);
 }
 return { claimed, overlapping };
}

async function readSessionQuerySnapshot(db:Queryable,account:string,session:string,user:string,reader:{userId:string;super:boolean}):Promise<{groups:Group[];state:'ready'|'partial'|'pending';reasons:string[];observed_at:string;billing_ids:string[];revision:string}|null>{
 if(reader.userId!==user&&!reader.super)throw new DomainError('not_found',404);
 const row=(await db.query<{result:SessionQueryResult;hook_key:string;observed_at:Date;revision:string;probe_state:string|null}>(`SELECT q.result,q.hook_key,q.observed_at,q.revision::text,a.probe_state FROM session_usage_queries q JOIN users u ON u.id=q.user_id
 JOIN usage_provider_identities p ON p.user_id=q.user_id AND p.provider_account=q.provider_account AND p.provider_user_id=q.provider_user_id LEFT JOIN usage_attribution_subjects a ON a.provider_account=q.provider_account AND a.session_id=q.session_id CROSS JOIN data_identity d
 WHERE q.provider_account=$1 AND q.session_id=$2 AND q.user_id=$3 AND q.cleanup_generation=u.cleanup_generation AND (q.ingest_epoch=u.ingest_epoch OR $4::boolean)
 AND d.recovery_id IS NULL`,[account,session,user,reader.super||reader.userId===user])).rows[0];
 if(!row)return null;const context=await sessionQueryContext(db,session),reasons=[...row.result.reasons];if(row.probe_state==='failed')reasons.push('query_failed');
 if(context.partial||context.key!==row.hook_key)return {groups:[],state:'pending',reasons:[context.partial?'trace_partial':'new_hook_events'],observed_at:row.observed_at.toISOString(),billing_ids:[],revision:row.revision};
 const { claimed, overlapping } = await competingBills(db, account, session, user, row.result);
 const safe:Bill[]=[];
 for(const bill of row.result.bills){
  if(claimed.has(bill.id)||(bill.basis==='stop_window'&&overlapping.has(bill.id))){reasons.push('competing_hook_sessions');continue;}safe.push(bill);
 }
 type Raw=RawTokenBreakdown&{model_name:string|null;client:'ide'|'unspecified';model_source:'Trae'|'Custom'|'unknown';consumption_source:Group['consumption_source'];currency:string|null;records:string;known_tokens:string;missing_tokens:string;known_calls:string;missing_calls:string;known_amount:string|null;missing_amount:string;amount_missing_reasons:RawAmountMissingReasons;quality_records:string};
 const groups=(await db.query<Raw>(`WITH records AS(SELECT value FROM jsonb_array_elements($1::jsonb) value) SELECT NULLIF(value->>'model_name','') AS model_name,
 CASE WHEN value->>'client'='ide' THEN 'ide' ELSE 'unspecified' END AS client,CASE WHEN value->>'model_source' IN('Trae','Custom') THEN value->>'model_source' ELSE 'unknown' END AS model_source,
 CASE WHEN value->>'consumption_source' IN('basic','pay_go','mixed','enterprise_builtin') THEN value->>'consumption_source' ELSE 'unknown' END AS consumption_source,NULLIF(value->>'currency','') AS currency,
 count(*)::text AS records,COALESCE(sum((value->'usage'->>'total_tokens')::numeric),0)::text AS known_tokens,count(*) FILTER(WHERE value->'usage'->>'total_tokens' IS NULL)::text AS missing_tokens,${officialTokenBreakdownSql},
 COALESCE(sum((value->>'model_call_count')::numeric),0)::text AS known_calls,count(*) FILTER(WHERE value->>'model_call_count' IS NULL)::text AS missing_calls,
 sum((value->>'amount')::numeric)::text AS known_amount,count(*) FILTER(WHERE value->>'amount' IS NULL OR NULLIF(value->>'currency','') IS NULL)::text AS missing_amount,${officialAmountReasonsSql},count(*) FILTER(WHERE jsonb_array_length(value->'quality')>0)::text AS quality_records
 FROM records GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`,[JSON.stringify(safe.flatMap(b=>b.items))])).rows.map(r=>({...r,token_breakdown:officialTokenBreakdown(r),scene:'Chat' as const,records:Number(r.records),tokens:r.missing_tokens==='0'?r.known_tokens:null,missing_token_records:Number(r.missing_tokens),calls:r.missing_calls==='0'?r.known_calls:null,missing_call_records:Number(r.missing_calls),amount:r.missing_amount==='0'&&r.currency?r.known_amount:null,known_amount:r.currency?r.known_amount:null,unknown_amount_records:Number(r.missing_amount),amount_missing_reasons:amountMissingReasons(r.amount_missing_reasons),quality_records:Number(r.quality_records)}));
 if(groups.length>200)throw new DomainError('metric_overflow',503);
 return {groups,state:reasons.length?(safe.length?'partial':'pending'):'ready',reasons:[...new Set(reasons)],observed_at:row.observed_at.toISOString(),billing_ids:safe.map(b=>b.id),revision:row.revision};
}

/** Shared read relation for session lists; no quantities are added to day totals.
 * The enclosing list supplies matched(id,user_id). Restrict output queries
 * before expanding JSON, but retain every other session in conflict checks.
 */
export function sessionQueryRowsSql(account:string,authorizedHistory:string){
 return `WITH target_queries AS MATERIALIZED (
  SELECT q.* FROM session_usage_queries q JOIN matched target ON target.id=q.session_id AND target.user_id=q.user_id WHERE q.provider_account=${account}
 ), owner_query_claims AS MATERIALIZED (
  SELECT other.session_id,other.user_id,b.value->>'id' AS billing_id FROM session_usage_queries other
  JOIN (SELECT DISTINCT user_id FROM target_queries) owners ON owners.user_id=other.user_id
  JOIN users ou ON ou.id=other.user_id JOIN sessions os ON os.id=other.session_id
  CROSS JOIN LATERAL jsonb_array_elements(other.result->'bills') b(value)
  WHERE other.provider_account=${account} AND other.cleanup_generation=ou.cleanup_generation AND other.ingest_epoch=ou.ingest_epoch
   AND NOT os.history_redacted AND NOT os.history_expired
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=os.user_id AND t.from_at<=os.last_at AND t.to_at>os.first_at)
 ), eligible_queries AS MATERIALIZED (
  SELECT q.session_id,q.user_id,q.provider_account,q.result,qd.retention_cutoff,
   (SELECT CASE WHEN count(DISTINCT e.department_id)=1 AND count(*) FILTER(WHERE e.department_id IS NULL)=0 THEN min(e.department_id::text)::uuid END FROM hook_events e WHERE e.session_id=q.session_id) AS department_id
  FROM target_queries q JOIN sessions qs ON qs.id=q.session_id JOIN users qu ON qu.id=q.user_id
  JOIN usage_provider_identities qp ON qp.provider_account=q.provider_account AND qp.user_id=q.user_id AND qp.provider_user_id=q.provider_user_id CROSS JOIN data_identity qd
  WHERE q.provider_account=${account} AND q.cleanup_generation=qu.cleanup_generation AND (q.ingest_epoch=qu.ingest_epoch OR ${authorizedHistory}) AND qd.recovery_id IS NULL
   AND NOT qs.history_redacted AND NOT qs.history_expired AND (qd.retention_cutoff IS NULL OR qs.first_at>=qd.retention_cutoff)
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=q.user_id AND t.from_at<=qs.last_at AND t.to_at>qs.first_at)
   AND q.hook_key=md5(jsonb_build_array(qs.first_at,qs.last_at,qs.history_redacted,qs.history_expired,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id,e.occurred_at,e.capture_generation) ORDER BY e.occurred_at,e.id) FROM hook_events e WHERE e.session_id=qs.id),'[]'::jsonb))::text)
 ), safe_bills AS MATERIALIZED (
  SELECT q.session_id,q.user_id,q.department_id,bill.value FROM eligible_queries q
  CROSS JOIN LATERAL jsonb_array_elements(q.result->'bills') bill(value)
  WHERE NOT EXISTS(SELECT 1 FROM owner_query_claims other
   WHERE other.user_id=q.user_id AND other.session_id<>q.session_id AND other.billing_id=bill.value->>'id')
   AND (bill.value->>'basis'='single_hook_query' OR NOT EXISTS(SELECT 1 FROM sessions other WHERE other.user_id=q.user_id AND other.id<>q.session_id AND NOT other.history_redacted AND NOT other.history_expired
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.result->'windows') w CROSS JOIN LATERAL jsonb_array_elements_text(w->'start_seconds') n
     WHERE jsonb_array_length(w->'ids')=1 AND w->'ids'->>0=bill.value->>'id' AND n::bigint BETWEEN floor(extract(epoch FROM other.first_at)) AND floor(extract(epoch FROM other.last_at)))
    AND EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id=other.id AND (q.retention_cutoff IS NULL OR e.occurred_at>=q.retention_cutoff)
     AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))))
 ) SELECT q.session_id,q.user_id,item.value,q.department_id FROM safe_bills q
 CROSS JOIN LATERAL jsonb_array_elements(q.value->'items') item(value) WHERE true`;
}
