import {sessionQueryContext,advanceSessionQuery,startSessionQuery,prepareSessionQuery,publishSessionQuery,type SessionQueryProgress,type SessionQueryResult} from './session-usage-query.js';
import type { Database, Transaction } from '@adi/storage';
import { DomainError } from './errors.js';
import { UsageProviderError, type ProviderUsagePage, type TraeUsageProvider } from './usage-provider.js';

type Owner = { user_id: string; source_session_id: string; status: string; email_key: string; cleanup_generation: number; ingest_epoch: number; provider_user_id: string | null; last_at: Date; retention_cutoff: Date | null };
type Claim = Owner & { generation: number; sessionId: string };
type SessionCheckpoint={version:1;user_id:string;provider_user_id:string;email_key:string;cleanup_generation:number;ingest_epoch:number;source_session_id:string;query:SessionQueryProgress};
export type AttributionJobCompletion = { id: string; leaseToken: string; generation: number; nextAt?: Date; reschedule?:boolean };
const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Trusted worker seam: records association evidence, never billing quantities.
 * HTTP consumers must enforce owner/super access and their cleanup fence.
 */
export function createUsageAttributionService(db: Database, options: { providerAccount: string; provider?: Pick<TraeUsageProvider, 'getSessionUsage'> & Partial<Pick<TraeUsageProvider,'getMemberUsage'>>; clock?: () => Date }) {
  const account = options.providerAccount; const now = options.clock ?? (() => new Date());
  if (!account || account.length > 256) throw new Error('Invalid usage provider account');
  async function owner(client: Transaction, sessionId: string, lock = false) {
    if (!uuid(sessionId)) throw new DomainError('not_found', 404);
    if(lock)await client.query('SELECT singleton FROM data_identity FOR SHARE');
    const row = (await client.query<Owner>(`SELECT s.user_id,s.source_session_id,u.status,u.email_key,u.cleanup_generation,u.ingest_epoch,p.provider_user_id,s.last_at,d.retention_cutoff
      FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d LEFT JOIN usage_provider_identities p ON p.provider_account=$1 AND p.user_id=u.id
      WHERE s.id=$2 AND (d.retention_cutoff IS NULL OR s.last_at>=d.retention_cutoff) ${lock ? 'FOR UPDATE OF u' : ''}`, [account, sessionId])).rows[0];
    if (!row) throw new DomainError('not_found', 404); return row;
  }
  function validate(response: ProviderUsagePage, claim: Claim) {
    const query = response.query.parameters;
    if (response.query.endpoint !== 'session_usage_detail' || !('session_ids' in query) || query.session_ids.length !== 1 || query.session_ids[0] !== claim.source_session_id) throw new DomainError('usage_evidence_scope_mismatch', 409);
    if (!/^[a-f0-9]{64}$/.test(response.response_hash) || !Number.isFinite(Date.parse(response.observed_at)) || response.items.length > 5000) throw new DomainError('usage_evidence_invalid', 422);
    const pagination = response.pagination;
    if (pagination && (pagination.page !== 1 || pagination.total !== response.items.length || pagination.total_pages > 1)) throw new DomainError('usage_evidence_partial', 409);
    if (response.items.some(row => row.provider_user_id !== claim.provider_user_id)) throw new DomainError('usage_evidence_owner_mismatch', 409);
    // The single-Hook query proves a relationship, not a second quantity ledger.
    // Do not turn CUE, unrelated clients, missing IDs or time proximity into links.
    const ids = [...new Set(response.items.filter(row => row.scene === 'Chat' && (row.client === 'ide' || !row.client) && row.billing_session_id).map(row => row.billing_session_id!))];
    if (ids.some(id => id.length > 256)) throw new DomainError('usage_evidence_invalid', 422);
    return ids;
  }
  async function assertJob(client: Transaction, sessionId: string, job?: AttributionJobCompletion) {
    if (!job) return;
    const found = await client.query(`SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp()
      AND kind='usage_attribution' AND payload->>'provider_account'=$4 AND payload->>'session_id'=$5 FOR UPDATE`, [job.id,job.leaseToken,job.generation,account,sessionId]);
    if (!found.rowCount) throw new DomainError('stale_usage_job',409);
  }
  async function probe(sessionId: string, job?: AttributionJobCompletion) {
    if (!options.provider) throw new DomainError('usage_provider_unconfigured', 503);
    const claim = await db.transaction(async client => {
      await client.query('SET LOCAL jit=off');
      const captured = await owner(client, sessionId, true);
      if (captured.status !== 'active') throw new DomainError('account_inactive', 409);
      if (!captured.provider_user_id) throw new DomainError('usage_identity_unverified', 409);
      await assertJob(client,sessionId,job);
      const row = (await client.query<{ generation: number }>(`INSERT INTO usage_attribution_subjects(provider_account,session_id,user_id,probe_state,requested_at,cleanup_generation)
        VALUES($1,$2,$3,'running',$4,$5) ON CONFLICT(provider_account,session_id) DO UPDATE SET generation=usage_attribution_subjects.generation+1,probe_state='running',requested_at=excluded.requested_at,cleanup_generation=excluded.cleanup_generation,error_code=NULL RETURNING generation`, [account, sessionId, captured.user_id, now(),captured.cleanup_generation])).rows[0]!;
      const saved=job?(await client.query<{progress:Partial<SessionCheckpoint>}>('SELECT progress FROM jobs WHERE id=$1',[job.id])).rows[0]?.progress:undefined;
      const checkpoint=saved?.version===1&&saved.user_id===captured.user_id&&saved.provider_user_id===captured.provider_user_id&&saved.email_key===captured.email_key&&saved.cleanup_generation===captured.cleanup_generation&&saved.ingest_epoch===captured.ingest_epoch&&saved.source_session_id===captured.source_session_id&&saved.query? saved as SessionCheckpoint:undefined;
      return { ...captured, sessionId, generation: row.generation,queryContext:options.provider?.getMemberUsage?await sessionQueryContext(client,sessionId):null,checkpoint };
    });
    try {
      const continuing=job&&claim.queryContext&&!claim.queryContext.partial&&claim.checkpoint?.query.context.key===claim.queryContext.key;
      const response = continuing?claim.checkpoint!.query.direct:await options.provider.getSessionUsage(claim.source_session_id);
      const ids = validate(response, claim);
      let progress:SessionQueryProgress|undefined;
      let sessionResult:SessionQueryResult|null=null;
      if(claim.queryContext&&options.provider.getMemberUsage){
        if(job){
          progress=continuing?claim.checkpoint!.query:startSessionQuery(claim.queryContext,response,claim.checkpoint?.query);
          if(continuing)await advanceSessionQuery(progress,claim.provider_user_id!,{getSessionUsage:options.provider.getSessionUsage,getMemberUsage:options.provider.getMemberUsage});
          if(progress.complete)sessionResult=progress.result;
        }else sessionResult=await prepareSessionQuery(claim.queryContext,claim.provider_user_id!,response,{getSessionUsage:options.provider.getSessionUsage,getMemberUsage:options.provider.getMemberUsage});
      }
      await db.transaction(async client => {
        await client.query('SET LOCAL jit=off');
        const current = await owner(client, sessionId, true);
        if(current.retention_cutoff&&claim.last_at<current.retention_cutoff)throw new DomainError('stale_usage_context',409);
        if (current.status !== 'active' || current.email_key !== claim.email_key || current.ingest_epoch !== claim.ingest_epoch || current.cleanup_generation !== claim.cleanup_generation || current.provider_user_id !== claim.provider_user_id) throw new DomainError('usage_owner_changed', 409);
        const subject = await client.query(`SELECT 1 FROM usage_attribution_subjects WHERE provider_account=$1 AND session_id=$2 AND generation=$3 AND probe_state='running' FOR UPDATE`, [account, sessionId, claim.generation]);
        if (!subject.rowCount) throw new DomainError('stale_usage_evidence', 409);
        await assertJob(client,sessionId,job);
        if(job&&progress&&!progress.complete&&claim.queryContext){
          if((await sessionQueryContext(client,sessionId)).key!==claim.queryContext.key)throw new DomainError('stale_session_query',409);
          const checkpoint:SessionCheckpoint={version:1,user_id:claim.user_id,provider_user_id:claim.provider_user_id!,email_key:claim.email_key,cleanup_generation:claim.cleanup_generation,ingest_epoch:claim.ingest_epoch,source_session_id:claim.source_session_id,query:progress};
          const serialized=JSON.stringify(checkpoint);
          if(Buffer.byteLength(serialized)>4*1024*1024)throw new DomainError('usage_evidence_limit',409);
          const saved=await client.query("UPDATE jobs SET status='queued',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,progress=$4,available_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id",[job.id,job.leaseToken,job.generation,serialized]);
          if(!saved.rowCount)throw new DomainError('stale_usage_job',409);
          return;
        }
        if(sessionResult&&claim.queryContext)await publishSessionQuery(client,account,sessionId,claim,claim.queryContext,sessionResult,response.observed_at);
        const count = (await client.query<{count:string;known:string}>(`SELECT count(*) FILTER(WHERE NOT(billing_session_id=ANY($3::text[])))::text AS count,
          count(*) FILTER(WHERE billing_session_id=ANY($3::text[]) AND provider_user_id=$4 AND cleanup_generation=$5 AND ingest_epoch=$6)::text AS known
          FROM usage_attribution_evidence WHERE provider_account=$1 AND session_id=$2`,[account,sessionId,ids,claim.provider_user_id,claim.cleanup_generation,claim.ingest_epoch])).rows[0]!;
        if (Number(count.count) + ids.length > 5000) throw new DomainError('usage_evidence_limit', 409);
        await client.query(`INSERT INTO usage_attribution_evidence(provider_account,session_id,user_id,billing_session_id,provider_user_id,cleanup_generation,ingest_epoch,first_seen_at,last_seen_at,response_hash,request_id)
          SELECT $1,$2,$3,id,$4,$5,$6,$7,$7,$8,$9 FROM unnest($10::text[]) id
          ON CONFLICT(provider_account,session_id,billing_session_id) DO UPDATE SET
            first_seen_at=CASE WHEN usage_attribution_evidence.cleanup_generation<>excluded.cleanup_generation OR usage_attribution_evidence.ingest_epoch<>excluded.ingest_epoch OR usage_attribution_evidence.provider_user_id<>excluded.provider_user_id THEN excluded.first_seen_at ELSE usage_attribution_evidence.first_seen_at END,
            provider_user_id=excluded.provider_user_id,cleanup_generation=excluded.cleanup_generation,ingest_epoch=excluded.ingest_epoch,last_seen_at=excluded.last_seen_at,response_hash=excluded.response_hash,request_id=excluded.request_id`,
        [account, sessionId, claim.user_id, claim.provider_user_id, claim.cleanup_generation, claim.ingest_epoch, response.observed_at, response.response_hash, response.request_id, ids]);
        await client.query("UPDATE usage_attribution_subjects SET probe_state=$4,observed_at=$5,response_hash=$6,error_code=NULL WHERE provider_account=$1 AND session_id=$2 AND generation=$3", [account, sessionId, claim.generation, ids.length ? 'observed' : 'empty', response.observed_at, response.response_hash]);
        if(Number(count.known)<ids.length)await client.query('INSERT INTO usage_attribution_revisions(provider_account,user_id,revision) VALUES($1,$2,1) ON CONFLICT(provider_account,user_id) DO UPDATE SET revision=usage_attribution_revisions.revision+1',[account,claim.user_id]);
        if (job) {
          let nextAt=job.nextAt??now();
          if(job.reschedule){
            const activity=(await client.query<{at:Date}>(`SELECT GREATEST($3::timestamptz,
              (SELECT max(first_seen_at) FROM usage_attribution_evidence WHERE provider_account=$1 AND session_id=$2 AND provider_user_id=$4 AND cleanup_generation=$5 AND ingest_epoch=$6),
              (SELECT max(e.received_at) FROM hook_events e WHERE e.session_id=$2 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))) AS at`,[account,sessionId,current.last_at,claim.provider_user_id,claim.cleanup_generation,claim.ingest_epoch])).rows[0]!.at;
            const at=now(),age=Math.max(0,at.getTime()-activity.getTime());nextAt=new Date(at.getTime()+(age<3600000?300000:age<86400000?3600000:86400000));
          }
          const completed = await client.query("UPDATE jobs SET status='succeeded',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,progress='{}',available_at=$4 WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id", [job.id,job.leaseToken,job.generation,nextAt]);
          if (!completed.rowCount) throw new DomainError('stale_usage_job',409);
        }
      });
    } catch (error) {
      const code = error instanceof DomainError || error instanceof UsageProviderError ? error.code : 'usage_evidence_failed';
      await db.query("UPDATE usage_attribution_subjects SET probe_state='failed',error_code=$4 WHERE provider_account=$1 AND session_id=$2 AND generation=$3", [account, sessionId, claim.generation, code]);
      throw error;
    }
  }
  async function read(sessionId: string) {
    return db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const current = await owner(client, sessionId);
      const subject = (await client.query<{ probe_state: 'running' | 'observed' | 'empty' | 'failed'; observed_at: Date | null; error_code: string | null }>('SELECT probe_state,observed_at,error_code FROM usage_attribution_subjects WHERE provider_account=$1 AND session_id=$2', [account, sessionId])).rows[0];
      const rows = (await client.query<{ billing_session_id: string; first_seen_at: Date; last_seen_at: Date; claims: string }>(`WITH valid AS MATERIALIZED (
        SELECT e.* FROM usage_attribution_evidence e JOIN users u ON u.id=e.user_id
        JOIN usage_provider_identities p ON p.provider_account=e.provider_account AND p.user_id=e.user_id AND p.provider_user_id=e.provider_user_id
        WHERE e.provider_account=$1 AND e.user_id=$3 AND e.cleanup_generation=u.cleanup_generation AND e.ingest_epoch=u.ingest_epoch AND u.status='active'
      ) SELECT a.billing_session_id,a.first_seen_at,a.last_seen_at,(SELECT count(*)::text FROM valid b WHERE b.billing_session_id=a.billing_session_id) AS claims FROM valid a WHERE a.session_id=$2 ORDER BY a.billing_session_id COLLATE "C"`, [account, sessionId, current.user_id])).rows;
      return { probe_state: subject?.probe_state ?? 'not_queried' as const, observed_at: subject?.observed_at?.toISOString() ?? null, error_code: subject?.error_code ?? null,
        links: rows.map(row => ({ billing_session_id: row.billing_session_id, state: Number(row.claims) === 1 ? 'linked' as const : 'conflict' as const, evidence: 'single_hook_query' as const, first_seen_at: row.first_seen_at.toISOString(), last_seen_at: row.last_seen_at.toISOString() })) };
    });
  }
  return { probe, read };
}
export type UsageAttributionService = ReturnType<typeof createUsageAttributionService>;
