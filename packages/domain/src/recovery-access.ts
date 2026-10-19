import {configuredEmailDomains} from './email-domains.js';
import {restoreProjectBarriers} from './project-cleanup-proof.js';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database,Transaction,CleanupJournal,CleanupCheckpointRef} from '@adi/storage';
import {DomainError} from './errors.js';
import {hashPassword,verifyPassword} from './password.js';
import {accessDigest,accessMetadata,accessTime,validateAccessSnapshot,validUuid,type AccessMetadata,type RecoveryAccessSnapshot} from './recovery-access-model.js';
export type {RecoveryAccessSnapshot} from './recovery-access-model.js';
export interface RecoveryCredential{version:1;run_id:string;review_id:string;email:string;temporary_password:string;release_token:string;expires_at:string}
interface Run{id:string;dataset_id:string;state:string;checkpoint_id:string|null;checkpoint_digest:string|null;access_review_id:string|null;access_state_digest:string|null;release_token_hash:string|null;bootstrap_auth_version:number|null;credential_expires_at:Date|null}
interface Review{id:string;run_id:string;snapshot_digest:string;target_digest:string;checkpoint_digest:string;bootstrap_user_id:string;bootstrap_email:string;expires_at:Date}
const stateDigest=(data:AccessMetadata)=>accessDigest({...data,users:data.users.map(({version:_,...r})=>r),departments:data.departments.map(({version:_,...r})=>r)});
const queueKinds=['derive_session','usage_sync','usage_attribution'];

/** Offline operator boundary. No web endpoint exposes these methods. */
export function createRecoveryAccessService(db:Database,journal:CleanupJournal,options:{clock?:()=>Date;emailDomains?:readonly string[];operatorLabel?:string}={}){
 const now=options.clock??(()=>new Date()),domains=configuredEmailDomains(options.emailDomains);
 const operator=options.operatorLabel??'local-operator';if(!operator.trim()||operator.length>254||Array.from(operator).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))throw new DomainError('invalid_request',400);
 async function current(sql:Transaction,id:string,lock=false){
  if(!validUuid(id))throw new DomainError('invalid_request',400);
  const row=(await sql.query<Run>(`SELECT r.* FROM recovery_runs r JOIN data_identity d ON d.recovery_id=r.id AND d.dataset_id=r.dataset_id WHERE r.id=$1${lock?' FOR UPDATE OF d,r':''}`,[id])).rows[0];
  if(!row||!row.checkpoint_id||!row.checkpoint_digest)throw new DomainError('recovery_context_changed',409);return row;
 }
 async function verifyCheckpoint(run:Run){
  try{return await journal.verifyCheckpoint(run.dataset_id,{checkpoint_id:run.checkpoint_id!,digest:run.checkpoint_digest!});}catch{throw new DomainError('recovery_checkpoint_mismatch',409);}
 }
 function bootstrap(snapshot:RecoveryAccessSnapshot,email:string){
  const at=BigInt(now().getTime())*1000n,user=snapshot.users.find(value=>value.email_key===email);
  if(!user||user.status!=='active'||!snapshot.grants.some(grant=>grant.user_id===user.id&&grant.role==='super'&&accessTime(grant.valid_from)<=at&&(grant.valid_to===null||accessTime(grant.valid_to)>at)))throw new DomainError('recovery_bootstrap_not_authorized',409);
  return user;
 }
 async function exportSnapshot(checkpoint:CleanupCheckpointRef):Promise<RecoveryAccessSnapshot>{
  await db.assertNotRecovering();const data=await db.transaction(async sql=>{
   await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const identity=(await sql.query<{dataset_id:string;recovery_id:string|null}>('SELECT dataset_id,recovery_id FROM data_identity')).rows[0];if(!identity||identity.recovery_id)throw new DomainError('recovery_quarantined',503);
   return {version:1 as const,dataset_id:identity.dataset_id,exported_at:now().toISOString(),checkpoint:{checkpoint_id:checkpoint.checkpoint_id,digest:checkpoint.digest},...await accessMetadata(sql)};
  });
  validateAccessSnapshot(data,domains);const proof=await journal.verifyCheckpoint(data.dataset_id,checkpoint),generations=new Map<string,number>();for(const entry of proof)generations.set(entry.record.user_id,Math.max(generations.get(entry.record.user_id)??0,entry.record.cleanup_generation));if(data.users.some(user=>user.cleanup_generation!==(generations.get(user.id)??0))||[...generations.keys()].some(id=>!data.users.some(user=>user.id===id)))throw new DomainError('recovery_access_checkpoint_mismatch',409);await db.assertNotRecovering();return data;
 }
 async function review(runId:string,value:unknown,bootstrapEmail:string){
  const snapshot=validateAccessSnapshot(value,domains),email=bootstrapEmail.trim().toLowerCase(),selected=bootstrap(snapshot,email),run=await current(db,runId);await verifyCheckpoint(run);
  if(snapshot.dataset_id!==run.dataset_id||snapshot.checkpoint.checkpoint_id!==run.checkpoint_id||snapshot.checkpoint.digest!==run.checkpoint_digest)throw new DomainError('recovery_access_checkpoint_mismatch',409);
  return db.transaction(async sql=>{
   const active=await current(sql,runId,true);if(!['awaiting_identity_review','access_applied','credential_ready'].includes(active.state))throw new DomainError('recovery_access_not_ready',409);
   if(active.checkpoint_digest!==snapshot.checkpoint.digest)throw new DomainError('recovery_context_changed',409);
   if((await sql.query('SELECT 1 FROM recovery_cleanup_operations WHERE run_id=$1 AND NOT complete LIMIT 1',[runId])).rowCount)throw new DomainError('recovery_access_not_ready',409);
   const before=await accessMetadata(sql),users=new Map(snapshot.users.map(user=>[user.id,user])),departments=new Set(snapshot.departments.map(department=>department.id));
   if(before.users.some(user=>!users.has(user.id))||before.departments.some(department=>!departments.has(department.id)))throw new DomainError('recovery_access_incomplete',409);
   const old=new Map(before.users.map(user=>[user.id,user]));
   const owned=(data:AccessMetadata,id:string)=>({grants:data.grants.filter(r=>r.user_id===id),memberships:data.memberships.filter(r=>r.user_id===id),eligibility:data.eligibility.filter(r=>r.user_id===id),provider_identities:data.provider_identities.filter(r=>r.user_id===id)});
   const changes=snapshot.users.filter(user=>!old.has(user.id)||accessDigest(old.get(user.id)&&{email_key:old.get(user.id)!.email_key,display_name:old.get(user.id)!.display_name,status:old.get(user.id)!.status})!==accessDigest({email_key:user.email_key,display_name:user.display_name,status:user.status})||accessDigest(owned(before,user.id))!==accessDigest(owned(snapshot,user.id))).map(user=>({user_id:user.id,before_email:old.get(user.id)?.email_key??null,email:user.email_key,display_name:user.display_name,before_status:old.get(user.id)?.status??null,after_status:user.status,before:owned(before,user.id),after:owned(snapshot,user.id)}));
   const id=randomUUID(),digest=accessDigest(snapshot),expires=new Date(now().getTime()+600000);
   await sql.query('INSERT INTO recovery_access_reviews(id,run_id,snapshot_digest,target_digest,checkpoint_digest,bootstrap_user_id,bootstrap_email,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,runId,digest,accessDigest(before),run.checkpoint_digest,selected.id,email,expires]);
   await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'access_review_prepared',$2)",[runId,{operator,review_id:id,snapshot_digest:digest,bootstrap_user_id:selected.id}]);
   return {operator,review_id:id,snapshot_digest:digest,expires_at:expires.toISOString(),source_exported_at:snapshot.exported_at,bootstrap_email:email,counts:{new_users:snapshot.users.filter(user=>!old.has(user.id)).length,changed_users:changes.length,users:snapshot.users.length,departments:snapshot.departments.length,grants:snapshot.grants.length,official_mappings:snapshot.usage_mappings.length},changes,departments:{before:before.departments,after:snapshot.departments},official_mappings:{before:before.usage_mappings,after:snapshot.usage_mappings}};
  });
 }
 async function apply(runId:string,reviewId:string,value:unknown){
  if(!validUuid(reviewId))throw new DomainError('invalid_request',400);
  const snapshot=validateAccessSnapshot(value,domains),run=await current(db,runId),proof=await verifyCheckpoint(run);
  return db.transaction(async sql=>{
   const active=await current(sql,runId,true),review=(await sql.query<Review>('SELECT * FROM recovery_access_reviews WHERE id=$1 AND run_id=$2',[reviewId,runId])).rows[0];
   if(!review||review.expires_at<=now()||review.snapshot_digest!==accessDigest(snapshot)||review.checkpoint_digest!==active.checkpoint_digest||snapshot.dataset_id!==active.dataset_id||snapshot.checkpoint.checkpoint_id!==active.checkpoint_id||!['awaiting_identity_review','access_applied','credential_ready'].includes(active.state))throw new DomainError('recovery_access_review_stale',409);
   bootstrap(snapshot,review.bootstrap_email);const before=await accessMetadata(sql);if(review.target_digest!==accessDigest(before))throw new DomainError('recovery_access_review_stale',409);
   const oldIds=new Set(before.users.map(user=>user.id)),oldById=new Map(before.users.map(user=>[user.id,user]));
   for(const user of snapshot.users){const old=oldById.get(user.id),generation=Math.max(0,...proof.filter(entry=>entry.record.user_id===user.id).map(entry=>entry.record.cleanup_generation));if(old?old.cleanup_generation!==user.cleanup_generation:generation!==user.cleanup_generation)throw new DomainError('recovery_cleanup_state_mismatch',409);}
   const affectedBindings=new Set<string>();for(const binding of before.provider_identities){const next=snapshot.provider_identities.find(row=>row.user_id===binding.user_id&&row.provider_account===binding.provider_account);if(!next||next.provider_user_id!==binding.provider_user_id||next.verified_email!==binding.verified_email)affectedBindings.add(binding.user_id);}
   for(const user of snapshot.users)if(oldById.get(user.id)?.email_key!==user.email_key)affectedBindings.add(user.id);
   // Temporary non-email values cannot collide with validated source addresses.
   // The target remains fenced, and these replacements commit atomically.
   await sql.query("UPDATE users SET email_key='recovery:'||id::text,status=CASE WHEN management_source='environment' THEN 'suspended' ELSE status END");await sql.query('UPDATE departments SET deleted_at=COALESCE(deleted_at,clock_timestamp())');
   await sql.query(`INSERT INTO users(id,email_key,display_name,status,management_source,version,cleanup_generation,created_at)
    SELECT id,email_key,display_name,status,management_source,version,0,created_at FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,email_key text,display_name text,status text,management_source text,version int,created_at timestamptz)
    ON CONFLICT(id) DO UPDATE SET email_key=excluded.email_key,display_name=excluded.display_name,status=excluded.status,management_source=excluded.management_source,version=GREATEST(users.version,excluded.version)+1,auth_version=users.auth_version+1,ingest_epoch=users.ingest_epoch+1`,[JSON.stringify(snapshot.users)]);
   await sql.query(`INSERT INTO departments(id,name,version,deleted_at) SELECT id,name,version,deleted_at FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,name text,version int,deleted_at timestamptz)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=GREATEST(departments.version,excluded.version)+1,deleted_at=excluded.deleted_at`,[JSON.stringify(snapshot.departments)]);
   const tables=[
    ['membership_periods','id,user_id,department_id,valid_from,valid_to','id uuid,user_id uuid,department_id uuid,valid_from timestamptz,valid_to timestamptz',snapshot.memberships],
    ['eligibility_periods','id,user_id,included,valid_from,valid_to','id uuid,user_id uuid,included boolean,valid_from timestamptz,valid_to timestamptz',snapshot.eligibility],
    ['role_grants','id,user_id,role,scope_id,valid_from,valid_to','id uuid,user_id uuid,role text,scope_id uuid,valid_from timestamptz,valid_to timestamptz',snapshot.grants],
    ['usage_department_mappings','id,provider_account,external_department_id,department_id,valid_from,valid_to,created_by,created_at','id uuid,provider_account text,external_department_id text,department_id uuid,valid_from timestamptz,valid_to timestamptz,created_by uuid,created_at timestamptz',snapshot.usage_mappings],
    ['usage_provider_identities','provider_account,user_id,provider_user_id,verified_email,verified_at','provider_account text,user_id uuid,provider_user_id text,verified_email text,verified_at timestamptz',snapshot.provider_identities],
   ] as const;
   for(const [table,columns,types,values] of tables){await sql.query(`DELETE FROM ${table}`);await sql.query(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS x(${types})`,[JSON.stringify(values)]);}
   for(const account of new Set([...before.usage_mappings,...snapshot.usage_mappings].map(row=>row.provider_account)))await sql.query('INSERT INTO usage_mapping_state(provider_account,version) VALUES($1,1) ON CONFLICT(provider_account) DO UPDATE SET version=usage_mapping_state.version+1',[account]);
   if(affectedBindings.size){const ids=[...affectedBindings];await sql.query('UPDATE usage_scopes SET active_run_id=NULL,published_run_id=NULL,verified_run_id=NULL,last_verified_at=NULL,revision=revision+1 WHERE user_id=ANY($1::uuid[])',[ids]);await sql.query('DELETE FROM usage_attribution_evidence WHERE user_id=ANY($1::uuid[])',[ids]);await sql.query("UPDATE usage_attribution_subjects SET generation=generation+1,probe_state='failed',observed_at=NULL,error_code='recovery_identity_changed' WHERE user_id=ANY($1::uuid[])",[ids]);}
   for(const user of snapshot.users.filter(user=>!oldIds.has(user.id))){for(const entry of proof.filter(entry=>entry.record.user_id===user.id)){const r=entry.record;await sql.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,$4)',[user.id,r.from,r.to,r.cleanup_generation]);for await(const barriers of entry.projects())await restoreProjectBarriers(sql,user.id,barriers);}await sql.query('UPDATE users SET cleanup_generation=$2 WHERE id=$1',[user.id,user.cleanup_generation]);await sql.query('UPDATE recovery_cleanup_operations SET user_id=$2::uuid,absent_user=false WHERE run_id=$1 AND record->>\'user_id\'=$2::text',[runId,user.id]);}
   await sql.query('DELETE FROM login_sessions');await sql.query("UPDATE credentials SET must_change=true,temporary_expires_at='1970-01-01Z'");await sql.query('UPDATE installations SET enabled=false');
   const state=stateDigest(await accessMetadata(sql));await sql.query("UPDATE recovery_runs SET state='access_applied',access_review_id=$2,access_state_digest=$3,release_token_hash=NULL,bootstrap_auth_version=NULL,credential_expires_at=NULL WHERE id=$1",[runId,reviewId,state]);await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'access_snapshot_applied',$2)",[runId,{operator,review_id:reviewId,snapshot_digest:review.snapshot_digest,users:snapshot.users.length}]);return {state:'access_applied' as const,serving:false};
  });
 }
 async function resumeBackground(runId:string){
  return db.transaction(async sql=>{const run=await current(sql,runId,true);if(!['access_applied','credential_ready'].includes(run.state))throw new DomainError('recovery_access_not_ready',409);const result=await sql.query("UPDATE jobs SET status='queued',generation=generation+1,progress='{}',attempt=0,error_code=NULL,available_at=clock_timestamp() WHERE id IN(SELECT id FROM jobs WHERE status='cancelled' AND error_code='recovery_quarantined' AND kind=ANY($1::text[]) ORDER BY id LIMIT 200)",[queueKinds]);return !!result.rowCount;});
 }
 async function issueCredential(runId:string,reviewId:string):Promise<RecoveryCredential>{
  if(!validUuid(reviewId))throw new DomainError('invalid_request',400);
  const password=randomBytes(24).toString('base64url'),token=randomBytes(32).toString('base64url'),encoded=await hashPassword(password),expires=new Date(now().getTime()+86400000);
  return db.transaction(async sql=>{
   const run=await current(sql,runId,true),review=(await sql.query<Review>('SELECT * FROM recovery_access_reviews WHERE id=$1 AND run_id=$2',[reviewId,runId])).rows[0];if(!review||run.access_review_id!==reviewId||!['access_applied','credential_ready'].includes(run.state)||run.access_state_digest!==stateDigest(await accessMetadata(sql)))throw new DomainError('recovery_access_review_stale',409);
   const user=(await sql.query<{email_key:string;status:string;auth_version:number}>('SELECT email_key,status,auth_version FROM users WHERE id=$1 FOR UPDATE',[review.bootstrap_user_id])).rows[0];if(user?.status!=='active'||user.email_key!==review.bootstrap_email||!(await sql.query("SELECT 1 FROM role_grants WHERE user_id=$1 AND role='super' AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)",[review.bootstrap_user_id,now()])).rowCount)throw new DomainError('recovery_bootstrap_not_authorized',409);
   await sql.query('UPDATE users SET auth_version=auth_version+1,version=version+1 WHERE id=$1',[review.bootstrap_user_id]);await sql.query('INSERT INTO credentials(user_id,password_hash,must_change,temporary_expires_at) VALUES($1,$2,true,$3) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,must_change=true,temporary_expires_at=excluded.temporary_expires_at,updated_at=clock_timestamp()',[review.bootstrap_user_id,encoded,expires]);
   await sql.query("UPDATE recovery_runs SET state='credential_ready',release_token_hash=$2,bootstrap_auth_version=$3,credential_expires_at=$4 WHERE id=$1",[runId,accessDigest(token),user.auth_version+1,expires]);await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'bootstrap_credential_issued',$2)",[runId,{operator,review_id:reviewId,user_id:review.bootstrap_user_id,expires_at:expires.toISOString()}]);return {version:1,run_id:runId,review_id:reviewId,email:user.email_key,temporary_password:password,release_token:token,expires_at:expires.toISOString()};
  });
 }
 async function release(runId:string,credential:RecoveryCredential,confirmationEmail:string){
  if(!validUuid(runId)||!credential||credential.version!==1||credential.run_id!==runId||!validUuid(credential.review_id)||typeof credential.release_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(credential.release_token)||typeof credential.temporary_password!=='string')throw new DomainError('invalid_recovery_credential',422);
  const ack=accessDigest({run_id:runId,review_id:credential.review_id,email:credential.email,release_token:credential.release_token});
  const prior=(await db.query<{release_ack_digest:string}>('SELECT r.release_ack_digest FROM recovery_runs r JOIN data_identity d ON d.dataset_id=r.dataset_id AND d.recovery_id IS NULL WHERE r.id=$1 AND r.state=\'released\'',[runId])).rows[0];
  if(prior){if(prior.release_ack_digest!==ack||confirmationEmail.trim().toLowerCase()!==credential.email)throw new DomainError('recovery_confirmation_mismatch',409);return {state:'released' as const,serving:true,already_released:true};}
  const run=await current(db,runId);await verifyCheckpoint(run);
  return db.transaction(async sql=>{
   const active=await current(sql,runId,true),review=(await sql.query<Review>('SELECT * FROM recovery_access_reviews WHERE id=$1 AND run_id=$2',[credential.review_id,runId])).rows[0];if(!review||active.state!=='credential_ready'||active.access_review_id!==review.id||active.checkpoint_digest!==run.checkpoint_digest||!active.release_token_hash||!timingSafeEqual(Buffer.from(active.release_token_hash,'hex'),Buffer.from(accessDigest(credential.release_token),'hex'))||!active.credential_expires_at||active.credential_expires_at<=now())throw new DomainError('recovery_access_review_stale',409);
   if(confirmationEmail.trim().toLowerCase()!==review.bootstrap_email||credential.email!==review.bootstrap_email)throw new DomainError('recovery_confirmation_mismatch',409);
   if(active.access_state_digest!==stateDigest(await accessMetadata(sql)))throw new DomainError('recovery_access_review_stale',409);
   if((await sql.query('SELECT 1 FROM recovery_cleanup_operations WHERE run_id=$1 AND NOT complete LIMIT 1',[runId])).rowCount)throw new DomainError('recovery_access_not_ready',409);
   if((await sql.query("SELECT 1 FROM jobs WHERE status='cancelled' AND error_code='recovery_quarantined' AND kind=ANY($1::text[]) LIMIT 1",[queueKinds])).rowCount)throw new DomainError('recovery_background_pending',409);
   const account=(await sql.query<{password_hash:string;status:string;auth_version:number;must_change:boolean;temporary_expires_at:Date}>('SELECT c.*,u.status,u.auth_version FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1 FOR UPDATE OF u,c',[review.bootstrap_user_id])).rows[0];if(!account||account.status!=='active'||account.auth_version!==active.bootstrap_auth_version||!account.must_change||account.temporary_expires_at<=now()||!await verifyPassword(credential.temporary_password,account.password_hash)||!(await sql.query("SELECT 1 FROM role_grants WHERE user_id=$1 AND role='super' AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)",[review.bootstrap_user_id,now()])).rowCount)throw new DomainError('recovery_bootstrap_not_authorized',409);
   const summary=(await sql.query('SELECT count(*)::int AS operations,count(*) FILTER(WHERE NOT complete)::int AS remaining,count(DISTINCT (record->>\'user_id\')) FILTER(WHERE absent_user)::int AS absent_users FROM recovery_cleanup_operations WHERE run_id=$1',[runId])).rows[0];if(Number(summary?.absent_users)>0)throw new DomainError('recovery_access_incomplete',409);
   // For configuration accounts this temporary credential only proves offline release.
   // Startup must reapply the configured password after recovery is explicitly released.
   await sql.query("DELETE FROM credentials c USING users u WHERE c.user_id=u.id AND u.management_source='environment'");
   await sql.query('DELETE FROM login_sessions');await sql.query('UPDATE installations SET enabled=false');await sql.query("UPDATE recovery_runs SET state='released',release_token_hash=NULL,release_summary=$2,release_ack_digest=$3,updated_at=clock_timestamp() WHERE id=$1",[runId,summary,ack]);await sql.query('UPDATE data_identity SET recovery_id=NULL WHERE recovery_id=$1',[runId]);await sql.query("INSERT INTO recovery_events(run_id,action,metadata) VALUES($1,'recovery_released',$2)",[runId,{operator,review_id:review.id,snapshot_digest:review.snapshot_digest,checkpoint_digest:active.checkpoint_digest,bootstrap_user_id:review.bootstrap_user_id}]);return {state:'released' as const,serving:true};
  });
 }
 return {exportSnapshot,review,apply,resumeBackground,issueCredential,release};
}
