import {withProjectProof} from './project-cleanup-proof.js';
import {createHash,randomUUID} from 'node:crypto';import type {Database,Transaction,CleanupJournal,CleanupRecord} from '@adi/storage';import type {CurrentUser} from '@adi/contracts';import type {IdentityService} from './identity.js';import {DomainError} from './errors.js';
import {eraseProjectEvidenceBatch,hasProjectEvidenceInRange} from './project-evidence-cleanup.js';
type Progress={part?:number;cursor?:string;chain?:string;journal_sessions?:number;verify_part?:number;verify_chain?:string;verify_cursor?:string;deleted_events?:number;deleted_copies?:number;rebuild_cursor?:string;derived_table?:number};
type Claim={id:string;lease:string;generation:number;attempt:number};
type Request={project_barriers_required:boolean;job_id:string;dataset_id:string;current_dataset:string;creator_id:string;executor_id:string;executor_auth_version:number;user_id:string;target_email:string;from_at:Date;to_at:Date;created_at:Date;cleanup_generation:number;phase:string;journal_digest:string|null;progress:Progress};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');const check=(actor:CurrentUser)=>{if(!actor.roles.includes('super'))throw new DomainError('job_authorization_changed',403);};
export function createCleanupWorker(db:Database,identity:IdentityService,options:{journal?:CleanupJournal;batchSize?:number}={}){
 const batch=options.batchSize??100;if(!Number.isInteger(batch)||batch<1||batch>200)throw new Error('Cleanup batch must be 1..200');
 async function current(client:Transaction,claim:Claim){const row=(await client.query<Request>(`SELECT r.*,j.progress,(SELECT dataset_id FROM data_identity) AS current_dataset FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id WHERE r.job_id=$1 AND j.status='running' AND j.lease_token=$2 AND j.generation=$3 AND j.lease_until>clock_timestamp() FOR UPDATE OF r,j`,[claim.id,claim.lease,claim.generation])).rows[0];if(!row)throw new DomainError('stale_cleanup_lease',409);if(row.dataset_id!==row.current_dataset)throw new DomainError('dataset_identity_changed',409);return row;}
 async function checkpoint(client:Transaction,claim:Claim,phase:string,progress:Progress,done=false){await client.query('UPDATE cleanup_requests SET phase=$2 WHERE job_id=$1',[claim.id,phase]);const updated=await client.query(`UPDATE jobs SET status=$4,progress=$5,lease_token=NULL,lease_until=NULL,attempt=0,error_code=NULL,available_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id`,[claim.id,claim.lease,claim.generation,done?'succeeded':'queued',progress]);if(!updated.rowCount)throw new DomainError('stale_cleanup_lease',409);}
 async function runOne(){
  const claim=await db.transaction(async client=>{const row=(await client.query<{id:string;generation:number;attempt:number}>("SELECT id,generation,attempt FROM jobs WHERE kind='cleanup' AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp())) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!row)return null;const lease=randomUUID();await client.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '120 seconds',attempt=attempt+1 WHERE id=$1",[row.id,lease]);return {...row,lease,attempt:row.attempt+1};});if(!claim)return false;
  try{
   const owner=(await db.query<{executor_id:string;executor_auth_version:number;user_id:string}>('SELECT executor_id,executor_auth_version,user_id FROM cleanup_requests WHERE job_id=$1',[claim.id])).rows[0];if(!owner)throw new DomainError('cleanup_request_missing',409);
   const mutate=<T>(work:(client:Transaction,row:Request)=>Promise<T>)=>identity.mutateJob(owner.executor_id,owner.executor_auth_version,async client=>work(client,await current(client,claim)),{checkAccess:check,lockUserIds:[owner.user_id]});
   const row=await mutate(async(_client,row)=>row);if(!options.journal)throw new DomainError('cleanup_journal_unavailable',503);const journal=options.journal;
   const record:CleanupRecord=await withProjectProof(db,journal,{version:1,dataset_id:row.dataset_id,operation_id:row.job_id,user_id:row.user_id,target_email:row.target_email,actor_id:row.creator_id,from:row.from_at.toISOString(),to:row.to_at.toISOString(),cleanup_generation:row.cleanup_generation,created_at:row.created_at.toISOString()},row.project_barriers_required);
   if(row.phase==='journal'){
    const accepted=await journal.accept(record);await mutate(async client=>{const updated=await client.query('UPDATE cleanup_requests SET acceptance_digest=$2 WHERE job_id=$1 AND (acceptance_digest IS NULL OR acceptance_digest=$2)',[claim.id,accepted]);if(!updated.rowCount)throw new DomainError('cleanup_journal_conflict',409);});
    const ids=(await db.query<{session_id:string}>('SELECT session_id FROM cleanup_sessions WHERE job_id=$1 AND ($2::uuid IS NULL OR session_id>$2) ORDER BY session_id LIMIT 500',[claim.id,row.progress.cursor??null])).rows.map(item=>item.session_id);
    if(!ids.length){await mutate((client,fresh)=>checkpoint(client,claim,'journal_verify',{...fresh.progress,verify_part:0,verify_chain:digest('')}));return true;}
    const part=row.progress.part??0;const hash=await journal.writePart(record,part,ids);await mutate(async(client,fresh)=>{await client.query('INSERT INTO cleanup_journal_parts(job_id,part,digest,session_count) VALUES($1,$2,$3,$4)',[claim.id,part,hash,ids.length]);await checkpoint(client,claim,'journal',{...fresh.progress,part:part+1,cursor:ids.at(-1)!,chain:digest(`${fresh.progress.chain??digest('')}:${part}:${hash}`),journal_sessions:(fresh.progress.journal_sessions??0)+ids.length});});return true;
   }
   if(row.phase==='journal_verify'){
    const index=row.progress.verify_part??0;if(index>=(row.progress.part??0)){await mutate(async(client,fresh)=>{const count=(await client.query<{count:number}>('SELECT count(*)::int AS count FROM cleanup_sessions WHERE job_id=$1',[claim.id])).rows[0]!.count;if(count!==(fresh.progress.journal_sessions??0)||(fresh.progress.verify_chain??digest(''))!==(fresh.progress.chain??digest('')))throw new DomainError('cleanup_journal_conflict',409);await checkpoint(client,claim,'journal_seal',fresh.progress);});return true;}
    const expected=(await db.query<{digest:string;session_count:number}>('SELECT digest,session_count FROM cleanup_journal_parts WHERE job_id=$1 AND part=$2',[claim.id,index])).rows[0];const part=await journal.readPart(row.dataset_id,claim.id,index);if(!expected||part.digest!==expected.digest||part.session_ids.length!==expected.session_count||part.session_ids[0]!<=(row.progress.verify_cursor??''))throw new DomainError('cleanup_journal_conflict',409);
    await mutate((client,fresh)=>checkpoint(client,claim,'journal_verify',{...fresh.progress,verify_part:index+1,verify_cursor:part.session_ids.at(-1)!,verify_chain:digest(`${fresh.progress.verify_chain??digest('')}:${index}:${part.digest}`)}));return true;
   }
   if(row.phase==='journal_seal'){
    const hash=await journal.seal(record,row.progress.part??0,row.progress.journal_sessions??0,row.progress.chain??digest(''));await mutate(async(client,fresh)=>{await client.query('UPDATE cleanup_requests SET journal_digest=$2 WHERE job_id=$1',[claim.id,hash]);await checkpoint(client,claim,'events',fresh.progress);});return true;
   }
   const stored=await journal.inspect(row.dataset_id,claim.id);if(!row.journal_digest||stored.digest!==row.journal_digest)throw new DomainError('cleanup_journal_conflict',409);
   await mutate((client,fresh)=>runCleanupBatch(client,fresh,claim.id,batch,'cleanup_sessions',(phase,progress,done)=>checkpoint(client,claim,phase,progress,done)));
  }catch(error){const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'cleanup_journal_failed';const safe=/^[a-z][a-z0-9_]{0,63}$|^[A-Z0-9]{5}$/.test(code)?code:'cleanup_failed';const retry=['55P03','40001','40P01','57014','database_io_timeout','database_unavailable','stale_cleanup_lease'].includes(safe)&&claim.attempt<5;await db.query("UPDATE jobs SET status=$4,error_code=$5,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '1 second' WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running'",[claim.id,claim.lease,claim.generation,retry?'queued':'failed',safe]);}
  return true;
 }
 return {runOne};
}

export type CleanupBatchRequest={user_id:string;from_at:Date;to_at:Date;cleanup_generation:number;executor_id:string|null;source_operation_id?:string;journal_digest:string|null;phase:string;progress:Progress};
export async function runCleanupBatch(client:Transaction,fresh:CleanupBatchRequest,id:string,batch:number,targetTable:'cleanup_sessions'|'recovery_cleanup_sessions',checkpoint:(phase:string,progress:Progress,done?:boolean)=>Promise<void>){
 const claim={id};
    const p={...fresh.progress};const targets=`SELECT session_id FROM ${targetTable} WHERE job_id=$1`;
    if(fresh.phase==='events'){
     const projects=await eraseProjectEvidenceBatch(client,{userId:fresh.user_id,from:fresh.from_at,to:fresh.to_at},batch);
     if(projects){p.deleted_copies=(p.deleted_copies??0)+projects;await checkpoint('events',p);return;}
     const removed=await client.query<{id:string}>(`DELETE FROM hook_events e USING(SELECT id,occurred_at FROM hook_events WHERE user_id=$1 AND occurred_at>=$2 AND occurred_at<$3 ORDER BY occurred_at,id LIMIT $4 FOR UPDATE) selected WHERE e.id=selected.id AND e.occurred_at=selected.occurred_at RETURNING e.id`,[fresh.user_id,fresh.from_at,fresh.to_at,batch]);
     if(removed.rowCount)await client.query('DELETE FROM event_keys k USING installations i WHERE k.installation_id=i.id AND i.user_id=$1 AND k.event_id=ANY($2::uuid[]) AND k.occurred_at>=$3 AND k.occurred_at<$4',[fresh.user_id,removed.rows.map(item=>item.id),fresh.from_at,fresh.to_at]);p.deleted_events=(p.deleted_events??0)+(removed.rowCount??0);await checkpoint(removed.rowCount?'events':'keys',p);return;
    }
    if(fresh.phase==='keys'){
     const removed=await client.query(`DELETE FROM event_keys k USING(SELECT k.installation_id,k.client_event_id FROM event_keys k JOIN installations i ON i.id=k.installation_id WHERE i.user_id=$1 AND k.occurred_at>=$2 AND k.occurred_at<$3 ORDER BY k.installation_id,k.client_event_id LIMIT $4 FOR UPDATE OF k) selected WHERE k.installation_id=selected.installation_id AND k.client_event_id=selected.client_event_id`,[fresh.user_id,fresh.from_at,fresh.to_at,batch]);await checkpoint(removed.rowCount?'keys':'derived',p);return;
    }
    if(fresh.phase==='derived'){
     const oldLists=await client.query(`DELETE FROM session_list_snapshots WHERE id IN(SELECT id FROM session_list_snapshots
      WHERE (safety_fence->'cleanup'->>$1)::integer<$2 ORDER BY id LIMIT $3)`,[fresh.user_id,fresh.cleanup_generation,batch]);
     if(oldLists.rowCount){p.deleted_copies=(p.deleted_copies??0)+oldLists.rowCount;await checkpoint('derived',p);return;}
     const oldEntries=await client.query(`DELETE FROM session_list_snapshot_entries WHERE id IN(SELECT id FROM session_list_snapshot_entries
      WHERE user_id=$1 AND cleanup_generation<$2 ORDER BY id LIMIT $3)`,[fresh.user_id,fresh.cleanup_generation,batch]);
     if(oldEntries.rowCount){p.deleted_copies=(p.deleted_copies??0)+oldEntries.rowCount;await checkpoint('derived',p);return;}
     const tables=['session_fragments','session_steps','session_turns','session_days'] as const;const index=p.derived_table??0;
     if(index<tables.length){const table=tables[index]!;const removed=await client.query(`DELETE FROM ${table} x USING(SELECT t.tableoid,t.ctid FROM ${table} t JOIN session_derivations r ON r.id=t.run_id WHERE r.user_id=$2 AND r.cleanup_generation<$3 AND r.session_id IN(${targets}) LIMIT $4 FOR UPDATE OF t) selected WHERE x.tableoid=selected.tableoid AND x.ctid=selected.ctid`,[claim.id,fresh.user_id,fresh.cleanup_generation,batch]);p.deleted_copies=(p.deleted_copies??0)+(removed.rowCount??0);if(!removed.rowCount)p.derived_table=index+1;await checkpoint('derived',p);return;}
     await client.query(`UPDATE sessions SET derived_run_id=NULL WHERE user_id=$2 AND derived_run_id IN(SELECT id FROM session_derivations WHERE cleanup_generation<$3 AND session_id IN(${targets}))`,[claim.id,fresh.user_id,fresh.cleanup_generation]);
     const removed=await client.query(`DELETE FROM session_derivations WHERE id IN(SELECT id FROM session_derivations WHERE user_id=$2 AND cleanup_generation<$3 AND session_id IN(${targets}) ORDER BY id LIMIT $4)`,[claim.id,fresh.user_id,fresh.cleanup_generation,batch]);await checkpoint(removed.rowCount?'derived':'models',p);return;
    }
    if(fresh.phase==='models'){
     const removed=await client.query(`DELETE FROM session_personal_models WHERE session_id IN(SELECT session_id FROM session_personal_models WHERE user_id=$2 AND cleanup_generation<$3 AND session_id IN(${targets}) LIMIT $4)`,[claim.id,fresh.user_id,fresh.cleanup_generation,batch]);await checkpoint(removed.rowCount?'models':'attribution',p);return;
    }
    if(fresh.phase==='attribution'){
     const temporary=await client.query("UPDATE jobs SET generation=generation+1,progress='{}' WHERE id IN(SELECT id FROM jobs WHERE kind='usage_attribution' AND progress->>'user_id'=$1 AND COALESCE((progress->>'cleanup_generation')::int,0)<$2 ORDER BY id LIMIT $3)",[fresh.user_id,fresh.cleanup_generation,batch]);if(temporary.rowCount){await checkpoint('attribution',p);return;}
     const queries=await client.query(`DELETE FROM session_usage_queries WHERE (provider_account,session_id) IN(SELECT provider_account,session_id FROM session_usage_queries WHERE user_id=$2 AND cleanup_generation<$3 AND session_id IN(${targets}) LIMIT $4)`,[claim.id,fresh.user_id,fresh.cleanup_generation,batch]);if(queries.rowCount){await checkpoint('attribution',p);return;}
     const removed=await client.query<{provider_account:string}>(`DELETE FROM usage_attribution_evidence e USING(SELECT ctid FROM usage_attribution_evidence WHERE user_id=$2 AND cleanup_generation<$3 AND session_id IN(${targets}) LIMIT $4) selected WHERE e.ctid=selected.ctid RETURNING e.provider_account`,[claim.id,fresh.user_id,fresh.cleanup_generation,batch]);
     for(const account of new Set(removed.rows.map(value=>value.provider_account)))await client.query('INSERT INTO usage_attribution_revisions(provider_account,user_id,revision) VALUES($1,$2,1) ON CONFLICT(provider_account,user_id) DO UPDATE SET revision=usage_attribution_revisions.revision+1',[account,fresh.user_id]);
     if(!removed.rowCount)await client.query(`UPDATE usage_attribution_subjects SET generation=generation+1,probe_state='failed',observed_at=NULL,response_hash=NULL,error_code='cleanup_applied',cleanup_generation=$3 WHERE user_id=$2 AND cleanup_generation<$3 AND session_id IN(${targets})`,[claim.id,fresh.user_id,fresh.cleanup_generation]);
     await checkpoint(removed.rowCount?'attribution':'usage',p);return;
    }
    if(fresh.phase==='usage'){
     const selected=(await client.query<{run_id:string;scope_id:string;part:number;state:string;provider_account:string;business_date:string}>(`SELECT r.id AS run_id,s.id AS scope_id,p.part,r.state,s.provider_account,s.business_date::text AS business_date FROM usage_snapshot_runs r JOIN usage_scopes s ON s.id=r.scope_id JOIN usage_snapshot_parts p ON p.run_id=r.id WHERE s.user_id=$1 AND r.cleanup_generation<$4 AND p.start_second<ceil(extract(epoch FROM $3::timestamptz)) AND p.end_second>=floor(extract(epoch FROM $2::timestamptz)) ORDER BY r.id,p.part LIMIT 1 FOR UPDATE OF r,s,p`,[fresh.user_id,fresh.from_at,fresh.to_at,fresh.cleanup_generation])).rows[0];
     if(!selected){await checkpoint('rebuild',p);return;}
     await client.query('DELETE FROM usage_model_checks WHERE scope_id=$1 AND cleanup_generation<$2',[selected.scope_id,fresh.cleanup_generation]);
     await client.query("UPDATE jobs SET generation=generation+1,status='queued',progress='{}',lease_token=NULL,lease_until=NULL,attempt=0,error_code=NULL,available_at=clock_timestamp()+interval '1 hour' WHERE kind='usage_model_check' AND payload->>'user_id'=$1 AND progress ? 'models' AND COALESCE((progress->>'cleanup_generation')::int,0)<$2",[fresh.user_id,fresh.cleanup_generation]);

     if(selected.state!=='redacted'){
      const invalidated=(await client.query<{id:string}>("UPDATE usage_snapshot_runs SET state='redacted',lease_token=NULL,lease_until=NULL,content_hash='redacted:'||COALESCE(content_hash,'') WHERE scope_id=$1 AND (id=$2 OR data_run_id=$2) RETURNING id",[selected.scope_id,selected.run_id])).rows.map(value=>value.id);
      const changed=await client.query(`UPDATE usage_scopes SET active_run_id=CASE WHEN active_run_id=ANY($2::uuid[]) THEN NULL ELSE active_run_id END,published_run_id=CASE WHEN published_run_id=ANY($2::uuid[]) THEN NULL ELSE published_run_id END,verified_run_id=CASE WHEN verified_run_id=ANY($2::uuid[]) THEN NULL ELSE verified_run_id END,revision=revision+1,last_verified_at=NULL WHERE id=$1 AND (active_run_id=ANY($2::uuid[]) OR published_run_id=ANY($2::uuid[]) OR verified_run_id=ANY($2::uuid[]))`,[selected.scope_id,invalidated]);
      if(changed.rowCount&&(await client.query("SELECT 1 FROM users WHERE id=$1 AND status='active'",[fresh.user_id])).rowCount)await client.query(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'usage_sync',$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,progress='{}',attempt=0,error_code=NULL,available_at=clock_timestamp()`,[randomUUID(),`usage:${selected.provider_account}:${fresh.user_id}:${selected.business_date}`,{provider_account:selected.provider_account,user_id:fresh.user_id,business_date:selected.business_date,recurring:false}]);
     }
     const observations=await client.query('DELETE FROM usage_observations WHERE ctid IN(SELECT ctid FROM usage_observations WHERE run_id=$1 AND part=$2 ORDER BY page,item_index LIMIT $3)',[selected.run_id,selected.part,batch]);
     if(!observations.rowCount){const pages=await client.query('DELETE FROM usage_snapshot_pages WHERE ctid IN(SELECT ctid FROM usage_snapshot_pages WHERE run_id=$1 AND part=$2 ORDER BY page LIMIT $3)',[selected.run_id,selected.part,batch]);if(!pages.rowCount)await client.query('DELETE FROM usage_snapshot_parts WHERE run_id=$1 AND part=$2',[selected.run_id,selected.part]);}
     p.deleted_copies=(p.deleted_copies??0)+(observations.rowCount??0);await checkpoint('usage',p);return;
    }
    if(fresh.phase==='rebuild'){
     const targetsPage=(await client.query<{session_id:string}>(`SELECT c.session_id FROM ${targetTable} c JOIN sessions s ON s.id=c.session_id WHERE c.job_id=$1 AND ($2::uuid IS NULL OR c.session_id>$2) ORDER BY c.session_id LIMIT $3`,[claim.id,p.rebuild_cursor??null,batch])).rows;
     for(const target of targetsPage){
      const bounds=(await client.query<{first:string|null;last:string|null}>('SELECT min(occurred_at)::text AS first,max(occurred_at)::text AS last FROM hook_events WHERE user_id=$1 AND session_id=$2',[fresh.user_id,target.session_id])).rows[0]!;
      if(!bounds.first){
       await client.query('UPDATE sessions SET derived_run_id=NULL WHERE id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);await client.query('DELETE FROM session_derivations WHERE session_id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);await client.query('DELETE FROM usage_attribution_evidence WHERE session_id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);await client.query('DELETE FROM usage_attribution_subjects WHERE session_id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);await client.query('DELETE FROM session_personal_models WHERE session_id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);await client.query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_token=NULL,lease_until=NULL,progress='{}',error_code='session_cleared' WHERE kind IN('derive_session','usage_attribution','session_token_check') AND payload->>'session_id'=$1",[target.session_id]);await client.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2',[target.session_id,fresh.user_id]);
      }else{
       await client.query('UPDATE sessions SET first_at=$2,last_at=$3 WHERE id=$1',[target.session_id,bounds.first,bounds.last]);
       await client.query(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'derive_session',$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=clock_timestamp()`,[randomUUID(),`derive:${target.session_id}`,{session_id:target.session_id}]);
       await client.query(`INSERT INTO jobs(id,kind,dedupe_key,payload) SELECT gen_random_uuid(),'usage_attribution','usage-link:'||i.provider_account||':'||$2::text,jsonb_build_object('provider_account',i.provider_account,'session_id',$2::text,'recurring',false) FROM usage_provider_identities i JOIN users u ON u.id=i.user_id WHERE i.user_id=$1 AND u.status='active' ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=clock_timestamp()`,[fresh.user_id,target.session_id]);
      }
     }
     if(targetsPage.length)p.rebuild_cursor=targetsPage.at(-1)!.session_id;await checkpoint(targetsPage.length?'rebuild':'verify',p);return;
    }
    if(fresh.phase==='verify'){
     if(await hasProjectEvidenceInRange(client,{userId:fresh.user_id,from:fresh.from_at,to:fresh.to_at})){await checkpoint('events',p);return;}
     const residual=(await client.query<{remaining:boolean}>(`SELECT
       EXISTS(SELECT 1 FROM hook_events WHERE user_id=$2 AND occurred_at>=$3 AND occurred_at<$4)
       OR EXISTS(SELECT 1 FROM event_keys k JOIN installations i ON i.id=k.installation_id WHERE i.user_id=$2 AND k.occurred_at>=$3 AND k.occurred_at<$4)
       OR EXISTS(SELECT 1 FROM session_derivations WHERE user_id=$2 AND cleanup_generation<$5 AND session_id IN(${targets}))
       OR EXISTS(SELECT 1 FROM session_list_snapshot_entries WHERE user_id=$2 AND cleanup_generation<$5)
       OR EXISTS(SELECT 1 FROM session_personal_models WHERE user_id=$2 AND cleanup_generation<$5 AND session_id IN(${targets}))
       OR EXISTS(SELECT 1 FROM session_usage_queries WHERE user_id=$2 AND cleanup_generation<$5 AND session_id IN(${targets}))
       OR EXISTS(SELECT 1 FROM jobs WHERE kind='usage_attribution' AND progress->>'user_id'=$2::text AND COALESCE((progress->>'cleanup_generation')::int,0)<$5)
       OR EXISTS(SELECT 1 FROM usage_attribution_evidence WHERE user_id=$2 AND cleanup_generation<$5 AND session_id IN(${targets}))
       OR EXISTS(SELECT 1 FROM usage_snapshot_parts p JOIN usage_snapshot_runs r ON r.id=p.run_id JOIN usage_scopes s ON s.id=r.scope_id WHERE s.user_id=$2 AND r.cleanup_generation<$5 AND p.start_second<ceil(extract(epoch FROM $4::timestamptz)) AND p.end_second>=floor(extract(epoch FROM $3::timestamptz))) AS remaining`,[claim.id,fresh.user_id,fresh.from_at,fresh.to_at,fresh.cleanup_generation])).rows[0]!.remaining;
     if(residual)throw new DomainError('cleanup_verification_failed',409);
     if(targetTable==='recovery_cleanup_sessions')await client.query("INSERT INTO recovery_events(run_id,action,metadata) SELECT run_id,'cleanup_replayed',$2 FROM recovery_cleanup_operations WHERE job_id=$1",[id,{operation_id:fresh.source_operation_id??id,replay_id:id,journal_digest:fresh.journal_digest,deleted_events:p.deleted_events??0}]);
     else await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'cleanup_completed',$2,$3)",[fresh.executor_id,fresh.user_id,{job_id:claim.id,journal_digest:fresh.journal_digest,deleted_events:p.deleted_events??0}]);await checkpoint('complete',p,true);return;
    }
    throw new DomainError('invalid_cleanup_phase',409);

}
