import {frozenProjectPages,frozenProjectKeyPages,restoreProjectBarriers,restoreProjectDeletedKeys} from './project-cleanup-proof.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Database,Transaction,CleanupJournal,CleanupRecord,CleanupCheckpointRef} from '@adi/storage';
import {DomainError} from './errors.js';
import {runCleanupBatch,type CleanupBatchRequest} from './cleanup-worker.js';

type Run={id:string;dataset_id:string;state:string;inventory_digest:string|null;prepare_token:string|null;checkpoint_id:string|null;checkpoint_digest:string|null;release_summary:{operations:number;remaining:number;absent_users:number}|null};
type Operation={job_id:string;record:CleanupRecord;journal_digest:string;cleanup_generation:number;phase:string;progress:CleanupBatchRequest['progress']};
const fingerprint=(entries:{record:CleanupRecord;digest:string}[])=>createHash('sha256').update(entries.map(item=>`${item.record.operation_id}:${item.digest}`).sort().join('\n')).digest('hex');

/** Operator-only: the target must already be an isolated, offline restored database.
 * This service deliberately has no HTTP route and no command that reopens serving.
 */
export function createRecoveryService(db:Database,journal:CleanupJournal,options:{operatorLabel?:string}={}){
 const operatorLabel=options.operatorLabel??'local-operator';if(!operatorLabel.trim()||operatorLabel.length>254)throw new Error('Recovery operator label required');
 const verified=async(dataset:string,expected:CleanupCheckpointRef)=>{try{return await journal.verifyCheckpoint(dataset,expected);}catch{throw new DomainError('recovery_checkpoint_mismatch',409);}};
 async function current(sql:Transaction,id:string,lock=false,allowReleased=false){
  const row=(await sql.query<Run>(`SELECT r.* FROM recovery_runs r JOIN data_identity d ON (d.recovery_id=r.id${allowReleased?" OR (d.recovery_id IS NULL AND r.state='released')":''}) AND d.dataset_id=r.dataset_id WHERE r.id=$1${lock?' FOR UPDATE OF d,r':''}`,[id])).rows[0];
  if(!row)throw new DomainError('recovery_context_changed',409);return row;
 }
 async function quarantine(expectedDataset:string){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedDataset))throw new DomainError('invalid_dataset',422);
  return db.transaction(async sql=>{
   const data=(await sql.query<{dataset_id:string;recovery_id:string|null}>('SELECT dataset_id,recovery_id FROM data_identity FOR UPDATE')).rows[0];
   if(data?.dataset_id!==expectedDataset)throw new DomainError('dataset_identity_changed',409);
   if(data.recovery_id){await sql.query("UPDATE jobs SET generation=generation+1,progress='{}' WHERE kind='usage_attribution' AND progress<>'{}'::jsonb");return {id:data.recovery_id};}
   const id=randomUUID();await sql.query("INSERT INTO recovery_runs(id,dataset_id,state,operator_label) VALUES($1,$2,'quarantined',$3)",[id,expectedDataset,operatorLabel]);
   await sql.query('UPDATE data_identity SET recovery_id=$1',[id]);
   await sql.query('UPDATE users SET auth_version=auth_version+1,ingest_epoch=ingest_epoch+1,version=version+1');
   await sql.query('DELETE FROM login_sessions');
   await sql.query("UPDATE credentials SET must_change=true,temporary_expires_at='1970-01-01Z',updated_at=clock_timestamp()");
   await sql.query('UPDATE installations SET enabled=false');
   await sql.query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_token=NULL,lease_until=NULL,progress=CASE WHEN kind='usage_attribution' THEN '{}'::jsonb ELSE progress END,error_code='recovery_quarantined' WHERE status IN('queued','running')");
   await sql.query("UPDATE jobs SET generation=generation+1,progress='{}' WHERE kind='usage_attribution' AND progress<>'{}'::jsonb");
   await sql.query("UPDATE monitor_alert_events SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error='recovery_quarantined' WHERE status IN('queued','running')");
   await sql.query("UPDATE monitor_alerts SET severity='resolved',last_observed_at=clock_timestamp()");
   await sql.query("UPDATE database_monitor_state SET last_error='recovery_quarantined',next_run_at=clock_timestamp(),revision=revision+1");
   await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'recovery_quarantined',$2)",[id,{dataset_id:expectedDataset}]);
   return {id};
  });
 }
 async function prepare(id:string,expected:CleanupCheckpointRef){
  if(!expected)throw new DomainError('recovery_checkpoint_required',409);
  const token=randomUUID();const run=await db.transaction(async sql=>{const run=await current(sql,id,true);await sql.query("UPDATE recovery_runs SET state='preparing',prepare_token=$2,checkpoint_id=$3,checkpoint_digest=$4,access_review_id=NULL,access_state_digest=NULL,release_token_hash=NULL,bootstrap_auth_version=NULL,credential_expires_at=NULL WHERE id=$1",[id,token,expected.checkpoint_id,expected.digest]);return run;});
  const guard=async(sql:Transaction)=>{const fresh=await current(sql,id,true);if(fresh.state!=='preparing'||fresh.prepare_token!==token)throw new DomainError('recovery_preparation_changed',409);};
  const entries=await verified(run.dataset_id,expected); // Validate every part against the independently pinned checkpoint.
  entries.sort((a,b)=>a.record.user_id.localeCompare(b.record.user_id)||a.record.cleanup_generation-b.record.cleanup_generation||a.record.operation_id.localeCompare(b.record.operation_id));
  const ids=new Set(entries.map(entry=>entry.record.operation_id));
  const known=await db.query<{job_id:string}>("SELECT job_id FROM cleanup_requests UNION SELECT operation_id AS job_id FROM recovery_cleanup_operations WHERE run_id=$1",[id]);
  if(known.rows.some(row=>!ids.has(row.job_id)))throw new DomainError('recovery_inventory_incomplete',409);
  for(const entry of entries){
   const record=entry.record;
   const replayId=await db.transaction(async sql=>{
    await guard(sql);
    const existing=(await sql.query<{job_id:string;journal_digest:string;run_id:string;accepted_digest:string|null;manifest_digest:string|null}>('SELECT job_id,journal_digest,run_id,accepted_digest,manifest_digest FROM recovery_cleanup_operations WHERE operation_id=$1 AND run_id=$2',[record.operation_id,id])).rows[0];
    if(existing){
     if(existing.run_id!==id)throw new DomainError('recovery_journal_conflict',409);
     if(existing.journal_digest!==entry.digest){
      const stronger=(existing.accepted_digest!==null&&existing.accepted_digest===entry.accepted_digest&&(existing.manifest_digest===null||existing.manifest_digest===entry.manifest_digest))||(existing.manifest_digest!==null&&existing.manifest_digest===entry.manifest_digest&&(existing.accepted_digest===null||existing.accepted_digest===entry.accepted_digest));
      if(!stronger)throw new DomainError('recovery_journal_conflict',409);
      await sql.query('UPDATE recovery_cleanup_operations SET journal_digest=$2,accepted_digest=$3,manifest_digest=$4 WHERE job_id=$1',[existing.job_id,entry.digest,entry.accepted_digest,entry.manifest_digest]);
     }return existing.job_id;
    }
    const user=(await sql.query<{cleanup_generation:number}>('SELECT cleanup_generation FROM users WHERE id=$1 FOR UPDATE',[record.user_id])).rows[0];
    const replayId=randomUUID();await sql.query('INSERT INTO recovery_cleanup_operations(job_id,run_id,record,journal_digest,user_id,cleanup_generation,complete,absent_user,accepted_digest,manifest_digest,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)',[replayId,id,record,entry.digest,user?record.user_id:null,record.cleanup_generation,!user,entry.accepted_digest,entry.manifest_digest,record.operation_id]);return replayId;
   });
   // Immutable, fully validated parts are copied in small transactions, and may be retried.
   for await(const sessions of entry.sessions())await db.transaction(async sql=>{
    await guard(sql);
    if((await sql.query('SELECT 1 FROM sessions WHERE id=ANY($1::uuid[]) AND user_id<>$2 LIMIT 1',[sessions,record.user_id])).rowCount)throw new DomainError('recovery_subject_conflict',409);
    await sql.query('INSERT INTO recovery_cleanup_sessions(job_id,session_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[replayId,sessions]);
   });
   for await(const barriers of entry.projects())await db.transaction(async sql=>{await guard(sql);await restoreProjectBarriers(sql,record.user_id,barriers);});
   for await(const keys of entry.projectKeys())await db.transaction(async sql=>{await guard(sql);await restoreProjectDeletedKeys(sql,record.user_id,keys);});
   await db.transaction(async sql=>{
    await guard(sql);
    const user=(await sql.query<{cleanup_generation:number}>('SELECT cleanup_generation FROM users WHERE id=$1 FOR UPDATE',[record.user_id])).rows[0];if(!user)return;
    const barrier=(await sql.query('SELECT 1 FROM cleanup_tombstones WHERE user_id=$1 AND from_at=$2 AND to_at=$3 AND generation=$4',[record.user_id,record.from,record.to,record.cleanup_generation])).rowCount;
    if(!barrier&&user.cleanup_generation>=record.cleanup_generation)throw new DomainError('recovery_generation_conflict',409);
    await sql.query('INSERT INTO recovery_cleanup_sessions(job_id,session_id) SELECT $1,c.session_id FROM cleanup_sessions c JOIN sessions s ON s.id=c.session_id WHERE c.job_id=$3 AND s.user_id=$2 ON CONFLICT DO NOTHING',[replayId,record.user_id,record.operation_id]);
    await sql.query('INSERT INTO recovery_cleanup_sessions(job_id,session_id) SELECT $1,session_id FROM hook_events WHERE user_id=$2 AND occurred_at>=$3 AND occurred_at<$4 GROUP BY session_id ON CONFLICT DO NOTHING',[replayId,record.user_id,record.from,record.to]);
    await sql.query('UPDATE sessions SET history_redacted=true WHERE user_id=$2 AND id IN(SELECT session_id FROM recovery_cleanup_sessions WHERE job_id=$1)',[replayId,record.user_id]);
    if(!barrier)await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,$4)',[record.user_id,record.from,record.to,record.cleanup_generation]);
    if(user.cleanup_generation<record.cleanup_generation){
     for(const table of ['session_derivations','session_personal_models','usage_attribution_evidence'] as const)await sql.query(`UPDATE ${table} SET cleanup_generation=$3 WHERE user_id=$1 AND cleanup_generation=$2 ${table==='session_derivations'?"AND state='published'":''} AND session_id NOT IN(SELECT session_id FROM recovery_cleanup_sessions WHERE job_id=$4)`,[record.user_id,user.cleanup_generation,record.cleanup_generation,replayId]);
     await sql.query('UPDATE users SET cleanup_generation=$2,version=version+1 WHERE id=$1',[record.user_id,record.cleanup_generation]);
     await sql.query('INSERT INTO personal_model_revisions(user_id,revision) VALUES($1,1) ON CONFLICT(user_id) DO UPDATE SET revision=personal_model_revisions.revision+1',[record.user_id]);
    }
   });
  }
  await db.transaction(async sql=>{await guard(sql);await sql.query("UPDATE recovery_runs SET state='replaying',inventory_digest=$2,updated_at=clock_timestamp() WHERE id=$1",[id,fingerprint(entries)]);});
  return {operations:entries.length};
 }
 async function step(id:string){
  const run=await current(db,id);if(run.state==='awaiting_identity_review')return false;if(run.state!=='replaying')throw new DomainError('recovery_not_prepared',409);if(!run.checkpoint_id||!run.checkpoint_digest)throw new DomainError('recovery_checkpoint_required',409);
  const operation=(await db.query<Operation>('SELECT * FROM recovery_cleanup_operations WHERE run_id=$1 AND NOT complete ORDER BY (record->>\'cleanup_generation\')::int,job_id LIMIT 1',[id])).rows[0];
  if(!operation){
   const entries=await verified(run.dataset_id,{checkpoint_id:run.checkpoint_id,digest:run.checkpoint_digest});if(fingerprint(entries)!==run.inventory_digest)throw new DomainError('recovery_inventory_changed',409);
   await db.transaction(async sql=>{const fresh=await current(sql,id,true);if(fresh.state!=='replaying'||fresh.prepare_token!==run.prepare_token||fresh.inventory_digest!==run.inventory_digest)throw new DomainError('recovery_inventory_changed',409);if((await sql.query('SELECT 1 FROM recovery_cleanup_operations WHERE run_id=$1 AND NOT complete LIMIT 1',[id])).rowCount)return;
    await sql.query("UPDATE recovery_runs SET state='awaiting_identity_review',updated_at=clock_timestamp() WHERE id=$1",[id]);await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'recovery_cleanup_replayed',$2)",[id,{operations:entries.length,inventory_digest:run.inventory_digest}]);});return false;
  }
  const header=await journal.inspectProof(run.dataset_id,operation.record.operation_id);if(header.digest!==operation.journal_digest)throw new DomainError('recovery_journal_conflict',409);
  await db.transaction(async sql=>{
   const active=await current(sql,id,true);if(active.state!=='replaying'||active.prepare_token!==run.prepare_token)throw new DomainError('recovery_context_changed',409);
   const fresh=(await sql.query<Operation&{complete:boolean}>('SELECT * FROM recovery_cleanup_operations WHERE job_id=$1 AND run_id=$2 FOR UPDATE',[operation.job_id,id])).rows[0];if(!fresh||fresh.complete)return;
   await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[fresh.record.user_id]);
   await runCleanupBatch(sql,{user_id:fresh.record.user_id,from_at:new Date(fresh.record.from),to_at:new Date(fresh.record.to),cleanup_generation:fresh.cleanup_generation,executor_id:null,source_operation_id:fresh.record.operation_id,journal_digest:fresh.journal_digest,phase:fresh.phase,progress:fresh.progress},fresh.job_id,100,'recovery_cleanup_sessions',async(phase,progress,done)=>{
    await sql.query('UPDATE recovery_cleanup_operations SET phase=$2,progress=$3,complete=$4 WHERE job_id=$1',[fresh.job_id,phase,progress,done??false]);
   });
  });return true;
 }
 async function status(id:string){const run=await current(db,id,false,true);const counts=run.state==='released'&&run.release_summary?run.release_summary:(await db.query<{operations:number;remaining:number;absent_users:number}>('SELECT count(*)::int AS operations,count(*) FILTER(WHERE NOT complete)::int AS remaining,count(DISTINCT (record->>\'user_id\')) FILTER(WHERE absent_user)::int AS absent_users FROM recovery_cleanup_operations WHERE run_id=$1',[id])).rows[0]!;return {id:run.id,dataset_id:run.dataset_id,state:run.state,checkpoint_id:run.checkpoint_id,checkpoint_digest:run.checkpoint_digest,...counts,serving:run.state==='released'};}
 return {quarantine,prepare,step,status};
}


/** Export only from the current source while cleanup writers are stopped. */
export async function createCleanupCheckpoint(db:Pick<Database,'query'|'assertNotRecovering'>,journal:CleanupJournal,expectedDataset:string){
 await db.assertNotRecovering();
 const dataset=(await db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]?.dataset_id;
 if(dataset!==expectedDataset)throw new DomainError('dataset_identity_changed',409);
 const snapshot=()=>db.query<{job_id:string;dataset_id:string;user_id:string;creator_id:string;target_email:string;from_at:Date;to_at:Date;created_at:Date;cleanup_generation:number;acceptance_digest:string|null;journal_digest:string|null;phase:string;project_barriers_required:boolean}>(`WITH recovered AS (
   SELECT DISTINCT ON(o.operation_id) o.operation_id AS job_id,(o.record->>'dataset_id')::uuid AS dataset_id,(o.record->>'user_id')::uuid AS user_id,(o.record->>'actor_id')::uuid AS creator_id,o.record->>'target_email' AS target_email,(o.record->>'from')::timestamptz AS from_at,(o.record->>'to')::timestamptz AS to_at,(o.record->>'created_at')::timestamptz AS created_at,(o.record->>'cleanup_generation')::int AS cleanup_generation,o.accepted_digest AS acceptance_digest,o.manifest_digest AS journal_digest,'recovered'::text AS phase,(o.record ? 'project_barriers') AS project_barriers_required
   FROM recovery_cleanup_operations o JOIN recovery_runs r ON r.id=o.run_id WHERE o.complete AND r.state='released' AND NOT EXISTS(SELECT 1 FROM cleanup_requests c WHERE c.job_id=o.operation_id)
   ORDER BY o.operation_id,r.updated_at DESC,r.id DESC
  ) SELECT job_id,dataset_id,user_id,creator_id,target_email,from_at,to_at,created_at,cleanup_generation,acceptance_digest,journal_digest,phase,project_barriers_required FROM cleanup_requests UNION ALL SELECT * FROM recovered ORDER BY job_id LIMIT 10001`);
 const before=(await snapshot()).rows;if(before.length>10000)throw new DomainError('cleanup_checkpoint_limit',409);
 const sourceDigest=createHash('sha256').update(JSON.stringify(before)).digest('hex');
 const checkpoint=await journal.createCheckpoint(expectedDataset,sourceDigest).catch(()=>{throw new DomainError('cleanup_checkpoint_incomplete',409);}),entries=await journal.verifyCheckpoint(expectedDataset,checkpoint).catch(()=>{throw new DomainError('cleanup_checkpoint_incomplete',409);});
 if(entries.length!==before.length)throw new DomainError('cleanup_checkpoint_incomplete',409);
 const byId=new Map(entries.map(entry=>[entry.record.operation_id,entry]));
 for(const row of before){const entry=byId.get(row.job_id),r=entry?.record;
  if(!entry||!r||row.project_barriers_required!==!!r.project_barriers||row.dataset_id!==dataset||r.dataset_id!==dataset||r.user_id!==row.user_id||r.actor_id!==row.creator_id||r.target_email!==row.target_email||r.from!==row.from_at.toISOString()||r.to!==row.to_at.toISOString()||r.created_at!==row.created_at.toISOString()||r.cleanup_generation!==row.cleanup_generation||(row.acceptance_digest&&entry.accepted_digest!==row.acceptance_digest)||(row.journal_digest&&entry.manifest_digest!==row.journal_digest)||(!['journal','journal_verify','journal_seal','recovered'].includes(row.phase)&&!entry.manifest_digest))throw new DomainError('cleanup_checkpoint_incomplete',409);
  if(row.project_barriers_required&&row.phase!=='recovered'){
   const frozen=frozenProjectPages(db,row.job_id);
   for await(const page of entry.projects()){const expected=await frozen.next();if(expected.done||JSON.stringify(expected.value)!==JSON.stringify(page))throw new DomainError('cleanup_checkpoint_incomplete',409);}
   if(!(await frozen.next()).done)throw new DomainError('cleanup_checkpoint_incomplete',409);
   const keys=frozenProjectKeyPages(db,row.job_id);
   for await(const page of entry.projectKeys()){const expected=await keys.next();if(expected.done||JSON.stringify(expected.value)!==JSON.stringify(page))throw new DomainError('cleanup_checkpoint_incomplete',409);}
   if(!(await keys.next()).done)throw new DomainError('cleanup_checkpoint_incomplete',409);
  }
 }
 await db.assertNotRecovering();if(JSON.stringify((await snapshot()).rows)!==JSON.stringify(before))throw new DomainError('cleanup_writers_active',409);
 return {...checkpoint,dataset_id:dataset,source_digest:sourceDigest};
}
