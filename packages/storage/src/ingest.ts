import { createHash, randomUUID } from 'node:crypto';
import type { HookEnvelope } from '@adi/contracts';
import type { Transaction } from './index.js';
import {persistProjectContext,type ProjectIngestOutcome} from './project-observations.js';

export interface IngestOptions { admissionEpoch: number; receivedAt: Date; tokenHash?: string }
export type IngestResult = { outcome: 'committed'; eventId: string; sessionId: string;project_outcome?:ProjectIngestOutcome } | { outcome: 'duplicate' } | { outcome: 'rejected'; reason: string };

export async function persistEnvelope(client: Transaction, envelope: HookEnvelope, options: IngestOptions, encodedEnvelope = JSON.stringify(envelope)): Promise<IngestResult> {
  if(envelope.schema_version!==2)return {outcome:'rejected',reason:'unsupported_protocol'};
  const occurred = Date.parse(envelope.occurred_at); const received = options.receivedAt.getTime();
  if (!Number.isFinite(occurred) || !Number.isFinite(received)) return { outcome: 'rejected', reason: 'invalid_timestamp' };
  if (occurred < received - 365 * 86_400_000) return { outcome: 'rejected', reason: 'expired' };
  if (occurred > received + 5 * 60_000) return { outcome: 'rejected', reason: 'future_timestamp' };
  const recovery = (await client.query<{ recovery_id: string | null; expired: boolean;collection_enabled:boolean;before_baseline:boolean }>('SELECT recovery_id,collection_enabled,COALESCE($1::timestamptz<retention_cutoff,false) AS expired,COALESCE($1::timestamptz<collection_baseline_at,false) AS before_baseline FROM data_identity FOR SHARE',[envelope.occurred_at])).rows[0];
  if (!recovery || recovery.recovery_id) return { outcome: 'rejected', reason: 'recovery_quarantined' };
  if(!recovery.collection_enabled)return {outcome:'rejected',reason:'collection_disabled'};
  if(recovery.before_baseline)return {outcome:'rejected',reason:'before_collection_baseline'};
  if (recovery.expired) return { outcome: 'rejected', reason: 'expired' };
  const owner = await client.query<{ user_id: string }>('SELECT user_id FROM installations WHERE id=$1', [envelope.installation_id]);
  const userId = owner.rows[0]?.user_id;
  if (!userId) return { outcome: 'rejected', reason: 'unknown_installation' };
  // Same user lock will also serialize account-state changes and cleanup barriers.
  const user = await client.query<{ status: string; ingest_epoch: number;cleanup_generation:number }>('SELECT status,ingest_epoch,cleanup_generation FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (user.rows[0]?.status !== 'active') return { outcome: 'rejected', reason: 'account_disabled' };
  if (user.rows[0].ingest_epoch !== options.admissionEpoch) return { outcome: 'rejected', reason: 'stale_epoch' };
  const installation = await client.query<{ enabled: boolean; token_hash: string }>('SELECT enabled,token_hash FROM installations WHERE id=$1 AND user_id=$2 FOR UPDATE', [envelope.installation_id, userId]);
  if (!installation.rows[0]?.enabled) return { outcome: 'rejected', reason: 'installation_disabled' };
  if (options.tokenHash !== undefined && installation.rows[0].token_hash !== options.tokenHash) return { outcome: 'rejected', reason: 'installation_token_changed' };
  const cleared = await client.query('SELECT 1 FROM cleanup_tombstones WHERE user_id=$1 AND from_at <= $2::timestamptz AND to_at > $2::timestamptz LIMIT 1', [userId, envelope.occurred_at]);
  if (cleared.rowCount) return { outcome: 'rejected', reason: 'data_cleared' };
  // PostgreSQL parses the original JSON number tokens without passing them
  // through JS doubles. Its deterministic jsonb representation also removes
  // object-key order and transport whitespace from the identity hash.
  const encoded = await client.query<{ canonical: string }>('SELECT $1::jsonb::text AS canonical', [encodedEnvelope]);
  const hash = createHash('sha256').update(encoded.rows[0]?.canonical ?? '').digest('hex');
  const eventId = randomUUID();
  const key = await client.query('INSERT INTO event_keys(installation_id,client_event_id,event_id,occurred_at,payload_hash,first_seen) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id', [envelope.installation_id, envelope.client_event_id, eventId, envelope.occurred_at, hash, options.receivedAt]);
  if (!key.rowCount) {
    const existing = await client.query<{ payload_hash: string }>('SELECT payload_hash FROM event_keys WHERE installation_id=$1 AND client_event_id=$2', [envelope.installation_id, envelope.client_event_id]);
    return existing.rows[0]?.payload_hash === hash ? { outcome: 'duplicate' } : { outcome: 'rejected', reason: 'event_id_conflict' };
  }
  const session = await client.query<{ id: string }>(`INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,$3,$4,$4)
    ON CONFLICT(user_id,source_session_id) DO UPDATE SET first_at=LEAST(sessions.first_at,excluded.first_at),last_at=GREATEST(sessions.last_at,excluded.last_at) RETURNING id`, [randomUUID(), userId, envelope.source_session_id, envelope.occurred_at]);
  const sessionId = session.rows[0]?.id;
  if (!sessionId) throw new Error('Session identity unavailable');
  const membership = await client.query<{ department_id: string }>("SELECT department_id FROM membership_periods WHERE user_id=$1 AND tstzrange(valid_from,valid_to,'[)') @> $2::timestamptz", [userId, envelope.occurred_at]);
  const job = await client.query<{ generation: number }>(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'derive_session',$2,$3)
    ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=CASE WHEN jobs.status='failed' THEN 0 ELSE jobs.attempt END,error_code=NULL,available_at=now() RETURNING generation`, [randomUUID(), `derive:${sessionId}`, { session_id: sessionId }]);
  // Persist the event and advance only existing day/association queries in the same
  // round trip. No provider request or new billing job is created per Hook.
  await client.query(`WITH accepted AS (
    INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload,schema_version,timestamp_source,capture_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb->'payload',$10,$11,$12)
  ) UPDATE jobs j SET available_at=$3::timestamptz+interval '5 minutes'
    WHERE j.kind IN('usage_sync','usage_attribution') AND j.status='succeeded' AND j.payload->>'recurring'='true' AND j.available_at>$3::timestamptz+interval '5 minutes'
    AND j.dedupe_key IN(SELECT 'usage:'||s.provider_account||':'||s.user_id::text||':'||s.business_date::text FROM usage_scopes s WHERE s.user_id=$4 AND s.business_date=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
      UNION SELECT 'usage-link:'||i.provider_account||':'||$7::text FROM usage_provider_identities i WHERE i.user_id=$4)`, [eventId, envelope.occurred_at, options.receivedAt, userId, membership.rows[0]?.department_id ?? null, envelope.installation_id, sessionId, envelope.event_type, encodedEnvelope, envelope.schema_version, envelope.timestamp_source ?? 'unknown', job.rows[0]!.generation]);
  if(envelope.event_type==='Stop')await client.query(`INSERT INTO jobs(id,kind,dedupe_key,payload,available_at)
    SELECT gen_random_uuid(),'usage_attribution','usage-link:'||p.provider_account||':'||$1::text,jsonb_build_object('provider_account',p.provider_account,'session_id',$1::text,'recurring',true),$3
    FROM usage_provider_identities p WHERE p.user_id=$2
    ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,payload=jobs.payload||'{"recurring":true}'::jsonb,
     status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=excluded.available_at`,[sessionId,userId,options.receivedAt]);
  await client.query('UPDATE installations SET last_seen=GREATEST(last_seen,$2) WHERE id=$1', [envelope.installation_id, options.receivedAt]);
  await client.query('UPDATE users SET adopted_at=GREATEST(registered_at,$2::timestamptz) WHERE id=$1 AND registered_at IS NOT NULL AND adopted_at IS NULL', [userId, options.receivedAt]);
  const projectOutcome=envelope.project?await persistProjectContext(client,envelope.project,{userId,eventId,eventAt:envelope.occurred_at,sessionId,receivedAt:options.receivedAt,cleanupGeneration:user.rows[0].cleanup_generation}):undefined;
  return { outcome: 'committed', eventId, sessionId,...(projectOutcome?{project_outcome:projectOutcome}:{}) };
}
