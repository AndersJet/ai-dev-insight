import {retireAuxiliaryBatch,type AuxiliaryProgress} from './auxiliary-retention.js';
import {eraseProjectEvidenceBatch,hasProjectEvidenceInRange} from './project-evidence-cleanup.js';
import {retireUsageBatch,type UsageRetentionProgress} from './usage-retention.js';
import {randomUUID} from 'node:crypto';import type {Database,Transaction} from '@adi/storage';import {DomainError} from './errors.js';
type Counters=UsageRetentionProgress & AuxiliaryProgress & {usage_done?:boolean;aux_done?:boolean;discovered?:number;deleted_copies?:number;deleted_keys?:number;deleted_boundary_events?:number;dropped_partitions?:number;expired_sessions?:number;retained_sessions?:number;cursor?:string};
type State={run_id:string|null;cutoff:Date|null;phase:string;progress:Counters;started_at:Date|null;last_success_at:Date|null;next_run_at:Date|null;retry_at:Date|null;last_error:string|null;revision:string};
const tables=['session_fragments','session_steps','session_turns','session_days'] as const;
/** Autonomous Hook-detail retention; never invoked from an IDE request. */
export function createRetentionService(db:Database,options:{clock?:()=>Date;batchSize?:number}={}){
 const now=options.clock??(()=>new Date()),batch=options.batchSize??100;if(!Number.isInteger(batch)||batch<1||batch>200)throw new Error('Retention batch must be 1..200');
 async function state(sql:Transaction){return (await sql.query<State>('SELECT *,updated_at::text AS revision FROM retention_state')).rows[0]!;}
 async function save(sql:Transaction,phase:string,progress:Counters){await sql.query('UPDATE retention_state SET phase=$1,progress=$2,last_error=NULL,retry_at=NULL,updated_at=clock_timestamp()',[phase,progress]);}
 async function runOne():Promise<boolean>{
  await db.assertNotRecovering();const initial=await state(db),at=now();if(!Number.isFinite(at.getTime()))throw new Error('Valid retention clock required');if(initial.retry_at&&initial.retry_at>at)return false;
  try{
   if(initial.phase==='partitions'){
    await db.ensurePartitions(initial.cutoff!,new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth()+3,1)));
    await db.query("UPDATE retention_state SET phase='discover',last_error=NULL,retry_at=NULL,updated_at=clock_timestamp() WHERE run_id=$1 AND phase='partitions'",[initial.run_id]);return true;
   }
   return await db.transaction(async sql=>{
    if(!(await sql.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`adi:retention:${db.schema}`])).rows[0]!.locked)return false;
    await sql.query("SET LOCAL lock_timeout='100ms'");await sql.query("SET LOCAL statement_timeout='1500ms'");
    const identity=(await sql.query<{recovery_id:string|null;retention_cutoff:Date|null}>('SELECT recovery_id,retention_cutoff FROM data_identity FOR SHARE')).rows[0];if(!identity||identity.recovery_id)throw new DomainError('recovery_quarantined',503);
    const current=await state(sql),p={...current.progress};if(current.retry_at&&current.retry_at>at)return false;
    if(current.phase==='idle'){
     if(current.next_run_at&&current.next_run_at>at)return false;
     const cutoff=new Date(Math.max(at.getTime()-365*86400000,identity.retention_cutoff?.getTime()??0));
     await sql.query('UPDATE data_identity SET retention_cutoff=$1',[cutoff]);await sql.query("UPDATE retention_state SET run_id=$1,cutoff=$2,phase='partitions',progress='{}',started_at=$3,last_error=NULL,retry_at=NULL,updated_at=clock_timestamp()",[randomUUID(),cutoff,at]);return true;
    }
    const cutoff=current.cutoff!;
    if(current.phase==='discover'){
     const candidates=(await sql.query<{session_id:string;user_id:string}>(`WITH candidates AS (SELECT id AS session_id,user_id FROM sessions WHERE first_at<$1 UNION SELECT session_id,user_id FROM session_derivations WHERE from_at<$1)
      SELECT * FROM candidates WHERE ($2::uuid IS NULL OR session_id>$2) ORDER BY session_id LIMIT $3`,[cutoff,p.cursor??null,batch])).rows;
     for(const row of candidates)await sql.query('INSERT INTO retention_targets(session_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.session_id,row.user_id]);
     if(candidates.length)p.cursor=candidates.at(-1)!.session_id;p.discovered=(p.discovered??0)+candidates.length;await save(sql,candidates.length?'discover':'derived',p);return true;
    }
    if(current.phase==='derived'){
     const target=(await sql.query<{session_id:string;user_id:string}>('SELECT * FROM retention_targets WHERE NOT initialized ORDER BY session_id LIMIT 1')).rows[0];
     if(target){await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[target.user_id]);await sql.query('INSERT INTO retention_derivations(run_id,session_id,user_id) SELECT id,session_id,user_id FROM session_derivations WHERE session_id=$1 AND (from_at<$2 OR NOT EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id=$1 AND e.occurred_at>=$2)) ON CONFLICT DO NOTHING',[target.session_id,cutoff]);await sql.query('UPDATE sessions SET derived_run_id=CASE WHEN derived_run_id IN(SELECT run_id FROM retention_derivations WHERE session_id=$1) THEN NULL ELSE derived_run_id END,history_expired=true WHERE id=$1',[target.session_id]);await sql.query("UPDATE session_derivations SET state='abandoned',checkpoint='{}',summary='{}',retire_after=NULL WHERE id IN(SELECT run_id FROM retention_derivations WHERE session_id=$1)",[target.session_id]);await sql.query("UPDATE jobs SET status='queued',generation=generation+1,progress='{}',lease_token=NULL,lease_until=NULL,error_code=NULL,attempt=0,available_at=clock_timestamp() WHERE (kind='derive_session' OR (kind='usage_attribution' AND (progress<>'{}'::jsonb OR status='running'))) AND payload->>'session_id'=$1",[target.session_id]);await sql.query('UPDATE retention_targets SET initialized=true WHERE session_id=$1',[target.session_id]);await save(sql,'derived',p);return true;}
     const run=(await sql.query<{run_id:string;session_id:string;user_id:string;table_index:number}>('SELECT * FROM retention_derivations ORDER BY run_id LIMIT 1')).rows[0];
     if(run){await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[run.user_id]);if(run.table_index<tables.length){const table=tables[run.table_index]!;const removed=await sql.query(`DELETE FROM ${table} x USING(SELECT tableoid,ctid FROM ${table} WHERE run_id=$1 LIMIT $2 FOR UPDATE) selected WHERE x.tableoid=selected.tableoid AND x.ctid=selected.ctid`,[run.run_id,batch]);p.deleted_copies=(p.deleted_copies??0)+(removed.rowCount??0);if(!removed.rowCount)await sql.query('UPDATE retention_derivations SET table_index=table_index+1 WHERE run_id=$1',[run.run_id]);}else{await sql.query('DELETE FROM session_derivations WHERE id=$1',[run.run_id]);await sql.query('DELETE FROM retention_derivations WHERE run_id=$1',[run.run_id]);}await save(sql,'derived',p);return true;}
     await save(sql,'references',p);return true;
    }
    if(current.phase==='references'){
     const target=(await sql.query<{session_id:string;user_id:string}>('SELECT * FROM retention_targets WHERE NOT references_done ORDER BY session_id LIMIT 1')).rows[0];if(!target){await save(sql,'keys',p);return true;}
     await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[target.user_id]);const retained=await sql.query('SELECT 1 FROM hook_events WHERE session_id=$1 AND occurred_at>=$2 LIMIT 1',[target.session_id,cutoff]);
     if(!retained.rowCount){
      const removed=await sql.query<{provider_account:string}>('DELETE FROM usage_attribution_evidence WHERE ctid IN(SELECT ctid FROM usage_attribution_evidence WHERE session_id=$1 LIMIT $2) RETURNING provider_account',[target.session_id,batch]);
      for(const account of new Set(removed.rows.map(row=>row.provider_account)))await sql.query('INSERT INTO usage_attribution_revisions(provider_account,user_id,revision) VALUES($1,$2,1) ON CONFLICT(provider_account,user_id) DO UPDATE SET revision=usage_attribution_revisions.revision+1',[account,target.user_id]);if(removed.rowCount){await save(sql,'references',p);return true;}
      const subjects=await sql.query('DELETE FROM usage_attribution_subjects WHERE ctid IN(SELECT ctid FROM usage_attribution_subjects WHERE session_id=$1 LIMIT $2)',[target.session_id,batch]);if(subjects.rowCount){await save(sql,'references',p);return true;}
      if((await sql.query('DELETE FROM session_personal_models WHERE session_id=$1',[target.session_id])).rowCount)await sql.query('INSERT INTO personal_model_revisions(user_id,revision) VALUES($1,1) ON CONFLICT(user_id) DO UPDATE SET revision=personal_model_revisions.revision+1',[target.user_id]);
     }
     await sql.query('UPDATE retention_targets SET references_done=true WHERE session_id=$1',[target.session_id]);await save(sql,'references',p);return true;
    }
    if(current.phase==='keys'){
     const removed=await sql.query('DELETE FROM event_keys WHERE (installation_id,client_event_id) IN(SELECT installation_id,client_event_id FROM event_keys WHERE occurred_at<$1 ORDER BY occurred_at LIMIT $2 FOR UPDATE)',[cutoff,batch]);p.deleted_keys=(p.deleted_keys??0)+(removed.rowCount??0);await save(sql,removed.rowCount?'keys':'boundary',p);return true;
    }
    if(current.phase==='boundary'){
     const from=new Date(Date.UTC(cutoff.getUTCFullYear(),cutoff.getUTCMonth(),1));const removed=await sql.query('DELETE FROM hook_events e USING(SELECT occurred_at,id FROM hook_events WHERE occurred_at>=$1 AND occurred_at<$2 ORDER BY occurred_at,id LIMIT $3 FOR UPDATE) selected WHERE e.occurred_at=selected.occurred_at AND e.id=selected.id',[from,cutoff,batch]);p.deleted_boundary_events=(p.deleted_boundary_events??0)+(removed.rowCount??0);await save(sql,removed.rowCount?'boundary':'drop_partitions',p);return true;
    }
    if(current.phase==='drop_partitions'){
     const partitions=(await sql.query<{name:string;parent:string;bounds:string}>(`SELECT c.relname AS name,p.relname AS parent,pg_get_expr(c.relpartbound,c.oid) AS bounds FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND p.relnamespace=c.relnamespace AND p.relname IN('hook_events','session_fragments') ORDER BY c.relname`)).rows;
     let selected:typeof partitions[number]|undefined;
     for(const part of partitions){const match=/FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(part.bounds);if(!match)throw new DomainError('unexpected_partition_bounds',409);const from=new Date(match[1]!.replace(' ','T').replace(/\+00$/,'Z')),to=new Date(match[2]!.replace(' ','T').replace(/\+00$/,'Z'));if(!Number.isFinite(from.getTime())||from.getTime()!==Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),1)||to.getTime()!==Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,1)||part.name!==`${part.parent}_${from.toISOString().slice(0,7).replace('-','')}`)throw new DomainError('unexpected_partition_bounds',409);if(to<=cutoff){selected=part;break;}}
     if(selected){await sql.query("SET LOCAL statement_timeout='500ms'");await sql.query(`LOCK TABLE ONLY "${db.schema}"."${selected.name}" IN ACCESS EXCLUSIVE MODE NOWAIT`);await sql.query(`LOCK TABLE ONLY "${db.schema}"."${selected.parent}" IN ACCESS EXCLUSIVE MODE NOWAIT`);const same=await sql.query("SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1 AND p.relname=$2 AND p.relnamespace=c.relnamespace AND pg_get_expr(c.relpartbound,c.oid)=$3",[selected.name,selected.parent,selected.bounds]);if(!same.rowCount)throw new DomainError('partition_changed',409);await sql.query(`DROP TABLE "${db.schema}"."${selected.name}" RESTRICT`);p.dropped_partitions=(p.dropped_partitions??0)+1;await save(sql,'drop_partitions',p);}else await save(sql,'finalize',p);return true;
    }
    if(current.phase==='finalize'){
     const target=(await sql.query<{session_id:string;user_id:string}>('SELECT * FROM retention_targets ORDER BY session_id LIMIT 1')).rows[0];if(!target){await save(sql,'usage',p);return true;}
     await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[target.user_id]);const bounds=(await sql.query<{first:string|null;last:string|null}>('SELECT min(occurred_at)::text AS first,max(occurred_at)::text AS last FROM hook_events WHERE session_id=$1',[target.session_id])).rows[0]!;
     if(bounds.first){await sql.query('UPDATE sessions SET first_at=$2,last_at=$3,history_expired=true WHERE id=$1',[target.session_id,bounds.first,bounds.last]);p.retained_sessions=(p.retained_sessions??0)+1;}
     else{await sql.query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_token=NULL,lease_until=NULL,progress='{}',error_code='retention_expired' WHERE kind IN('derive_session','usage_attribution') AND payload->>'session_id'=$1",[target.session_id]);await sql.query('DELETE FROM sessions WHERE id=$1',[target.session_id]);p.expired_sessions=(p.expired_sessions??0)+1;}
     await sql.query('DELETE FROM retention_targets WHERE session_id=$1',[target.session_id]);await save(sql,'finalize',p);return true;
    }
    if(current.phase==='usage'){if(await retireUsageBatch(sql,cutoff,batch,p)){await save(sql,'usage',p);return true;}p.usage_done=true;await save(sql,'auxiliary',p);return true;}
    if(current.phase==='auxiliary'){
     const projects=await eraseProjectEvidenceBatch(sql,{userId:null,from:'-infinity',to:cutoff,sourceKind:'hook'},batch);
     if(projects){p.deleted_copies=(p.deleted_copies??0)+projects;await save(sql,'auxiliary',p);return true;}
     if(await retireAuxiliaryBatch(sql,at,batch,p)){await save(sql,'auxiliary',p);return true;}p.aux_done=true;await save(sql,'verify',p);return true;
    }
    if(current.phase==='verify'){
     if(await hasProjectEvidenceInRange(sql,{userId:null,from:'-infinity',to:cutoff,sourceKind:'hook'})){p.aux_done=false;await save(sql,'auxiliary',p);return true;}
     if(!p.usage_done){await save(sql,'usage',p);return true;}if(!p.aux_done){await save(sql,'auxiliary',p);return true;}
     if((await sql.query('SELECT 1 FROM hook_events WHERE occurred_at<$1 LIMIT 1',[cutoff])).rowCount||(await sql.query('SELECT 1 FROM session_fragments WHERE occurred_at<$1 LIMIT 1',[cutoff])).rowCount||(await sql.query('SELECT 1 FROM event_keys WHERE occurred_at<$1 LIMIT 1',[cutoff])).rowCount)throw new DomainError('retention_verification_failed',409);
     await sql.query("UPDATE retention_state SET phase='idle',completed_scope='hook_and_usage',last_success_at=$1,next_run_at=$2,last_error=NULL,retry_at=NULL,updated_at=clock_timestamp()",[at,new Date(at.getTime()+86400000)]);return true;
    }
    throw new DomainError('retention_phase_invalid',409);
   });
  }catch(error){const raw=error&&typeof error==='object'&&'code'in error?String(error.code):'retention_failed',code=/^[a-z][a-z0-9_]{0,63}$|^[A-Z0-9]{5}$/.test(raw)?raw:'retention_failed';await db.query('UPDATE retention_state SET last_error=$1,retry_at=$2,updated_at=clock_timestamp() WHERE updated_at=$3::timestamptz',[code,new Date(now().getTime()+30000),initial.revision]).catch(()=>{});throw error;}
 }
 async function status(){const row=await state(db);return {...row,scope:'hook_and_usage' as const};}
 return {runOne,status};
}
