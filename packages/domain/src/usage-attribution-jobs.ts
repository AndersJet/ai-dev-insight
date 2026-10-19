import { randomUUID } from 'node:crypto';
import type { Database } from '@adi/storage';
import { DomainError } from './errors.js';
import { createUsageAttributionService } from './usage-attribution.js';
import { UsageProviderError, type TraeUsageProvider } from './usage-provider.js';

type Claim = { id: string; generation: number; attempt: number; previous_status:string; payload: { session_id: string; recurring?: boolean }; lease: string };
const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
/** Trusted operator/worker entry. No source request is issued by enqueue. */
export function createUsageAttributionJobs(db: Database, options: { providerAccount: string; provider?: Pick<TraeUsageProvider,'getSessionUsage'> & Partial<Pick<TraeUsageProvider,'getMemberUsage'>>; clock?:()=>Date; stopping?:()=>boolean; onRateLimit?:(seconds:number)=>Promise<void> }) {
  const account=options.providerAccount;const now=options.clock??(()=>new Date());let nextDiscovery=0;
  const memberUsage=options.provider?.getMemberUsage;
  const evidence=createUsageAttributionService(db,{providerAccount:account,clock:now,...(options.provider?{provider:{...(memberUsage?{getMemberUsage:async (query:Parameters<TraeUsageProvider['getMemberUsage']>[0])=>{if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);const result=await memberUsage(query);if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);return result;}}:{}),getSessionUsage:async id=>{
    if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);
    const result=await options.provider!.getSessionUsage(id);
    if(options.stopping?.())throw new DomainError('usage_sync_stopping',409);return result;
  }}}:{})});
  async function enqueue(sessionId:string){
    if(!uuid(sessionId))throw new DomainError('not_found',404);
    sessionId=sessionId.toLowerCase();
    if(!(await db.query("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id JOIN usage_provider_identities p ON p.user_id=u.id AND p.provider_account=$1 WHERE s.id=$2 AND u.status='active'",[account,sessionId])).rowCount)throw new DomainError('usage_identity_unverified',409);
    return (await db.query<{id:string}>(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'usage_attribution',$2,$3)
      ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=clock_timestamp() RETURNING id`,[randomUUID(),`usage-link:${account}:${sessionId}`,{provider_account:account,session_id:sessionId,recurring:false}])).rows[0]!.id;
  }
  async function discoverRecent(){
    if(now().getTime()<nextDiscovery)return 0;nextDiscovery=now().getTime()+30000;
    const today=Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000;
    const result=await db.query(`INSERT INTO jobs(id,kind,dedupe_key,payload)
      SELECT gen_random_uuid(),'usage_attribution','usage-link:'||$1||':'||s.id::text,jsonb_build_object('provider_account',$1::text,'session_id',s.id::text,'recurring',true)
      FROM sessions s JOIN users u ON u.id=s.user_id JOIN usage_provider_identities p ON p.user_id=u.id AND p.provider_account=$1
      LEFT JOIN jobs prior ON prior.dedupe_key='usage-link:'||$1||':'||s.id::text
      WHERE u.status='active' AND (s.last_at>=$2 OR (prior.id IS NOT NULL AND EXISTS(
        SELECT 1 FROM hook_events e WHERE e.session_id=s.id AND e.received_at>=$2
          AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))))
        AND (prior.id IS NULL OR prior.payload->>'recurring' IS DISTINCT FROM 'true' OR (prior.status='failed' AND prior.error_code IN('account_inactive','usage_identity_unverified')))
      ORDER BY s.last_at DESC,s.id LIMIT 20 ON CONFLICT(dedupe_key) DO UPDATE SET
       payload=jobs.payload||'{"recurring":true}'::jsonb,
       status=CASE WHEN jobs.status='failed' AND jobs.error_code IN('account_inactive','usage_identity_unverified') THEN 'queued' ELSE jobs.status END,
       generation=jobs.generation+CASE WHEN jobs.status='failed' AND jobs.error_code IN('account_inactive','usage_identity_unverified') THEN 1 ELSE 0 END,
       attempt=CASE WHEN jobs.status='failed' AND jobs.error_code IN('account_inactive','usage_identity_unverified') THEN 0 ELSE jobs.attempt END,
       available_at=CASE WHEN jobs.status='failed' AND jobs.error_code IN('account_inactive','usage_identity_unverified') THEN clock_timestamp() ELSE jobs.available_at END,
       error_code=CASE WHEN jobs.status='failed' AND jobs.error_code IN('account_inactive','usage_identity_unverified') THEN NULL ELSE jobs.error_code END
       RETURNING id`,[account,new Date(today-44*86400000)]);
    return result.rowCount??0;
  }
  async function runOne(){
    if(options.stopping?.())return false;
    const claim=await db.transaction(async client=>{
      const row=(await client.query<Omit<Claim,'lease'>>(`SELECT id,generation,attempt,payload,status AS previous_status FROM jobs WHERE kind='usage_attribution' AND payload->>'provider_account'=$1
        AND NOT EXISTS(SELECT 1 FROM usage_provider_control c WHERE c.provider_account=$1 AND c.paused_until>clock_timestamp())
        AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp()) OR (status='succeeded' AND payload->>'recurring'='true' AND available_at<=clock_timestamp()) OR (status='failed' AND payload->>'recurring'='true' AND error_code NOT IN('account_inactive','not_found','stale_usage_context') AND available_at<=clock_timestamp()))
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[account])).rows[0];
      if(!row)return null;const lease=randomUUID(),attempt=row.previous_status==='failed'?1:row.attempt+1;await client.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds',attempt=$3 WHERE id=$1",[row.id,lease,attempt]);return {...row,attempt,lease};
    });
    if(!claim)return false;
    try{
      const today=Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000;
      const session=(await db.query<{activity_at:Date}>(`SELECT CASE WHEN s.last_at>=$2 THEN s.last_at ELSE GREATEST(s.last_at,
        (SELECT max(e.received_at) FROM hook_events e WHERE e.session_id=s.id AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))) END AS activity_at
        FROM sessions s WHERE s.id=$1`,[claim.payload.session_id,new Date(today-44*86400000)])).rows[0];if(!session)throw new DomainError('not_found',404);
      if(claim.payload.recurring&&session.activity_at.getTime()<today-44*86400000){
        await db.query("UPDATE jobs SET status='succeeded',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,progress='{}',available_at=$4 WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp()",[claim.id,claim.lease,claim.generation,new Date(now().getTime()+86400000)]);return true;
      }
      await evidence.probe(claim.payload.session_id,{id:claim.id,leaseToken:claim.lease,generation:claim.generation,...(claim.payload.recurring?{reschedule:true}:{})});
    }catch(error){
      const sqlCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&['55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(error.code)?error.code:null;
      const code=error instanceof DomainError||error instanceof UsageProviderError?error.code:sqlCode??'usage_evidence_failed';
      const retry=['provider_timeout','provider_unavailable','provider_rate_limited','invalid_provider_response','usage_sync_stopping','usage_owner_changed','stale_usage_job','stale_usage_evidence','stale_session_query','55P03','40001','40P01','57014','database_io_timeout','database_unavailable'].includes(code);
      if(error instanceof UsageProviderError&&error.code==='provider_rate_limited'&&(error.httpStatus===429||error.providerCode===64290))await options.onRateLimit?.(error.retryAfterSeconds??30).catch(()=>{});
      const wait=error instanceof UsageProviderError&&error.retryAfterSeconds?error.retryAfterSeconds*1000:Math.min(300000,1000*2**Math.min(claim.attempt,8));
      await db.query(`UPDATE jobs SET status=CASE WHEN generation<>$3 OR ($4 AND attempt<5) THEN 'queued' ELSE 'failed' END,error_code=$5,lease_token=NULL,lease_until=NULL,
        progress=CASE WHEN $4 AND $5 NOT IN('usage_owner_changed') THEN progress ELSE '{}'::jsonb END,
        available_at=clock_timestamp()+(CASE WHEN generation=$3 AND NOT($4 AND attempt<5) AND payload->>'recurring'='true' THEN 86400000 ELSE $6 END)*interval '1 millisecond'
        WHERE id=$1 AND lease_token=$2 AND status='running'`,[claim.id,claim.lease,claim.generation,retry,code,wait]);
    }
    return true;
  }
  async function status(id:string){
    if(!uuid(id))throw new DomainError('not_found',404);
    const row=(await db.query<{id:string;status:string;attempt:number;error_code:string|null;available_at:Date}>("SELECT id,status,attempt,error_code,available_at FROM jobs WHERE id=$1 AND kind='usage_attribution' AND payload->>'provider_account'=$2",[id,account])).rows[0];
    if(!row)throw new DomainError('not_found',404);return {...row,available_at:row.available_at.toISOString()};
  }
  return {enqueue,discoverRecent,runOne,status};
}
