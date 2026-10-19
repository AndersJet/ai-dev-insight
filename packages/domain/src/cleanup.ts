import {freezeProjectBarriers,withProjectProof,projectCleanupSnapshot} from './project-cleanup-proof.js';
import {createPageCursor,cursorScope} from './page-cursor.js';
import type {CleanupJournal,CleanupRecord} from '@adi/storage';
import {createCleanupWorker} from './cleanup-worker.js';
import {createHash,randomUUID} from 'node:crypto';import type {Database,Queryable} from '@adi/storage';import type {CurrentUser} from '@adi/contracts';import type {IdentityService} from './identity.js';import {DomainError} from './errors.js';
export interface CleanupRange {user_id:string;from:string;to:string}
const hasUsageFacts=(counts:Record<string,number>)=>Object.values(counts).some(value=>value>0);
function publicProgress(value:Record<string,unknown>){const out:Record<string,number>={};for(const key of ['part','verify_part','journal_sessions','deleted_events','deleted_copies']){const n=value[key];if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)out[key]=n;}return out;}
function superAdmin(actor:CurrentUser){if(!actor.roles.includes('super'))throw new DomainError('forbidden',403);}
function timestamp(value:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);if(!match)throw new DomainError('invalid_cleanup_range',422);
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];const parsed=Date.parse(value);
 if(year<1||month<1||month>12||day<1||day>days[month-1]!||Number(match[4])>23||Number(match[5])>59||Number(match[6])>59||!Number.isFinite(parsed))throw new DomainError('invalid_cleanup_range',422);return parsed;
}
async function snapshot(sql:Queryable,input:CleanupRange){
 const user=(await sql.query<{id:string;email_key:string;display_name:string;version:number;cleanup_generation:number}>('SELECT id,email_key,display_name,version,cleanup_generation FROM users WHERE id=$1',[input.user_id])).rows[0];if(!user)throw new DomainError('not_found',404);
 const row=(await sql.query<{hook_events:number;sessions:number;declared_sessions:number;official_days:number;watermark:string|null;official_revision:string;declaration_revision:string}>(`WITH target AS MATERIALIZED (SELECT e.id,e.session_id,e.received_at FROM hook_events e WHERE e.user_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)), scopes AS MATERIALIZED (
 SELECT s.id,s.revision,s.published_run_id,s.verified_run_id,s.active_run_id FROM usage_scopes s JOIN usage_snapshot_runs r ON r.id=s.published_run_id AND r.state='published'
 WHERE s.user_id=$1 AND s.business_date>=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND s.business_date<=(($3::timestamptz-interval '1 microsecond') AT TIME ZONE 'Asia/Shanghai')::date
 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.generation>r.cleanup_generation AND t.from_at<to_timestamp(r.to_second+1) AND t.to_at>to_timestamp(r.from_second)))
 SELECT count(*)::int AS hook_events,count(DISTINCT session_id)::int AS sessions,max(received_at)::text AS watermark,
 (SELECT count(*)::int FROM session_personal_models p WHERE p.session_id IN(SELECT session_id FROM target) AND jsonb_array_length(p.models)>0) AS declared_sessions,
 (SELECT count(*)::int FROM scopes) AS official_days,
 (SELECT COALESCE(sum(p.version),0)::text FROM session_personal_models p WHERE p.session_id IN(SELECT session_id FROM target)) AS declaration_revision,
 (SELECT md5(COALESCE(string_agg(concat(id,':',revision,':',published_run_id,':',verified_run_id,':',active_run_id),',' ORDER BY id),'')) FROM scopes) AS official_revision FROM target`,[user.id,input.from,input.to])).rows[0]!;
 const projects=await projectCleanupSnapshot(sql,user.id,input.from,input.to);
 const counts={project_observations:projects.project_observations,hook_project_observations:projects.hook_project_observations,plugin_project_observations:projects.plugin_project_observations,project_links:projects.project_links,hook_events:row.hook_events,sessions:row.sessions,declared_sessions:row.declared_sessions,official_days:row.official_days};const fingerprint=createHash('sha256').update(JSON.stringify({user,input,counts,watermark:row.watermark,official:row.official_revision,declarations:row.declaration_revision,projects:projects.revision})).digest('hex');return {user,counts,fingerprint};
}
export function createCleanupService(db:Database,identity:IdentityService,options:{clock?:()=>Date;acceptanceDeadlineMs?:number;journal?:CleanupJournal;batchSize?:number}={}){
 const now=options.clock??(()=>new Date());const cursors=createPageCursor(now);
 const pendingAcceptances=new Map<string,Promise<void>>(),deadline=options.acceptanceDeadlineMs??2000;
 if(!Number.isInteger(deadline)||deadline<10||deadline>5000)throw new Error('Acceptance deadline must be 10..5000ms');
 async function confirmAcceptance(id:string){
  if(!options.journal)throw new DomainError('cleanup_unavailable',503);
  let work=pendingAcceptances.get(id);
  if(!work){
   if(pendingAcceptances.size>=16)throw new DomainError('cleanup_acceptance_unconfirmed',503);
   const journal=options.journal;
   work=(async()=>{
    const row=(await db.query<{dataset_id:string;job_id:string;user_id:string;target_email:string;creator_id:string;from_at:Date;to_at:Date;cleanup_generation:number;created_at:Date;current_dataset:string;project_barriers_required:boolean}>('SELECT r.*,(SELECT dataset_id FROM data_identity) AS current_dataset FROM cleanup_requests r WHERE job_id=$1',[id])).rows[0];if(!row)throw new DomainError('not_found',404);if(row.dataset_id!==row.current_dataset)throw new DomainError('dataset_identity_changed',409);
    const record:CleanupRecord={version:1,dataset_id:row.dataset_id,operation_id:row.job_id,user_id:row.user_id,target_email:row.target_email,actor_id:row.creator_id,from:row.from_at.toISOString(),to:row.to_at.toISOString(),cleanup_generation:row.cleanup_generation,created_at:row.created_at.toISOString()};
    const hash=await journal.accept(await withProjectProof(db,journal,record,row.project_barriers_required));
    const changed=await db.query('UPDATE cleanup_requests SET acceptance_digest=$2 WHERE job_id=$1 AND (acceptance_digest IS NULL OR acceptance_digest=$2)',[id,hash]);if(!changed.rowCount)throw new Error('Conflicting acceptance receipt');
   })();
   pendingAcceptances.set(id,work);void work.then(()=>pendingAcceptances.delete(id),()=>pendingAcceptances.delete(id));
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Acceptance I/O deadline')),deadline);})]);}
  catch{throw new DomainError('cleanup_acceptance_unconfirmed',503);}finally{if(timer)clearTimeout(timer);}
 }

 async function preview(token:string,input:CleanupRange){
  const actor=await identity.requireUser(token);superAdmin(actor);if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.user_id))throw new DomainError('invalid_request',400);
  const at=now(),from=timestamp(input.from),to=timestamp(input.to);if(from>=to||to>at.getTime())throw new DomainError('invalid_cleanup_range',422);
  const range={user_id:input.user_id.toLowerCase(),from:new Date(from).toISOString(),to:new Date(to).toISOString()};const current=await snapshot(db,range);const id=randomUUID(),expires=new Date(at.getTime()+600000);
  await identity.mutate(token,async(client,verified)=>{if(verified.user_id!==actor.user_id)throw new DomainError('forbidden',403);await client.query('INSERT INTO cleanup_previews(id,creator_id,user_id,from_at,to_at,fingerprint,counts,target_email,target_name,target_version,cleanup_generation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,actor.user_id,current.user.id,range.from,range.to,current.fingerprint,current.counts,current.user.email_key,current.user.display_name,current.user.version,current.user.cleanup_generation,expires]);},{checkAccess:superAdmin});
  return {can_submit:!!options.journal&&hasUsageFacts(current.counts),preview_id:id,target:{id:current.user.id,email:current.user.email_key,name:current.user.display_name},range:{from:range.from,to:range.to},counts:current.counts,expires_at:expires.toISOString()};
 }
 async function status(token:string,id:string){
  superAdmin(await identity.requireUser(token));if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new DomainError('not_found',404);
  const row=(await db.query<{job_id:string;status:string;phase:string;error_code:string|null;user_id:string;target_email:string;current_email:string;current_name:string;from_at:Date;to_at:Date;progress:Record<string,unknown>}>(`SELECT r.job_id,r.phase,r.user_id,r.target_email,u.email_key AS current_email,u.display_name AS current_name,r.from_at,r.to_at,j.status,j.error_code,j.progress FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id JOIN users u ON u.id=r.user_id WHERE r.job_id=$1`,[id])).rows[0];if(!row)throw new DomainError('not_found',404);superAdmin(await identity.requireUser(token));return {...row,progress:publicProgress(row.progress),from_at:row.from_at.toISOString(),to_at:row.to_at.toISOString()};
 }
 async function submit(token:string,input:CleanupRange&{preview_id:string;confirmation_email:string},key:string){
  superAdmin(await identity.requireUser(token));const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  if(!uuid(input.user_id)||!uuid(input.preview_id)||!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new DomainError('invalid_request',400);
  const normalized={preview_id:input.preview_id.toLowerCase(),user_id:input.user_id.toLowerCase(),from:new Date(timestamp(input.from)).toISOString(),to:new Date(timestamp(input.to)).toISOString(),confirmation_email:input.confirmation_email.trim().toLowerCase()};const digest=(value:string)=>createHash('sha256').update(value).digest('hex');const requestHash=digest(JSON.stringify(normalized)),keyHash=digest(key);
  const submitted=await identity.mutate(token,async(client,actor)=>{
   const existing=(await client.query<{job_id:string;request_hash:string;status:string}>('SELECT r.job_id,r.request_hash,j.status FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id WHERE r.creator_id=$1 AND r.idempotency_hash=$2',[actor.user_id,keyHash])).rows[0];if(existing){if(existing.request_hash!==requestHash)throw new DomainError('idempotency_conflict',409);return {job_id:existing.job_id,status:existing.status};}
   if(!options.journal)throw new DomainError('cleanup_unavailable',503);
   const saved=(await client.query<{id:string;user_id:string;from_at:Date;to_at:Date;fingerprint:string;target_email:string;expires_at:Date}>('SELECT id,user_id,from_at,to_at,fingerprint,target_email,expires_at FROM cleanup_previews WHERE id=$1 AND creator_id=$2 FOR UPDATE',[normalized.preview_id,actor.user_id])).rows[0];
   if(!saved)throw new DomainError('not_found',404);if(saved.expires_at<=now())throw new DomainError('cleanup_preview_expired',409);
   if(saved.user_id!==normalized.user_id||saved.from_at.toISOString()!==normalized.from||saved.to_at.toISOString()!==normalized.to||saved.target_email!==normalized.confirmation_email)throw new DomainError('cleanup_confirmation_mismatch',409);
   if((await client.query('SELECT 1 FROM cleanup_requests WHERE preview_id=$1',[saved.id])).rowCount)throw new DomainError('cleanup_preview_used',409);
   if((await client.query("SELECT 1 FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id WHERE r.user_id=$1 AND j.status IN('queued','running')",[saved.user_id])).rowCount)throw new DomainError('cleanup_in_progress',409);
   const current=await snapshot(client,{user_id:normalized.user_id,from:normalized.from,to:normalized.to});if(current.fingerprint!==saved.fingerprint)throw new DomainError('cleanup_preview_stale',409);
   if(!hasUsageFacts(current.counts))throw new DomainError('cleanup_empty_scope',422);
   const id=randomUUID(),generation=current.user.cleanup_generation+1;const auth=(await client.query<{auth_version:number}>('SELECT auth_version FROM users WHERE id=$1',[actor.user_id])).rows[0]!.auth_version;
   await client.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'cleanup',$2,$3)",[id,`cleanup:${id}`,{cleanup_id:id}]);
   await client.query('INSERT INTO cleanup_requests(job_id,dataset_id,preview_id,creator_id,executor_id,executor_auth_version,user_id,target_email,from_at,to_at,cleanup_generation,request_hash,idempotency_hash) VALUES($1,(SELECT dataset_id FROM data_identity),$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,saved.id,actor.user_id,auth,saved.user_id,saved.target_email,normalized.from,normalized.to,generation,requestHash,keyHash]);
   await freezeProjectBarriers(client,id,saved.user_id,normalized.from,normalized.to);
   await client.query('INSERT INTO cleanup_sessions(job_id,session_id) SELECT $1,session_id FROM hook_events WHERE user_id=$2 AND occurred_at>=$3 AND occurred_at<$4 GROUP BY session_id',[id,saved.user_id,normalized.from,normalized.to]);
   await client.query('UPDATE sessions SET history_redacted=true WHERE user_id=$2 AND id IN(SELECT session_id FROM cleanup_sessions WHERE job_id=$1)',[id,saved.user_id]);
   await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,$4)',[saved.user_id,normalized.from,normalized.to,generation]);await client.query('UPDATE users SET cleanup_generation=$2,version=version+1 WHERE id=$1',[saved.user_id,generation]);
   // Unfinished session queries contain temporary official response copies. They
   // belong to the old cleanup generation even when this range misses a session.
   await client.query(`UPDATE jobs j SET generation=j.generation+1,progress='{}' FROM sessions s WHERE j.kind='usage_attribution' AND j.payload->>'session_id'=s.id::text AND s.user_id=$1 AND j.progress<>'{}'::jsonb`,[saved.user_id]);
   // Carry forward only already-valid, unaffected projections. A user's older
   // invalidated work must never become readable merely because a new cleanup runs.
   await client.query(`UPDATE session_derivations r SET cleanup_generation=$3 WHERE r.user_id=$1 AND r.cleanup_generation=$2 AND r.state='published' AND NOT EXISTS(SELECT 1 FROM cleanup_sessions s WHERE s.job_id=$4 AND s.session_id=r.session_id)`,[saved.user_id,current.user.cleanup_generation,generation,id]);
   await client.query(`UPDATE session_personal_models p SET cleanup_generation=$3 WHERE p.user_id=$1 AND p.cleanup_generation=$2 AND NOT EXISTS(SELECT 1 FROM cleanup_sessions s WHERE s.job_id=$4 AND s.session_id=p.session_id)`,[saved.user_id,current.user.cleanup_generation,generation,id]);
   await client.query(`UPDATE usage_attribution_evidence e SET cleanup_generation=$3 WHERE e.user_id=$1 AND e.cleanup_generation=$2 AND NOT EXISTS(SELECT 1 FROM cleanup_sessions s WHERE s.job_id=$4 AND s.session_id=e.session_id)`,[saved.user_id,current.user.cleanup_generation,generation,id]);
   await client.query("INSERT INTO personal_model_revisions(user_id,revision) VALUES($1,1) ON CONFLICT(user_id) DO UPDATE SET revision=personal_model_revisions.revision+1",[saved.user_id]);
   await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'cleanup_submitted',$2,$3)",[actor.user_id,saved.user_id,{job_id:id,from:normalized.from,to:normalized.to,counts:current.counts,cleanup_generation:generation}]);return {job_id:id,status:'queued'};
  },{checkAccess:superAdmin,lockUserIds:[normalized.user_id]});
  await confirmAcceptance(submitted.job_id);superAdmin(await identity.requireUser(token));return submitted;
 }
 async function list(token:string,input:{user_id?:string;cursor?:string}={}){
  const actor=await identity.requireUser(token);superAdmin(actor);if(input.user_id!==undefined&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.user_id))throw new DomainError('invalid_request',400);const owner=input.user_id?.toLowerCase()??null;const binding=cursorScope(['cleanup-jobs',actor.user_id,owner]);const cursor=input.cursor?cursors.decode(input.cursor,binding):null;
  if(cursor&&(typeof cursor.at!=='string'||!Number.isFinite(Date.parse(cursor.at))||typeof cursor.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cursor.id)))throw new DomainError('invalid_cursor',400);
  const rows=(await db.query<{job_id:string;status:string;phase:string;error_code:string|null;user_id:string;target_email:string;current_email:string;current_name:string;from_at:Date;to_at:Date;created_at:Date;key_at:string;progress:Record<string,unknown>}>(`SELECT r.job_id,r.phase,r.user_id,r.target_email,u.email_key AS current_email,u.display_name AS current_name,r.from_at,r.to_at,r.created_at,r.created_at::text AS key_at,j.status,j.error_code,j.progress FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id JOIN users u ON u.id=r.user_id WHERE ($1::uuid IS NULL OR r.user_id=$1) AND ($2::timestamptz IS NULL OR (r.created_at,r.job_id)<($2::timestamptz,$3::uuid)) ORDER BY r.created_at DESC,r.job_id DESC LIMIT 21`,[owner,cursor?.at??null,cursor?.id??null])).rows;
  superAdmin(await identity.requireUser(token));const shown=rows.slice(0,20);return {items:shown.map(({key_at:_,...row})=>({...row,progress:publicProgress(row.progress),from_at:row.from_at.toISOString(),to_at:row.to_at.toISOString(),created_at:row.created_at.toISOString()})),next_cursor:rows.length>20?cursors.encode(binding,{at:shown.at(-1)!.key_at,id:shown.at(-1)!.job_id}):null};
 }
 async function resume(token:string,id:string,confirmationEmail:string){
  superAdmin(await identity.requireUser(token));if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new DomainError('not_found',404);
  const original=(await db.query<{user_id:string}>('SELECT user_id FROM cleanup_requests WHERE job_id=$1',[id])).rows[0];if(!original)throw new DomainError('not_found',404);
  const resumed=await identity.mutate(token,async(client,actor)=>{
   if(!options.journal)throw new DomainError('cleanup_unavailable',503);
   const target=(await client.query<{email_key:string}>('SELECT email_key FROM users WHERE id=$1',[original.user_id])).rows[0];if(target?.email_key!==confirmationEmail.trim().toLowerCase())throw new DomainError('cleanup_confirmation_mismatch',409);
   const job=(await client.query<{status:string;dataset_id:string;current_dataset:string;executor_id:string;executor_auth_version:number}>(`SELECT j.status,r.dataset_id,r.executor_id,r.executor_auth_version,(SELECT dataset_id FROM data_identity) AS current_dataset FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id WHERE j.id=$1 FOR UPDATE OF r,j`,[id])).rows[0];if(!job||job.dataset_id!==job.current_dataset)throw new DomainError('dataset_identity_changed',409);const auth=(await client.query<{auth_version:number}>('SELECT auth_version FROM users WHERE id=$1',[actor.user_id])).rows[0]!.auth_version;if(job.status!=='failed'){if(['queued','running','succeeded'].includes(job.status)&&job.executor_id===actor.user_id&&job.executor_auth_version===auth)return {job_id:id,status:job.status};throw new DomainError('cleanup_not_retryable',409);}
   if((await client.query("SELECT 1 FROM cleanup_requests r JOIN jobs j ON j.id=r.job_id WHERE r.user_id=$1 AND r.job_id<>$2 AND j.status IN('queued','running')",[original.user_id,id])).rowCount)throw new DomainError('cleanup_in_progress',409);
   await client.query('UPDATE cleanup_requests SET executor_id=$2,executor_auth_version=$3 WHERE job_id=$1',[id,actor.user_id,auth]);await client.query("UPDATE jobs SET status='queued',generation=generation+1,attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp() WHERE id=$1",[id]);await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'cleanup_resumed',$2,$3)",[actor.user_id,original.user_id,{job_id:id}]);return {job_id:id,status:'queued'};
  },{checkAccess:superAdmin,lockUserIds:[original.user_id]});
  await confirmAcceptance(resumed.job_id);superAdmin(await identity.requireUser(token));return resumed;
 }
 return {preview,submit,status,list,resume,runOne:createCleanupWorker(db,identity,options).runOne};
}
