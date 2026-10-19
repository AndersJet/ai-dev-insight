import {createHash,randomUUID} from 'node:crypto';
import type {Database,Queryable} from '@adi/storage';
import {DomainError} from './errors.js';
import {SESSION_DERIVATION_VERSION} from './session-derivation.js';

export const TOKEN_CHECK_VERSION='token-quality-v1';
export type TokenCheckReason='official_source_unconfigured'|'official_source_incomplete'|'session_coverage_unknown'|'prediction_not_validated'|'trace_pending'|'trace_partial'|'trace_quality_issues'|'model_identity_unverified'|'multiple_models_unresolved';
export type TokenCheckResult={version:string;verdict:'insufficient_data';eligible:false;reasons:TokenCheckReason[];period:{from:string;to:string}};
type Source={session_id:string;user_id:string;active:boolean;run_id:string|null;source_key:string;result:TokenCheckResult};
type Claim={id:string;generation:number;lease:string;payload:{session_id:string}};
const uuid=(s:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
/** Trusted worker entry. User-facing reads must pass session authorization first.
 * This phase checks prerequisites only; it never interprets scenarios as validated
 * predictions, and does not claim that all-insufficient results finish screening. */
export function createSessionTokenChecks(db:Database,options:{providerAccount?:string;clock?:()=>Date;stopping?:()=>boolean}={}){
 const account=options.providerAccount??null,now=options.clock??(()=>new Date());let nextDiscovery=0;
 if(account!==null&&!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(account))throw new Error('Invalid usage provider account');
 const prefix=`token-check:${account??'-'}:`;
 const recentStart=()=>new Date(Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000-44*86400000);
 async function source(sql:Queryable,id:string):Promise<Source>{
  if(!uuid(id))throw new DomainError('not_found',404);
  const row=(await sql.query<{session_id:string;user_id:string;status:string;first_at:Date;last_at:Date;history_redacted:boolean;history_expired:boolean;cleanup_generation:number;ingest_epoch:number;dataset_id:string;recovery_id:string|null;run_id:string|null;source_generation:number|null;generation:number|null;quality:string[]|null;partial:boolean;models:number;scope_versions:unknown[];verified_days:number;link_versions:unknown[];owner_key:string}>(`SELECT s.id AS session_id,s.user_id,u.status,s.first_at,s.last_at,s.history_redacted,s.history_expired,u.cleanup_generation,u.ingest_epoch,d.dataset_id,d.recovery_id,r.id AS run_id,r.source_generation,j.generation,r.summary->'quality' AS quality,
   (s.first_at<$4 OR s.first_at<d.retention_cutoff OR EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=u.id AND t.from_at<=s.last_at AND t.to_at>s.first_at)) AS partial,
   (SELECT count(DISTINCT hook_model)::int FROM session_fragments WHERE run_id=r.id) AS models,
   coalesce(v.versions,'[]'::jsonb) AS scope_versions,coalesce(v.verified_days,0) AS verified_days,links.versions AS link_versions,
   encode(sha256(convert_to(jsonb_build_array(u.email_key,p.provider_user_id)::text,'UTF8')),'hex') AS owner_key
   FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN (SELECT dataset_id,recovery_id,retention_cutoff FROM data_identity WHERE singleton=true LIMIT 1) d
   LEFT JOIN jobs j ON j.kind='derive_session' AND j.dedupe_key='derive:'||s.id::text
   LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=u.id AND r.metric_version=$3 AND r.state='published' AND r.cleanup_generation=u.cleanup_generation
   LEFT JOIN usage_provider_identities p ON p.user_id=u.id AND p.provider_account=$2
   LEFT JOIN LATERAL (SELECT coalesce(jsonb_agg(jsonb_build_array(e.billing_session_id,e.provider_user_id,
     (SELECT count(*) FROM usage_attribution_evidence other WHERE other.provider_account=e.provider_account AND other.user_id=e.user_id AND other.billing_session_id=e.billing_session_id AND other.provider_user_id=p.provider_user_id AND other.cleanup_generation=u.cleanup_generation AND other.ingest_epoch=u.ingest_epoch)) ORDER BY e.billing_session_id),'[]'::jsonb) AS versions
     FROM usage_attribution_evidence e WHERE e.session_id=s.id AND e.user_id=u.id AND e.provider_account=$2 AND e.provider_user_id=p.provider_user_id AND e.cleanup_generation=u.cleanup_generation AND e.ingest_epoch=u.ingest_epoch) links ON true
   LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_array(c.id,c.revision,c.published_run_id,c.ready) ORDER BY c.business_date) AS versions,count(*) FILTER(WHERE c.ready)::int AS verified_days FROM (
     SELECT c.id,c.revision,c.published_run_id,c.business_date,coalesce(vr.data_run_id=c.published_run_id AND vr.state IN('published','unchanged') AND dr.state='published' AND vr.content_hash LIKE 'scope-v2:%' AND dr.content_hash LIKE 'scope-v2:%'
       AND (d.retention_cutoff IS NULL OR vr.from_second>=ceil(extract(epoch FROM d.retention_cutoff)))
       AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=c.user_id AND t.generation>vr.cleanup_generation AND t.from_at<to_timestamp(vr.to_second+1) AND t.to_at>to_timestamp(vr.from_second)),false) AS ready
     FROM usage_scopes c LEFT JOIN usage_snapshot_runs vr ON vr.id=c.verified_run_id LEFT JOIN usage_snapshot_runs dr ON dr.id=c.published_run_id
     WHERE c.provider_account=$2 AND c.user_id=u.id AND c.business_date>=(GREATEST(s.first_at,$4) AT TIME ZONE 'Asia/Shanghai')::date AND c.business_date<=(s.last_at AT TIME ZONE 'Asia/Shanghai')::date) c) v ON true
   WHERE s.id=$1`,[id,account,SESSION_DERIVATION_VERSION,recentStart()])).rows[0];
  if(!row)throw new DomainError('not_found',404);if(row.recovery_id)throw new DomainError('recovery_quarantined',503);
  const start=Math.floor((Math.max(row.first_at.getTime(),recentStart().getTime())+28800000)/86400000)*86400000-28800000;
  const end=Math.floor((row.last_at.getTime()+28800000)/86400000)*86400000-28800000+86400000;
  if(start>=end)throw new DomainError('token_check_expired',409);
  const reasons:TokenCheckReason[]=['session_coverage_unknown','prediction_not_validated'];
  if(!account)reasons.push('official_source_unconfigured');else if(row.verified_days<(end-start)/86400000)reasons.push('official_source_incomplete');
  if(!row.run_id||row.source_generation!==row.generation)reasons.push('trace_pending');
  if(row.partial||row.history_redacted||row.history_expired)reasons.push('trace_partial');
  if(row.quality?.length)reasons.push('trace_quality_issues');
  reasons.push(row.models>1?'multiple_models_unresolved':'model_identity_unverified');
  const result:TokenCheckResult={version:TOKEN_CHECK_VERSION,verdict:'insufficient_data',eligible:false,reasons,period:{from:new Date(start).toISOString(),to:new Date(end).toISOString()}};
  return {session_id:row.session_id,user_id:row.user_id,active:row.status==='active',run_id:row.run_id,source_key:createHash('sha256').update(JSON.stringify([account,row,result])).digest('hex'),result};
 }
 async function enqueue(id:string){
  const current=await source(db,id);
  if(!current.active)throw new DomainError('account_inactive',409);
  return (await db.query<{id:string}>(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'session_token_check',$2,$3)
   ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=clock_timestamp() RETURNING id`,[randomUUID(),prefix+current.session_id,{session_id:current.session_id,provider_account:account}])).rows[0]!.id;
 }
 async function read(id:string){
  const before=await source(db,id);
  const row=(await db.query<{source_key:string;checked_at:Date;result:TokenCheckResult}>('SELECT source_key,checked_at,result FROM session_token_checks WHERE session_id=$1 AND user_id=$2',[before.session_id,before.user_id])).rows[0];
  const job=(await db.query<{status:string;error_code:string|null;available_at:Date}>("SELECT status,error_code,available_at FROM jobs WHERE kind='session_token_check' AND dedupe_key=$1",[prefix+before.session_id])).rows[0];
  if(before.source_key!==(await source(db,id)).source_key)throw new DomainError('content_changed',409);
  const state=job?.status==='failed'?'failed' as const:job?.status==='queued'||job?.status==='running'?'pending' as const:!row?'not_checked' as const:row.source_key===before.source_key?'current' as const:'stale' as const;
  return {state,checked_at:row?.checked_at.toISOString()??null,source_version:row?.source_key??null,next_check_at:job&&job.status!=='cancelled'?job.available_at.toISOString():null,error_code:job?.error_code??null,result:state==='current'?row!.result:null};
 }
 async function runOne(){
  if(options.stopping?.())return false;
  await db.assertNotRecovering();
  const claim=await db.transaction(async sql=>{
   const row=(await sql.query<Omit<Claim,'lease'>>(`SELECT id,generation,payload FROM jobs WHERE kind='session_token_check' AND payload->>'provider_account' IS NOT DISTINCT FROM $1::text
    AND ((status IN('queued','succeeded','failed') AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp())) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[account])).rows[0];
   if(!row)return null;const lease=randomUUID();await sql.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',attempt=attempt+1 WHERE id=$1",[row.id,lease]);return {...row,lease};
  });if(!claim)return false;
  try{
   const before=await source(db,claim.payload.session_id);
   if(!before.active)throw new DomainError('account_inactive',409);
   await db.transaction(async sql=>{
    await sql.query('SELECT singleton FROM data_identity FOR SHARE');await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[before.user_id]);
    const fresh=await source(sql,before.session_id);if(fresh.source_key!==before.source_key)throw new DomainError('content_changed',409);
    const lease=await sql.query("SELECT id FROM jobs WHERE id=$1 AND generation=$2 AND lease_token=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",[claim.id,claim.generation,claim.lease]);if(!lease.rowCount)throw new DomainError('stale_token_check',409);
    await sql.query(`INSERT INTO session_token_checks(session_id,user_id,run_id,source_key,checked_at,result) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id,run_id=excluded.run_id,source_key=excluded.source_key,checked_at=excluded.checked_at,result=excluded.result WHERE session_token_checks.source_key<>excluded.source_key`,[fresh.session_id,fresh.user_id,fresh.run_id,fresh.source_key,now(),fresh.result]);
    await sql.query("UPDATE jobs SET status='succeeded',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '1 day' WHERE id=$1",[claim.id]);
   });
  }catch(error){const code=error instanceof DomainError?error.code:'token_check_failed';await db.query(`UPDATE jobs SET status=CASE WHEN generation<>$3 THEN 'queued' WHEN $4 IN('not_found','token_check_expired') THEN 'cancelled' ELSE 'failed' END,error_code=$4,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+(CASE WHEN generation<>$3 OR $4 IN('content_changed','stale_token_check') THEN interval '5 minutes' ELSE interval '1 day' END) WHERE id=$1 AND lease_token=$2 AND status='running'`,[claim.id,claim.lease,claim.generation,code]);}
  return true;
 }
 async function discoverRecent(){
  if(now().getTime()<nextDiscovery)return 0;nextDiscovery=now().getTime()+30000;
  // xmin is a same-statement conflict token only: a claim/completion after
  // candidate selection must not be replaced using an older checked-run view.
  const result=await db.query(`WITH candidates AS MATERIALIZED (
   SELECT s.id AS session_id,prior.xmin AS prior_xmin FROM sessions s JOIN users u ON u.id=s.user_id
   LEFT JOIN jobs prior ON prior.dedupe_key=$1||s.id::text
   LEFT JOIN session_token_checks checked ON checked.session_id=s.id AND checked.user_id=u.id
   LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=u.id
    AND r.state='published' AND r.metric_version=$4 AND r.cleanup_generation=u.cleanup_generation
   WHERE u.status='active' AND s.last_at>=$3 AND (prior.id IS NULL
    OR (prior.status='cancelled' AND prior.error_code='token_check_expired')
    OR (prior.status='succeeded' AND checked.session_id IS NOT NULL AND r.id IS NOT NULL AND checked.run_id IS DISTINCT FROM r.id))
   ORDER BY s.last_at DESC,s.id LIMIT 20
  ) INSERT INTO jobs(id,kind,dedupe_key,payload)
   SELECT gen_random_uuid(),'session_token_check',$1||session_id::text,jsonb_build_object('session_id',session_id,'provider_account',$2::text) FROM candidates
   ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status='queued',attempt=0,error_code=NULL,progress='{}',lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()
   WHERE jobs.kind='session_token_check' AND jobs.payload->>'provider_account' IS NOT DISTINCT FROM $2::text
    AND jobs.payload->>'session_id'=excluded.payload->>'session_id'
    AND jobs.xmin=(SELECT prior_xmin FROM candidates WHERE session_id::text=excluded.payload->>'session_id')
    AND ((jobs.status='cancelled' AND jobs.error_code='token_check_expired') OR (jobs.status='succeeded' AND EXISTS(
     SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
     JOIN session_token_checks checked ON checked.session_id=s.id AND checked.user_id=u.id
     JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=u.id
      AND r.state='published' AND r.metric_version=$4 AND r.cleanup_generation=u.cleanup_generation
     WHERE s.id::text=excluded.payload->>'session_id' AND u.status='active' AND s.last_at>=$3 AND checked.run_id IS DISTINCT FROM r.id
    )))`,[prefix,account,recentStart(),SESSION_DERIVATION_VERSION]);return result.rowCount??0;
 }
 async function status(id:string){if(!uuid(id))throw new DomainError('not_found',404);const row=(await db.query<{status:string;error_code:string|null;available_at:Date}>("SELECT status,error_code,available_at FROM jobs WHERE id=$1 AND kind='session_token_check' AND payload->>'provider_account' IS NOT DISTINCT FROM $2::text",[id,account])).rows[0];if(!row)throw new DomainError('not_found',404);return {...row,available_at:row.available_at.toISOString()};}
 return {enqueue,read,runOne,discoverRecent,status};
}
