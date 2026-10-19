import {createHash} from 'node:crypto';
import {normalizeRepositoryAddresses,type ProjectObservation} from '@adi/contracts';
import type {Transaction} from './index.js';
import {normalizeProjectPath} from './project-path.js';

export type ProjectSourceKind='hook'|'plugin';
export type ObservationOutcome='accepted'|'cached'|'unchanged'|'conflict'|'invalid'|'expired'|'cleared'|'superseded';
type Source={userId:string;sourceKind:ProjectSourceKind;receivedAt:Date;cleanupGeneration:number;eventId?:string;eventAt?:string;sessionId?:string;sourceConfigId?:string;pluginVersion?:string};
type Input={collector_id:string;platform:'macos'|'windows'|'linux';workspace:string;observation:ProjectObservation};
type Stream={id:string;latest_sequence:string;confirmed_sequence:string;seen_sequence:string;barrier_sequence:string};
type Key={observation_id:string;sequence:string;payload_hash:string;fact_id:string|null;cleared:boolean;project_id:string;received_at:Date|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Shared fact writer. The caller must hold the authenticated person's row lock. */
export async function persistProjectObservation(sql:Transaction,input:Input,source:Source){
  const observed=input.observation,workspace=normalizeProjectPath(input.workspace,input.platform);
  if(!workspace||!Number.isFinite(Date.parse(observed.observed_at))||Date.parse(observed.observed_at)>source.receivedAt.getTime()+300000)
    return {outcome:'invalid' as ObservationOutcome,projectId:null,observationId:null,receivedAt:source.receivedAt.toISOString(),stateChanged:false};
  const collector=input.collector_id.toLowerCase(),id=observed.id.toLowerCase(),kind=source.sourceKind;
  const workspaceKey=hash(JSON.stringify([input.platform,workspace]));
  const remotes=normalizeRepositoryAddresses(observed.remotes);
  const evidence={workspace:input.workspace,platform:input.platform,git_root:observed.git_root,reason:observed.reason,remotes};
  const canonical=(await sql.query<{payload:string}>('SELECT $1::jsonb::text AS payload',[{workspace,platform:input.platform,git_root:observed.git_root===null?null:normalizeProjectPath(observed.git_root,input.platform),reason:observed.reason,remotes}])).rows[0]!.payload;
  const payloadHash=hash(JSON.stringify([workspaceKey,observed.sequence,new Date(observed.observed_at).toISOString(),observed.state,canonical]));
  const stateHash=hash(JSON.stringify([observed.state,observed.reason,observed.git_root===null?null:normalizeProjectPath(observed.git_root,input.platform),remotes.map(r=>r.address).sort()]));
  const keys=(await sql.query<Key>('SELECT observation_id,sequence::text,payload_hash,fact_id,cleared,project_id,received_at FROM project_observation_keys WHERE user_id=$1 AND source_kind=$2 AND collector_id=$3 AND (observation_id=$4 OR sequence=$5)',[source.userId,kind,collector,id,observed.sequence])).rows;
  if(keys.some(k=>k.observation_id!==id||k.sequence!==observed.sequence||k.payload_hash!==payloadHash))return {outcome:'conflict' as ObservationOutcome,projectId:null,observationId:null,receivedAt:source.receivedAt.toISOString(),stateChanged:false};
  const stream=(await sql.query<Stream>(`INSERT INTO project_streams(user_id,source_kind,collector_id,workspace_key,platform) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,source_kind,collector_id,workspace_key) DO UPDATE SET platform=excluded.platform
    RETURNING id,latest_sequence::text,confirmed_sequence::text,seen_sequence::text,barrier_sequence::text`,[source.userId,kind,collector,workspaceKey,input.platform])).rows[0]!;
  const reply=(outcome:ObservationOutcome,observationId:string|null=null,receivedAt=source.receivedAt.toISOString(),stateChanged=false)=>({outcome,projectId:stream.id,observationId,receivedAt,stateChanged});
  if(keys.some(k=>k.observation_id!==id||k.sequence!==observed.sequence||k.payload_hash!==payloadHash||k.project_id!==stream.id))return reply('conflict');
  const policy=(await sql.query<{expired:boolean;cleared:boolean;available:boolean}>(`SELECT
    recovery_id IS NULL AND collection_enabled AS available,
    $2::timestamptz<COALESCE(collection_baseline_at,'-infinity') OR
      ($4='hook' AND $2::timestamptz<GREATEST($3::timestamptz-interval '365 days',COALESCE(retention_cutoff,'-infinity'))) AS expired,
    EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=$1 AND
      ((t.from_at<=$2::timestamptz AND t.to_at>$2::timestamptz) OR ($5::timestamptz IS NOT NULL AND t.from_at<=$5::timestamptz AND t.to_at>$5::timestamptz))) AS cleared
    FROM data_identity FOR SHARE`,[source.userId,observed.observed_at,source.receivedAt,kind,keys.length?null:source.eventAt??null])).rows[0];
  if(!policy?.available)throw Object.assign(new Error('Collection unavailable'),{code:'collection_unavailable',status:503});
  if(policy.expired)return reply('expired');
  if(policy.cleared||keys[0]?.cleared)return reply('cleared');
  if(keys.length){
    const key=keys[0]!;
    if(!key.fact_id||!(await sql.query(`SELECT 1 FROM project_observations o WHERE user_id=$1 AND source_kind=$2 AND collector_id=$3 AND id=$4 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=o.user_id AND ((t.from_at<=o.observed_at AND t.to_at>o.observed_at) OR (t.from_at<=o.source_event_at AND t.to_at>o.source_event_at)))`,[source.userId,kind,collector,key.fact_id])).rowCount)return reply('superseded');
    return reply('cached',key.fact_id,key.received_at?.toISOString()??source.receivedAt.toISOString());
  }
  if(BigInt(observed.sequence)<=BigInt(stream.barrier_sequence))return reply('superseded');
  const latest=(await sql.query<{id:string;state_hash:string}>(`SELECT id,state_hash FROM project_observations o WHERE project_id=$1 AND sequence=$2 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=o.user_id AND ((t.from_at<=o.observed_at AND t.to_at>o.observed_at) OR (t.from_at<=o.source_event_at AND t.to_at>o.source_event_at)))`,[stream.id,stream.latest_sequence])).rows[0];
  const changed=!latest||latest.state_hash!==stateHash;
  const factId=changed?id:latest.id;
  await sql.query(`INSERT INTO project_observation_keys(user_id,source_kind,collector_id,observation_id,sequence,project_id,workspace_key,payload_hash,fact_id,observed_at,source_event_at,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[source.userId,kind,collector,id,observed.sequence,stream.id,workspaceKey,payloadHash,factId,observed.observed_at,source.eventAt??null,source.receivedAt]);
  if(changed){
    await sql.query(`INSERT INTO project_observations(user_id,source_kind,collector_id,id,sequence,project_id,observed_at,received_at,source_event_id,source_event_at,source_session_id,cleanup_generation,payload_hash,state,state_hash,evidence,source_config_id,plugin_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[source.userId,kind,collector,id,observed.sequence,stream.id,observed.observed_at,source.receivedAt,source.eventId??null,source.eventAt??null,source.sessionId??null,source.cleanupGeneration,payloadHash,observed.state,stateHash,evidence,source.sourceConfigId??null,source.pluginVersion??null]);
  }
  const confirmed=['repository','not_git','no_remote'].includes(observed.state);
  await sql.query(`UPDATE project_streams SET seen_sequence=GREATEST(seen_sequence,$2::bigint),
    latest_sequence=CASE WHEN $3 THEN GREATEST(latest_sequence,$2::bigint) ELSE latest_sequence END,
    confirmed_sequence=CASE WHEN $3 AND $4 THEN GREATEST(confirmed_sequence,$2::bigint) ELSE confirmed_sequence END WHERE id=$1`,[stream.id,observed.sequence,changed,confirmed]);
  return reply(changed?'accepted':'unchanged',factId,source.receivedAt.toISOString(),changed);
}
