import {createHash,randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import type {Database,Queryable} from '@adi/storage';
import {DomainError} from './errors.js';
import {loadSessionListSnapshotOwner,type SessionListSnapshotOwner} from './session-list-snapshot-loader.js';

export type SessionListSafetyFence={dataset_id:string;recovery_id:string|null;retention_cutoff:string|null;cleanup:Record<string,number>};
export type SessionListSnapshot={id:string;config_key:string;provider_account:string|null;as_of:Date;expires_at:Date;safety_fence:SessionListSafetyFence;owner_entries:Record<string,string>;state:'published'};
export type SessionListSnapshotLoader=(client:Queryable,account:string|null,owner:string,period:{from:string;to:string},stopWindowEnabled:boolean)=>Promise<SessionListSnapshotOwner>;
export function sessionListSnapshotConfigKey(account:string|null,stopWindowEnabled=false){return createHash('sha256').update(JSON.stringify([account,stopWindowEnabled])).digest('hex');}

export async function readSessionListSafetyFence(client:Queryable,lock=false,owners?:string[]):Promise<SessionListSafetyFence>{
 if(!lock){
  const row=(await client.query<{dataset_id:string;recovery_id:string|null;retention_cutoff:string|null;cleanup:Record<string,number>}>(`SELECT dataset_id,recovery_id,retention_cutoff::text AS retention_cutoff,
   COALESCE((SELECT jsonb_object_agg(id::text,cleanup_generation) FROM users WHERE $1::uuid[] IS NULL OR id=ANY($1::uuid[])),'{}'::jsonb) AS cleanup FROM data_identity`,[owners??null])).rows[0];
  if(!row||row.recovery_id)throw new DomainError('recovery_quarantined',503);
  return row;
 }
 const identity=(await client.query<{dataset_id:string;recovery_id:string|null;retention_cutoff:string|null}>(`SELECT dataset_id,recovery_id,retention_cutoff::text AS retention_cutoff FROM data_identity${lock?' FOR SHARE':''}`)).rows[0];
 if(!identity||identity.recovery_id)throw new DomainError('recovery_quarantined',503);
 const lockedOwners=(await client.query<{id:string;cleanup_generation:number}>(`SELECT id,cleanup_generation FROM users ORDER BY id${lock?' FOR SHARE':''}`)).rows;
 return {...identity,cleanup:Object.fromEntries(lockedOwners.map(owner=>[owner.id,owner.cleanup_generation]))};
}
export function sessionListSafetyFenceMatches(before:SessionListSafetyFence,current:SessionListSafetyFence,owners=Object.keys(before.cleanup)){
 return before.dataset_id===current.dataset_id&&before.recovery_id===current.recovery_id&&before.retention_cutoff===current.retention_cutoff&&owners.every(owner=>before.cleanup[owner]===current.cleanup[owner]);
}

// Metadata only: derive job generations detect every accepted Hook, including
// equal-timestamp additions. No event payload or million-row Hook scan is used.
const revisionsSql=`WITH parts AS (
 SELECT u.id AS user_id,'user' AS kind,to_jsonb(u)::text AS value FROM users u
 UNION ALL SELECT r.user_id,'roles',md5(string_agg(to_jsonb(r)::text,',' ORDER BY r.id)) FROM role_grants r GROUP BY r.user_id
 UNION ALL SELECT s.user_id,'sessions',md5(string_agg(jsonb_build_array(s.id,s.first_at,s.last_at,s.history_redacted,s.history_expired,s.derived_run_id,COALESCE(j.generation,0))::text,',' ORDER BY s.id))
  FROM sessions s LEFT JOIN jobs j ON j.dedupe_key='derive:'||s.id::text GROUP BY s.user_id
 UNION ALL SELECT m.user_id,'membership',md5(string_agg(to_jsonb(m)::text,',' ORDER BY m.id)) FROM membership_periods m GROUP BY m.user_id
 UNION ALL SELECT r.user_id,'personal_revision',r.revision::text FROM personal_model_revisions r
 UNION ALL SELECT p.user_id,'models',md5(string_agg(jsonb_build_array(p.session_id,p.version,p.cleanup_generation,p.models,p.xmin::text)::text,',' ORDER BY p.session_id)) FROM session_personal_models p GROUP BY p.user_id
 UNION ALL SELECT q.user_id,'queries',md5(string_agg(jsonb_build_array(q.session_id,q.revision,q.xmin::text)::text,',' ORDER BY q.session_id)) FROM session_usage_queries q WHERE $2::boolean AND q.provider_account=$1 GROUP BY q.user_id
 UNION ALL SELECT s.user_id,'scopes',md5(string_agg(jsonb_build_array(s.id,s.revision,s.xmin::text)::text,',' ORDER BY s.id)) FROM usage_scopes s WHERE s.provider_account=$1 GROUP BY s.user_id
 UNION ALL SELECT s.user_id,'usage_runs',md5(string_agg(jsonb_build_array(r.id,r.state,r.content_hash,r.xmin::text)::text,',' ORDER BY r.id)) FROM usage_snapshot_runs r JOIN usage_scopes s ON s.id=r.scope_id WHERE s.provider_account=$1 GROUP BY s.user_id
 UNION ALL SELECT i.user_id,'provider_identity',md5(string_agg(to_jsonb(i)::text,',' ORDER BY i.provider_user_id)) FROM usage_provider_identities i WHERE i.provider_account=$1 GROUP BY i.user_id
 UNION ALL SELECT r.user_id,'link_revision',r.revision::text FROM usage_attribution_revisions r WHERE r.provider_account=$1
 UNION ALL SELECT e.user_id,'evidence',md5(string_agg(jsonb_build_array(e.session_id,e.billing_session_id,e.cleanup_generation,e.ingest_epoch,e.provider_user_id,e.xmin::text)::text,',' ORDER BY e.session_id,e.billing_session_id)) FROM usage_attribution_evidence e WHERE e.provider_account=$1 GROUP BY e.user_id
 UNION ALL SELECT a.user_id,'subjects',md5(string_agg(jsonb_build_array(a.session_id,a.generation,a.probe_state,a.cleanup_generation,a.xmin::text)::text,',' ORDER BY a.session_id)) FROM usage_attribution_subjects a WHERE a.provider_account=$1 GROUP BY a.user_id
 UNION ALL SELECT COALESCE(u.id,s.user_id),'pending',md5(string_agg(jsonb_build_array(j.id,j.kind,j.generation,j.status,j.payload->>'business_date')::text,',' ORDER BY j.id))
  FROM jobs j LEFT JOIN users u ON u.id::text=j.payload->>'user_id' LEFT JOIN sessions s ON s.id::text=j.payload->>'session_id'
  WHERE j.kind IN('usage_sync','usage_attribution') AND j.payload->>'provider_account'=$1 AND j.status IN('queued','running') GROUP BY COALESCE(u.id,s.user_id)
 ) SELECT u.id AS user_id,u.cleanup_generation,md5($3::text||':'||$4::text||':'||COALESCE(string_agg(p.kind||':'||COALESCE(p.value,''),',' ORDER BY p.kind),'')) AS revision
 FROM users u LEFT JOIN parts p ON p.user_id=u.id GROUP BY u.id ORDER BY u.id`;

export function createSessionListSnapshotPublisher(db:Database,options:{providerAccount?:string;stopWindowEnabled?:boolean;clock?:()=>Date;intervalMs?:number;loadOwner?:SessionListSnapshotLoader}={}){
 const now=options.clock??(()=>new Date()),account=options.providerAccount??null,stop=options.stopWindowEnabled===true;
 const interval=options.intervalMs??5000;if(!Number.isInteger(interval)||interval<100||interval>30000)throw new Error('Snapshot refresh interval must be 100..30000 ms');
 const key=sessionListSnapshotConfigKey(account,stop),load=options.loadOwner??loadSessionListSnapshotOwner;
 let next=0,running=false;
 async function latest(){return (await db.query<SessionListSnapshot>("SELECT * FROM session_list_snapshots WHERE config_key=$1 AND expires_at>$2 ORDER BY as_of DESC,created_at DESC,id DESC LIMIT 1",[key,now()])).rows[0]??null;}
 async function runOne(force=false){
  if(running||!force&&now().getTime()<next)return false;
  running=true;next=now().getTime()+interval;
  try{
   const asOf=now(),midnight=Math.floor((asOf.getTime()+28800000)/86400000)*86400000-28800000;
   const period={from:new Date(midnight-44*86400000).toISOString(),to:new Date(midnight+86400000).toISOString()};
   const candidate=await db.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query('SET LOCAL jit=off');
    const fence=await readSessionListSafetyFence(client);
    const vector=(await client.query<{user_id:string;cleanup_generation:number;revision:string}>(revisionsSql,[account,stop,period.from,period.to])).rows;
    const previous=(await client.query<SessionListSnapshot>('SELECT * FROM session_list_snapshots WHERE config_key=$1 ORDER BY as_of DESC,created_at DESC,id DESC LIMIT 1',[key])).rows[0];
    const sameDataset=previous&&previous.safety_fence.dataset_id===fence.dataset_id&&previous.safety_fence.recovery_id===fence.recovery_id&&previous.safety_fence.retention_cutoff===fence.retention_cutoff;
    const ids=sameDataset?Object.values(previous.owner_entries):[];
    const existing=ids.length?(await client.query<{id:string;user_id:string;owner_revision:string;cleanup_generation:number}>('SELECT id,user_id,owner_revision,cleanup_generation FROM session_list_snapshot_entries WHERE id=ANY($1::uuid[])',[ids])).rows:[];
    const cached=new Map(existing.map(entry=>[entry.user_id,entry])),mapping:Record<string,string>={},entries:Array<{id:string;user_id:string;owner_revision:string;cleanup_generation:number;encoded_payload:Buffer}>=[];
    for(const owner of vector){
     const entry=cached.get(owner.user_id);
     if(entry?.owner_revision===owner.revision&&entry.cleanup_generation===owner.cleanup_generation){mapping[owner.user_id]=entry.id;continue;}
     const id=randomUUID(),payload=await load(client,account,owner.user_id,period,stop);
     if(payload.user_id!==owner.user_id||payload.cleanup_generation!==owner.cleanup_generation)throw new DomainError('invalid_session_list_snapshot_owner',503);
     // Keep the candidate's corpus outside V8's object heap. Each owner's rich
     // decoded metadata becomes unreachable before the next owner is loaded.
     const encoded_payload=Buffer.from(JSON.stringify(payload),'utf8');
     entries.push({id,user_id:owner.user_id,owner_revision:owner.revision,cleanup_generation:owner.cleanup_generation,encoded_payload});mapping[owner.user_id]=id;
    }
    return {fence,mapping,entries};
   });
   return await db.transaction(async client=>{
    if(!(await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['session-list-snapshots:'+db.schema])).rows[0]!.locked)return false;
    const current=await readSessionListSafetyFence(client,true);
    if(!sessionListSafetyFenceMatches(candidate.fence,current))throw new DomainError('stale_session_list_snapshot',409);
    if(now().getTime()-asOf.getTime()>=60000)throw new DomainError('session_list_snapshot_build_expired',503);
    const newer=(await client.query('SELECT 1 FROM session_list_snapshots WHERE config_key=$1 AND as_of>$2 LIMIT 1',[key,asOf])).rowCount;
    if(newer)return false;
    const newIds=new Set(candidate.entries.map(entry=>entry.id)),reused=Object.values(candidate.mapping).filter(id=>!newIds.has(id));
    if(reused.length&&(await client.query('SELECT id FROM session_list_snapshot_entries WHERE id=ANY($1::uuid[]) FOR SHARE',[reused])).rowCount!==reused.length)throw new DomainError('stale_session_list_snapshot',409);
    // Bound each parameter's transient allocation. A single owner's JSONB value
    // cannot be split across rows; send an oversized owner alone, without an
    // arbitrary user-size rejection. All batches and publication stay atomic.
    let encoded:string[]=[],bytes=2;
    const flush=async()=>{
     if(!encoded.length)return;
     await client.query(`INSERT INTO session_list_snapshot_entries(id,user_id,owner_revision,cleanup_generation,payload)
      SELECT id,user_id,owner_revision,cleanup_generation,payload FROM jsonb_to_recordset($1::jsonb) x(id uuid,user_id uuid,owner_revision text,cleanup_generation integer,payload jsonb)`,['['+encoded.join(',')+']']);
     encoded=[];bytes=2;
    };
    for(const entry of candidate.entries){
     const {encoded_payload,...metadata}=entry;
     const metadataJson=JSON.stringify(metadata);
     const value=metadataJson.slice(0,-1)+',"payload":'+encoded_payload.toString('utf8')+'}',size=Buffer.byteLength(value);
     if(encoded.length&&(encoded.length>=8||bytes+size+1>1024*1024))await flush();
     encoded.push(value);bytes+=size+(encoded.length>1?1:0);
     if(encoded.length>=8||bytes>1024*1024)await flush();
    }
    await flush();
    // Ordinary Hook/usage additions after the MVCC read belong to the next
    // snapshot. Only safety changes can cancel publication of this complete one.
    const id=randomUUID();await client.query(`INSERT INTO session_list_snapshots(id,config_key,provider_account,as_of,expires_at,safety_fence,owner_entries)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,key,account,asOf,new Date(asOf.getTime()+60000),candidate.fence,candidate.mapping]);
    await client.query('DELETE FROM session_list_snapshots WHERE expires_at<$1',[new Date(now().getTime()-120000)]);
    await client.query(`DELETE FROM session_list_snapshot_entries e WHERE e.created_at<$1 AND NOT EXISTS(
     SELECT 1 FROM session_list_snapshots s WHERE s.owner_entries->>e.user_id::text=e.id::text)`,[new Date(now().getTime()-120000)]);
    return true;
   });
  }finally{running=false;}
 }
 return {runOne,latest,configKey:key};
}
