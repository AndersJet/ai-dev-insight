import {queueBackfill,queueRecentDays,type BackfillPerson,queryBackfillProgress} from './usage-backfill.js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@adi/storage';
import { DomainError } from './errors.js';
import { createUsageSnapshotStore, type UsageDraft } from './usage-snapshots.js';
import { UsageProviderError, type TraeUsageProvider } from './usage-provider.js';
type Progress = { draft?: UsageDraft; phase?: 'fetch'|'verify'|'publish'|'idle'; part?: number; page?: number; restart?: boolean };
type Claim = { id:string; generation:number; payload:{provider_account:string;user_id:string;business_date:string;recurring?:boolean}; progress:Progress; attempt:number; previous_status:string; lease:string };
const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
/** Trusted worker/CLI seam. Browser adapters must add authorization and audit. */
export function createUsageSyncService(db:Database,options:{providerAccount:string;provider?:Pick<TraeUsageProvider,'getMemberUsage'>;clock?:()=>Date;pageSize?:number;leaseMs?:number;stopping?:()=>boolean;onRateLimit?:(seconds:number)=>Promise<void>}){
 const now=options.clock??(()=>new Date());const account=options.providerAccount;const leaseMs=options.leaseMs??30000;
 if(!Number.isInteger(leaseMs)||leaseMs<50||leaseMs>60000)throw new Error('Invalid usage job lease');
 const snapshots=createUsageSnapshotStore(db,{providerAccount:account,clock:now,pageSize:options.pageSize??200,leaseMs:60000});
 async function enqueue(userId:string,businessDate:string,settings:{recurring?:boolean}={}){
  const start=Date.parse(`${businessDate}T00:00:00+08:00`);
  if(!uuid(userId)||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)||!Number.isFinite(start)||new Date(start+28800000).toISOString().slice(0,10)!==businessDate||start>now().getTime()||start+86400000<=now().getTime()-365*86400000)throw new DomainError('invalid_usage_day',422);
  userId=userId.toLowerCase();
  const exists=(await db.query('SELECT id FROM users WHERE id=$1 AND status=$2',[userId,'active'])).rowCount;if(!exists)throw new DomainError('account_inactive',409);
  const id=randomUUID();const payload={provider_account:account,user_id:userId,business_date:businessDate,recurring:settings.recurring??false};
  return (await db.query<{id:string}>(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'usage_sync',$2,$3)
   ON CONFLICT(dedupe_key) DO UPDATE SET payload=excluded.payload,generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,progress=jobs.progress||'{"restart":true}'::jsonb,attempt=0,error_code=NULL,available_at=clock_timestamp() RETURNING id`,[id,`usage:${account}:${userId}:${businessDate}`,payload])).rows[0]!.id;
 }
 async function release(claim:Claim,progress:Progress){
  const result=await db.query("UPDATE jobs SET status='queued',progress=$4,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp(),error_code=NULL WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id",[claim.id,claim.lease,claim.generation,progress]);
  if(!result.rowCount)throw new DomainError('stale_usage_job',409);
 }
 async function assertClaim(claim:Claim){
  const alive=await db.query("SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp()",[claim.id,claim.lease,claim.generation]);
  if(!alive.rowCount)throw new DomainError('stale_usage_job',409);
 }
 async function runOne(){
  if(options.stopping?.())return false;const provider=options.provider;if(!provider)throw new DomainError('usage_provider_unconfigured',503);
  await db.query('INSERT INTO usage_provider_control(provider_account,interval_ms) VALUES($1,20) ON CONFLICT DO NOTHING',[account]);
  const claim=await db.transaction(async client=>{
   const scheduling=(await client.query<{history_turn:boolean;cold_turn:boolean}>('SELECT dispatch_turn%4=3 AS history_turn,dispatch_turn%32=31 AS cold_turn FROM usage_provider_control WHERE provider_account=$1 FOR UPDATE SKIP LOCKED',[account])).rows[0];if(!scheduling)return null;
   await client.query(`UPDATE usage_snapshot_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id IN(
    SELECT r.id FROM jobs j JOIN usage_snapshot_runs r ON r.id=CASE WHEN j.progress->'draft'->>'runId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (j.progress->'draft'->>'runId')::uuid END
    JOIN usage_scopes s ON s.id=r.scope_id AND s.active_run_id=r.id JOIN users u ON u.id=s.user_id
    WHERE j.kind='usage_sync' AND j.payload->>'provider_account'=$1 AND s.provider_account=$1 AND j.status='queued' AND j.progress ? 'draft' AND COALESCE(j.progress->>'restart','false')<>'true'
    AND j.payload->>'user_id'=s.user_id::text AND j.payload->>'business_date'=s.business_date::text AND r.lease_token::text=j.progress->'draft'->>'leaseToken'
    AND r.state='building' AND r.lease_until>clock_timestamp() AND u.status='active' AND r.captured_email=u.email_key AND r.ingest_epoch=u.ingest_epoch AND r.cleanup_generation=u.cleanup_generation
    ORDER BY r.lease_until LIMIT 20 FOR UPDATE OF r SKIP LOCKED)`,[account]);
   const row=(await client.query<Omit<Claim,'lease'>>(`SELECT id,generation,payload,progress,attempt,status AS previous_status FROM jobs WHERE kind='usage_sync' AND payload->>'provider_account'=$1 AND (progress->>'phase'='publish' OR NOT EXISTS(SELECT 1 FROM usage_provider_control c WHERE c.provider_account=$1 AND c.paused_until>clock_timestamp())) AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp()) OR (status='succeeded' AND payload->>'recurring'='true' AND available_at<=clock_timestamp()) OR (status='failed' AND payload->>'recurring'='true' AND error_code NOT IN('account_inactive','invalid_usage_day','usage_scope_expired') AND available_at<=clock_timestamp()))
     ORDER BY CASE WHEN (CASE WHEN payload->>'business_date'>=(($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-2)::text THEN 0 WHEN payload->>'business_date'>=(($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-44)::text THEN 1 ELSE 2 END)=$3::integer THEN 0 ELSE 1 END,
      CASE WHEN payload->>'business_date'>=(($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-44)::text THEN 0 ELSE 1 END,
      CASE WHEN progress ? 'draft' THEN 0 ELSE 1 END,
      CASE WHEN available_at<clock_timestamp()-interval '10 minutes' THEN 0 ELSE 1 END,
      CASE WHEN available_at>=clock_timestamp()-interval '10 minutes' AND payload->>'activity_priority'='true' THEN 0 ELSE 1 END,
      available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[account,now(),scheduling.history_turn?(scheduling.cold_turn?2:1):0])).rows[0];
   if(!row)return null;await client.query('UPDATE usage_provider_control SET dispatch_turn=dispatch_turn+1 WHERE provider_account=$1',[account]);const lease=randomUUID();const attempt=row.previous_status==='failed'?1:row.progress.draft&&row.previous_status==='queued'&&!row.progress.restart?row.attempt:row.attempt+1;
   await client.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',attempt=$4 WHERE id=$1",[row.id,lease,leaseMs,attempt]);return {...row,attempt,lease};
  });
  if(!claim)return false;let draft=claim.progress.draft;
  try{
   if(claim.previous_status==='running'||claim.progress.restart){if(draft)await snapshots.abort(draft);draft=undefined;}
   if(!draft){
    draft=await snapshots.begin(claim.payload.user_id,claim.payload.business_date);
    await release(claim,{draft,part:0,page:1,phase:draft.parts.length?'fetch':'publish'});return true;
   }
   if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);
   const phase=claim.progress.phase;const partIndex=claim.progress.part??0;const page=claim.progress.page??1;
   if(phase==='publish'){
    await snapshots.publish(draft,{id:claim.id,leaseToken:claim.lease,generation:claim.generation,...(claim.payload.recurring?{reschedule:true}:{})});return true;
   }
   if(phase!=='fetch'&&phase!=='verify')throw new DomainError('usage_sync_checkpoint_invalid',409);
   const part=draft.parts[partIndex];if(!part)throw new DomainError('usage_sync_checkpoint_invalid',409);
   await assertClaim(claim);await snapshots.heartbeat(draft);await assertClaim(claim);const response=await provider.getMemberUsage({...part.query,page});
   if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);
   await assertClaim(claim);await snapshots.stage(draft,partIndex,response);
   const last=page>=Math.max(1,response.pagination?.total_pages??0);
   let next:Progress={draft,phase,part:partIndex,page:page+1};
   if(last){if(partIndex+1<draft.parts.length)next={draft,phase,part:partIndex+1,page:1};else next=phase==='fetch'?{draft,phase:'verify',part:0,page:1}:{draft,phase:'publish',part:0,page:1};}
   await release(claim,next);
  }catch(error){
   if(draft)await snapshots.abort(draft).catch(()=>{});
   const known=error instanceof DomainError||error instanceof UsageProviderError;const sqlCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&['55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(error.code)?error.code:null;
   const code=options.stopping?.()?'usage_sync_stopping':known?error.code:sqlCode??'usage_sync_failed';
   if(error instanceof UsageProviderError&&error.code==='provider_rate_limited'&&(error.httpStatus===429||error.providerCode===64290))await options.onRateLimit?.(error.retryAfterSeconds??30).catch(()=>{});
   const retry=['provider_timeout','provider_unavailable','provider_rate_limited','invalid_provider_response','usage_scope_busy','stale_usage_lease','stale_usage_job','usage_owner_changed','usage_page_changed','usage_sync_stopping','55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(code);
   const wait=code==='usage_scope_busy'?61000:code==='usage_sync_stopping'?1000:error instanceof UsageProviderError&&error.retryAfterSeconds?error.retryAfterSeconds*1000:Math.min(300000,1000*2**Math.min(claim.attempt,8));
   await db.query(`UPDATE jobs SET status=CASE WHEN generation<>$3 OR ($4 AND attempt<5) THEN 'queued' ELSE 'failed' END,progress='{}',error_code=$5,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+(CASE WHEN generation=$3 AND NOT($4 AND attempt<5) AND payload->>'recurring'='true' THEN 86400000 ELSE $6 END)*interval '1 millisecond'
     WHERE id=$1 AND lease_token=$2 AND status='running'`,[claim.id,claim.lease,claim.generation,retry,code,wait]);
  }
  return true;
 }
 async function discoverRecent(){
  await db.query('INSERT INTO usage_provider_control(provider_account,interval_ms) VALUES($1,20) ON CONFLICT DO NOTHING',[account]);
  return db.transaction(async client=>{
   const control=(await client.query<{discovery_cursor:string|null;gap:boolean}>("SELECT discovery_cursor,(last_discovered_at AT TIME ZONE 'Asia/Shanghai')::date<($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-3 AS gap FROM usage_provider_control WHERE provider_account=$1 AND discovery_at<=clock_timestamp() FOR UPDATE SKIP LOCKED",[account,now()])).rows[0];if(!control)return 0;
   if(control.gap)await client.query('UPDATE usage_provider_control SET backfill_reset_at=clock_timestamp() WHERE provider_account=$1',[account]);
   const people=(await client.query<BackfillPerson>("SELECT u.id,u.ingest_epoch,EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_at>=$2::timestamptz-interval '7 days') AS active_recently FROM users u WHERE u.status='active' AND ($1::uuid IS NULL OR u.id>$1) ORDER BY u.id LIMIT 20 FOR UPDATE OF u",[control.discovery_cursor,now()])).rows;
   let inserted=0;for(const person of people){inserted+=await queueRecentDays(client,account,person,now());inserted+=await queueBackfill(client,account,person,now());}
   const pending=Boolean((await client.query("SELECT 1 FROM usage_backfills f JOIN users u ON u.id=f.user_id AND u.ingest_epoch=f.ingest_epoch AND u.status='active' WHERE f.provider_account=$1 AND f.superseded_at IS NULL AND f.completed_at IS NULL AND f.next_date>=f.from_date LIMIT 1",[account])).rowCount);
   await client.query("UPDATE usage_provider_control SET discovery_cursor=$2,discovery_at=clock_timestamp()+$3*interval '1 second',last_discovered_at=$4 WHERE provider_account=$1",[account,people.length===20?people.at(-1)!.id:null,people.length===20||pending?1:60,now()]);return inserted;
  });
 }
 async function retryBackfill(userId:string){
  if(!uuid(userId))throw new DomainError('invalid_request',400);await db.assertNotRecovering();
  return db.transaction(async client=>{
   const person=(await client.query<BackfillPerson>("SELECT u.id,u.ingest_epoch,EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_at>=$2::timestamptz-interval '7 days') AS active_recently FROM users u WHERE u.id=$1 AND u.status='active' FOR UPDATE OF u",[userId,now()])).rows[0];if(!person)throw new DomainError('account_inactive',409);
   let queued=await queueRecentDays(client,account,person,now());for(let page=0;page<6;page++)queued+=await queueBackfill(client,account,person,now(),true);
   const plan=(await client.query<{id:string;from_date:string;to_date:string;completed_at:Date|null}>('SELECT id,from_date::text,to_date::text,completed_at FROM usage_backfills WHERE provider_account=$1 AND user_id=$2 AND ingest_epoch=$3 AND superseded_at IS NULL',[account,userId,person.ingest_epoch])).rows[0]!;
   if(!plan.completed_at){const retried=await client.query(`UPDATE jobs j SET status='queued',generation=generation+1,progress='{}',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()
    WHERE kind='usage_sync' AND payload->>'provider_account'=$1 AND payload->>'user_id'=$2 AND payload->>'business_date' BETWEEN $3 AND $4 AND status IN('failed','cancelled')
    AND NOT EXISTS(SELECT 1 FROM usage_backfill_days d WHERE d.backfill_id=$5 AND d.business_date::text=j.payload->>'business_date')`,[account,userId,plan.from_date,plan.to_date,plan.id]);queued+=retried.rowCount??0;}
   return {plan_id:plan.id,queued,already_complete:!!plan.completed_at};
  });
 }
 async function status(id:string){
  if(!uuid(id))throw new DomainError('not_found',404);
  const row=(await db.query<{id:string;status:string;attempt:number;error_code:string|null;available_at:Date;phase:string|null}>("SELECT id,status,attempt,error_code,available_at,progress->>'phase' AS phase FROM jobs WHERE id=$1 AND kind='usage_sync' AND payload->>'provider_account'=$2",[id,account])).rows[0];
  if(!row)throw new DomainError('not_found',404);return {...row,available_at:row.available_at.toISOString()};
 }
 return {enqueue,runOne,status,discoverRecent,retryBackfill,backfillStatus:()=>queryBackfillProgress(db,account),pruneTransient:snapshots.pruneTransient};
}
