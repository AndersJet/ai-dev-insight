import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@adi/storage';
import { DomainError } from './errors.js';
import { UsageProviderError, type TraeUsageProvider, type MemberModelUsageQuery, type ProviderModelUsagePage } from './usage-provider.js';

type Quantity={input_tokens:string|null;output_tokens:string|null};
type Model=Quantity&{model_name:string|null;model_source:string|null;model_type:string|null};
type Window={start_time:number;end_time:number};
type Evidence=Window&{response_hash:string;request_id:string|null;observed_at:string};
export type ModelCheckResult={state:'matched'|'cohort_matched'|'difference'|'not_comparable';reason:string|null;groups:{model_source:string;model_type:string;detail:Quantity;official:Quantity;models_comparable:boolean}[];group_count:number;truncated:boolean;windows:Window[];evidence:Evidence[]};
export const modelCheckOwnerSql="encode(sha256(convert_to(jsonb_build_array(u.email_key,p.provider_user_id,u.ingest_epoch,d.dataset_id)::text,'UTF8')),'hex')";
type Context={owner_key:string;scope_id:string;user_id:string;email:string;provider_user_id:string|null;published_run_id:string;revision:number;cleanup_generation:number;key:string;windows:Window[]};
type Progress={cleanup_generation?:number;key?:string;part?:number;models?:Model[];evidence?:Evidence[];missing_member?:boolean};
type Claim={id:string;generation:number;attempt:number;lease:string;payload:{user_id:string;business_date:string};progress:Progress;previous_status:string};
const uuid=(s:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const add=(a:string|null,b:string|null)=>a===null||b===null?null:String(BigInt(a)+BigInt(b));
function combine(rows:Model[],withName:boolean){
 const grouped=new Map<string,Model>();
 for(const row of rows){const key=JSON.stringify([row.model_source,row.model_type,...(withName?[row.model_name]:[])]),prior=grouped.get(key);grouped.set(key,prior?{...prior,input_tokens:add(prior.input_tokens,row.input_tokens),output_tokens:add(prior.output_tokens,row.output_tokens)}:{...row});}
 return grouped;
}
function compare(detail:Model[],official:Model[],windows:Window[],evidence:Evidence[],missingMember:boolean):ModelCheckResult{
 const unavailableOfficial=missingMember||official.length===0;
 const invalid=unavailableOfficial||[...detail,...official].some(row=>!row.model_source||!row.model_type||!row.model_name||row.input_tokens===null||row.output_tokens===null);
 const d=combine(detail,false),o=combine(official,false),dn=combine(detail,true),on=combine(official,true);
 let difference=false,namesDiffer=false,groupsMissing=false;
 const groups=[...new Set([...d.keys(),...o.keys()])].sort().map(key=>{
  const left=d.get(key),right=o.get(key),model=left??right!,missing={input_tokens:null,output_tokens:null};
  groupsMissing ||= !left||!right;
  const a=left??missing,b=right??missing;const prefix=JSON.parse(key) as string[];
  const names=(values:Map<string,Model>)=>[...values].filter(([,row])=>row.model_source===prefix[0]&&row.model_type===prefix[1]).map(([name])=>name).sort();
  const modelsComparable=JSON.stringify(names(dn))===JSON.stringify(names(on));namesDiffer ||= !modelsComparable;
  difference ||= a.input_tokens!==b.input_tokens||a.output_tokens!==b.output_tokens;
  if(modelsComparable)for(const name of names(dn)){const x=dn.get(name)!,y=on.get(name)!;difference ||= x.input_tokens!==y.input_tokens||x.output_tokens!==y.output_tokens;}
  return {model_source:model.model_source??'',model_type:model.model_type??'',detail:{input_tokens:a.input_tokens,output_tokens:a.output_tokens},official:{input_tokens:unavailableOfficial?null:b.input_tokens,output_tokens:unavailableOfficial?null:b.output_tokens},models_comparable:modelsComparable};
 });
 return {state:invalid?'not_comparable':difference?'difference':namesDiffer?'cohort_matched':'matched',reason:missingMember?'member_not_returned':official.length===0?'no_model_usage':invalid?'missing_dimensions_or_tokens':groupsMissing?'model_group_not_returned':namesDiffer?'model_names_differ':null,groups:groups.slice(0,20),group_count:groups.length,truncated:groups.length>20,windows,evidence};
}
/** Trusted worker seam. Browser readers must enforce their own member/organization scope. */
export function createUsageModelChecks(db:Database,options:{providerAccount:string;clock?:()=>Date;provider?:Pick<TraeUsageProvider,'getMemberModelUsage'>;stopping?:()=>boolean;onRateLimit?:(seconds:number)=>Promise<void>}){
 const account=options.providerAccount,now=options.clock??(()=>new Date());let nextDiscovery=0;
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(account))throw new Error('Invalid usage provider account');
 function validate(user:string,date:string){const start=Date.parse(`${date}T00:00:00+08:00`);if(!uuid(user)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(start)||new Date(start+28800000).toISOString().slice(0,10)!==date||start+86400000>now().getTime()||start+86400000<=now().getTime()-365*86400000)throw new DomainError('invalid_usage_day',422);}
 async function context(sql:Transaction,user:string,date:string,lock=false):Promise<Context>{
  validate(user,date);
  if(lock){await sql.query('SELECT singleton FROM data_identity FOR SHARE');await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);await sql.query('SELECT id FROM usage_scopes WHERE provider_account=$1 AND user_id=$2 AND business_date=$3 FOR UPDATE',[account,user,date]);}
  const row=(await sql.query<{id:string;owner_key:string;status:string;email:string;provider_user_id:string|null;published_run_id:string|null;verified_run_id:string|null;revision:number;cleanup_generation:number;ingest_epoch:number;dataset_id:string;recovery_id:string|null;cutoff:string|null;valid:boolean;source_owner_valid:boolean;invalidated:boolean}>(`SELECT s.id,${modelCheckOwnerSql} AS owner_key,u.status,u.email_key AS email,p.provider_user_id,s.published_run_id,s.verified_run_id,s.revision,u.cleanup_generation,u.ingest_epoch,d.dataset_id,d.recovery_id,ceil(extract(epoch FROM d.retention_cutoff))::text AS cutoff,
   (r.content_hash LIKE 'scope-v2:%' AND v.content_hash LIKE 'scope-v2:%') AS valid,
   CASE WHEN COALESCE(v.observed_provider_user_id,v.requested_provider_user_id) IS NOT NULL THEN COALESCE(v.observed_provider_user_id,v.requested_provider_user_id)=p.provider_user_id ELSE v.captured_email=u.email_key END AS source_owner_valid,
   EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=u.id AND t.generation>v.cleanup_generation AND t.from_at<to_timestamp(v.to_second+1) AND t.to_at>to_timestamp(v.from_second)) AS invalidated
   FROM usage_scopes s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d
   LEFT JOIN usage_provider_identities p ON p.user_id=u.id AND p.provider_account=s.provider_account
   LEFT JOIN usage_snapshot_runs r ON r.id=s.published_run_id LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id
   WHERE s.provider_account=$1 AND s.user_id=$2 AND s.business_date=$3`,[account,user,date])).rows[0];
  if(!row)throw new DomainError('usage_source_unavailable',409);
  if(row.recovery_id)throw new DomainError('recovery_quarantined',503);
  if(row.status!=='active')throw new DomainError('account_inactive',409);
  if(!row.published_run_id||!row.verified_run_id||!row.valid||!row.source_owner_valid||row.invalidated)throw new DomainError('usage_source_unavailable',409);
  const parts=(await sql.query<{start_second:string;end_second:string}>('SELECT start_second::text,end_second::text FROM usage_snapshot_parts WHERE run_id=$1 ORDER BY part',[row.verified_run_id])).rows;
  const windows=parts.map(part=>({start_time:Number(part.start_second),end_time:Number(part.end_second)}));
  if(!windows.length||windows.length>64||windows.some((part,i)=>!Number.isSafeInteger(part.start_time)||!Number.isSafeInteger(part.end_time)||part.start_time>part.end_time||(i>0&&part.start_time<=windows[i-1]!.end_time)||(row.cutoff!==null&&part.start_time<Number(row.cutoff))))throw new DomainError('usage_source_unavailable',409);
  const key=hash([row.dataset_id,row.id,row.published_run_id,row.revision,row.cleanup_generation,row.ingest_epoch,row.email,row.provider_user_id,windows]);
  return {owner_key:row.owner_key,scope_id:row.id,user_id:user,email:row.email,provider_user_id:row.provider_user_id,published_run_id:row.published_run_id,revision:row.revision,cleanup_generation:row.cleanup_generation,key,windows};
 }
 async function enqueue(user:string,date:string){
  validate(user,date);user=user.toLowerCase();await context(db,user,date);
  return (await db.query<{id:string}>(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'usage_model_check',$2,$3)
   ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,progress='{}',attempt=0,error_code=NULL,available_at=clock_timestamp() RETURNING id`,[randomUUID(),`usage-model:${account}:${user}:${date}`,{provider_account:account,user_id:user,business_date:date}])).rows[0]!.id;
 }
 async function discoverRecent(){
  if(now().getTime()<nextDiscovery)return 0;nextDiscovery=now().getTime()+30000;
  const today=Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000;
  const found=await db.query(`INSERT INTO jobs(id,kind,dedupe_key,payload)
   SELECT gen_random_uuid(),'usage_model_check','usage-model:'||$1||':'||s.user_id::text||':'||s.business_date::text,
    jsonb_build_object('provider_account',$1::text,'user_id',s.user_id::text,'business_date',s.business_date::text)
   FROM usage_scopes s JOIN users u ON u.id=s.user_id
   LEFT JOIN jobs j ON j.dedupe_key='usage-model:'||$1||':'||s.user_id::text||':'||s.business_date::text
   LEFT JOIN usage_model_checks c ON c.scope_id=s.id
   WHERE s.provider_account=$1 AND u.status='active' AND s.published_run_id IS NOT NULL AND s.verified_run_id IS NOT NULL
    AND (s.business_date>=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date OR j.id IS NOT NULL) AND s.business_date<($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    AND (j.id IS NULL OR (j.status='failed' AND j.error_code='account_inactive') OR (j.status IN('succeeded','failed') AND c.source_revision<>s.revision AND c.checked_at<=$4))
   ORDER BY s.business_date DESC,s.id LIMIT 20
   ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status='queued',attempt=0,error_code=NULL,progress='{}',available_at=clock_timestamp()
   WHERE jobs.status IN('succeeded','failed') RETURNING id`,[account,new Date(today-44*86400000),new Date(today),new Date(now().getTime()-3600000)]);
  return found.rowCount??0;
 }
 async function assertLease(sql:Transaction,claim:Claim){if(!(await sql.query("SELECT 1 FROM jobs WHERE id=$1 AND generation=$2 AND lease_token=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",[claim.id,claim.generation,claim.lease])).rowCount)throw new DomainError('stale_usage_job',409);}
 function validateResponse(response:ProviderModelUsagePage,query:MemberModelUsageQuery,ctx:Context){
  if(response.query.endpoint!=='user-model-usage'||hash(response.query.parameters)!==hash(query)||!Number.isFinite(Date.parse(response.observed_at))||!/^[a-f0-9]{64}$/.test(response.response_hash)||response.pagination!==null)throw new DomainError('usage_model_scope_mismatch',409);
  if(response.items.length>1)throw new DomainError('usage_model_owner_mismatch',409);
  const member=response.items[0];if(!member)return null;
  if(ctx.provider_user_id?member.provider_user_id!==ctx.provider_user_id:member.email!==ctx.email)throw new DomainError('usage_model_owner_mismatch',409);
  if(!member.provider_user_id||member.model_usage.length>5000)throw new DomainError('usage_model_response_limit',409);
  return member.model_usage.map(model=>({model_name:model.model_name,model_source:model.model_source,model_type:model.model_type,input_tokens:model.usage.input_tokens,output_tokens:model.usage.output_tokens}));
 }
 async function runOne(){
  if(options.stopping?.())return false;
  const claim=await db.transaction(async sql=>{
   const row=(await sql.query<Omit<Claim,'lease'>>(`SELECT id,generation,attempt,payload,progress,status AS previous_status FROM jobs WHERE kind='usage_model_check' AND payload->>'provider_account'=$1
    AND NOT EXISTS(SELECT 1 FROM usage_provider_control WHERE provider_account=$1 AND paused_until>clock_timestamp())
    AND ((status IN('queued','succeeded','failed') AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp()))
    ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[account])).rows[0];
   if(!row)return null;const lease=randomUUID(),attempt=row.previous_status==='failed'?1:row.attempt+1;await sql.query("UPDATE jobs SET status='running',attempt=$3,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",[row.id,lease,attempt]);return {...row,attempt,lease};
  });
  if(!claim)return false;
  try{
   if(!options.provider)throw new DomainError('usage_provider_unconfigured',503);
   const ctx=await context(db,claim.payload.user_id,claim.payload.business_date),progress:Progress=claim.progress.key===ctx.key?claim.progress:{};
   const part=progress.part??0,window=ctx.windows[part];if(!window)throw new DomainError('usage_model_checkpoint_invalid',409);
   const query={...window,...(ctx.provider_user_id?{user_ids:[ctx.provider_user_id]}:{emails:[ctx.email]})};
   const response=await options.provider.getMemberModelUsage(query);if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);
   const models=validateResponse(response,query,ctx),merged=[...combine([...(progress.models??[]),...(models??[])],true).values()];
   const evidence=[...(progress.evidence??[]),{...window,response_hash:response.response_hash,request_id:response.request_id,observed_at:response.observed_at}];
   const next:Progress={cleanup_generation:ctx.cleanup_generation,key:ctx.key,part:part+1,models:merged,evidence,missing_member:progress.missing_member||models===null};
   if(merged.length>5000||Buffer.byteLength(JSON.stringify(next))>4*1024*1024)throw new DomainError('usage_model_response_limit',409);
   await db.transaction(async sql=>{
    const current=await context(sql,ctx.user_id,claim.payload.business_date,true);if(current.key!==ctx.key)throw new DomainError('usage_model_source_changed',409);await assertLease(sql,claim);
    if(part+1<ctx.windows.length){await sql.query("UPDATE jobs SET status='queued',attempt=0,progress=$2,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp(),error_code=NULL WHERE id=$1",[claim.id,next]);return;}
    const rows=(await sql.query<Model>(`SELECT value->>'model_name' AS model_name,value->>'model_source' AS model_source,value->>'model_type' AS model_type,
     CASE WHEN count(*) FILTER(WHERE value->'usage'->>'prompt_tokens' IS NULL)>0 THEN NULL ELSE sum((value->'usage'->>'prompt_tokens')::numeric)::text END AS input_tokens,
     CASE WHEN count(*) FILTER(WHERE value->'usage'->>'completion_tokens' IS NULL)>0 THEN NULL ELSE sum((value->'usage'->>'completion_tokens')::numeric)::text END AS output_tokens
     FROM usage_observations WHERE run_id=$1 GROUP BY 1,2,3 LIMIT 5001`,[ctx.published_run_id])).rows;
    if(rows.length>5000)throw new DomainError('usage_model_response_limit',409);
    const result=compare(rows,merged,ctx.windows,evidence,!!next.missing_member);
    await sql.query('INSERT INTO usage_model_checks(scope_id,source_key,source_revision,cleanup_generation,checked_at,result,owner_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(scope_id) DO UPDATE SET source_key=excluded.source_key,owner_key=excluded.owner_key,source_revision=excluded.source_revision,cleanup_generation=excluded.cleanup_generation,checked_at=excluded.checked_at,result=excluded.result',[ctx.scope_id,ctx.key,ctx.revision,ctx.cleanup_generation,now(),result,ctx.owner_key]);
    if(result.state==='difference')await sql.query("UPDATE jobs SET status='queued',generation=generation+1,attempt=0,error_code=NULL,progress=progress||'{\"restart\":true}'::jsonb,available_at=LEAST(available_at,clock_timestamp()) WHERE kind='usage_sync' AND dedupe_key=$1 AND status IN('succeeded','failed')",[`usage:${account}:${ctx.user_id}:${claim.payload.business_date}`]);
    const cold=Date.parse(`${claim.payload.business_date}T00:00:00+08:00`)<Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000-44*86400000;
    const delayDays=cold&&['matched','cohort_matched'].includes(result.state)?30:1;
    const completed=await sql.query("UPDATE jobs SET status='succeeded',attempt=0,progress='{}',error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+$2*interval '1 day' WHERE id=$1 AND lease_until>clock_timestamp() RETURNING id",[claim.id,delayDays]);
    if(!completed.rowCount)throw new DomainError('stale_usage_job',409);
   });
  }catch(error){
   const sqlCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&['55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(error.code)?error.code:null;
   const code=error instanceof DomainError||error instanceof UsageProviderError?error.code:sqlCode??'usage_model_check_failed';
   if(error instanceof UsageProviderError&&error.code==='provider_rate_limited')await options.onRateLimit?.(error.retryAfterSeconds??30).catch(()=>{});
   const preserve=['provider_timeout','provider_unavailable','provider_rate_limited','provider_auth_failed','usage_sync_stopping','55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(code);
   const retry=(preserve&&code!=='provider_auth_failed'||['usage_model_source_changed','stale_usage_job'].includes(code))&&claim.attempt<5;
   await db.query("UPDATE jobs SET status=CASE WHEN generation<>$2 OR $4 THEN 'queued' ELSE 'failed' END,progress=CASE WHEN generation=$2 AND $7 THEN progress ELSE '{}'::jsonb END,error_code=$5,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+$6*interval '1 millisecond' WHERE id=$1 AND lease_token=$3 AND status='running'",[claim.id,claim.generation,claim.lease,retry,code,retry?Math.min(300000,1000*2**claim.attempt):86400000,preserve]);
  }
  return true;
 }
 async function status(id:string){
  if(!uuid(id))throw new DomainError('not_found',404);const row=(await db.query<{id:string;status:string;error_code:string|null;available_at:Date}>("SELECT id,status,error_code,available_at FROM jobs WHERE id=$1 AND kind='usage_model_check' AND payload->>'provider_account'=$2",[id,account])).rows[0];if(!row)throw new DomainError('not_found',404);return {...row,available_at:row.available_at.toISOString()};
 }
 async function read(user:string,date:string){
  return db.transaction(async sql=>{
   const ctx=await context(sql,user,date,true);const row=(await sql.query<{source_key:string;checked_at:Date;result:ModelCheckResult}>('SELECT source_key,checked_at,result FROM usage_model_checks WHERE scope_id=$1',[ctx.scope_id])).rows[0];
   if(!row)return {state:'not_checked' as const,result:null,checked_at:null};if(row.source_key!==ctx.key)return {state:'stale' as const,result:null,checked_at:row.checked_at.toISOString()};return {state:row.result.state,result:row.result,checked_at:row.checked_at.toISOString()};
  });
 }
 return {enqueue,discoverRecent,runOne,status,read};
}
