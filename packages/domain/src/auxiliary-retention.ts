import type {Transaction} from '@adi/storage';
export interface AuxiliaryProgress{aux_phase?:number;aux_deleted_rows?:number;aux_cancelled_jobs?:number}
/** Operational working data only. Audit, cleanup and recovery evidence are retained. */
export async function retireAuxiliaryBatch(sql:Transaction,at:Date,batch:number,p:AuxiliaryProgress):Promise<boolean>{
 const phase=p.aux_phase??0,week=new Date(at.getTime()-7*86400000);let removed=0;
 if(phase===0)removed=(await sql.query('DELETE FROM login_sessions WHERE token_hash IN(SELECT token_hash FROM login_sessions WHERE expires_at<=$1 ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)',[at,batch])).rowCount??0;
 else if(phase===1)removed=(await sql.query('DELETE FROM cleanup_previews WHERE id IN(SELECT p.id FROM cleanup_previews p WHERE expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM cleanup_requests r WHERE r.preview_id=p.id) ORDER BY expires_at LIMIT $2 FOR UPDATE OF p SKIP LOCKED)',[at,batch])).rowCount??0;
 else if(phase===2)removed=(await sql.query('DELETE FROM import_batches WHERE id IN(SELECT id FROM import_batches WHERE expires_at<=$1 AND job_id IS NULL ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)',[at,batch])).rowCount??0;
 else if(phase===3){
  const rows=(await sql.query<{id:string;job_id:string;status:string}>(`SELECT b.id,b.job_id,j.status FROM import_batches b JOIN jobs j ON j.id=b.job_id WHERE b.expires_at<=$1 AND (j.status<>'running' OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp()) ORDER BY b.expires_at,b.id LIMIT $2 FOR UPDATE OF j,b SKIP LOCKED`,[at,batch])).rows;
  for(const row of rows){if(['queued','running'].includes(row.status)){await sql.query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_token=NULL,lease_until=NULL,progress='{}',error_code='preview_expired' WHERE id=$1",[row.job_id]);p.aux_cancelled_jobs=(p.aux_cancelled_jobs??0)+1;}await sql.query('DELETE FROM import_batches WHERE id=$1',[row.id]);removed++;}
 }else if(phase===4)removed=(await sql.query('DELETE FROM runtime_heartbeats WHERE (component,boot_id) IN(SELECT component,boot_id FROM runtime_heartbeats WHERE last_observed_at<$1 ORDER BY last_observed_at LIMIT $2 FOR UPDATE SKIP LOCKED)',[week,batch])).rowCount??0;
 else if(phase===5){
  const id=`CASE WHEN j.payload->>'session_id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (j.payload->>'session_id')::uuid END`,user=`CASE WHEN j.payload->>'user_id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (j.payload->>'user_id')::uuid END`;
  removed=(await sql.query(`DELETE FROM jobs WHERE id IN(SELECT j.id FROM jobs j WHERE j.status IN('succeeded','failed','cancelled') AND j.status_since<$1 AND j.kind IN('derive_session','usage_attribution','usage_sync','member_import')
   AND NOT EXISTS(SELECT 1 FROM import_batches b WHERE b.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM cleanup_requests r WHERE r.job_id=j.id)
   AND (j.kind NOT IN('derive_session','usage_attribution') OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=${id}))
   AND (j.kind<>'usage_sync' OR NOT EXISTS(SELECT 1 FROM usage_scopes s WHERE s.provider_account=j.payload->>'provider_account' AND s.user_id=${user} AND s.business_date::text=j.payload->>'business_date')) ORDER BY j.status_since,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED)`,[week,batch])).rowCount??0;
 }else return false;
 p.aux_deleted_rows=(p.aux_deleted_rows??0)+removed;if(!removed)p.aux_phase=phase+1;return true;
}
