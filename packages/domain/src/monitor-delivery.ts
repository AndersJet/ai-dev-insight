import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '@adi/storage';
import type {MonitorAlert} from './monitor-alerts.js';
/** Trusted deployment configuration only. Never accepts a browser-provided URL. */
export function createMonitorDelivery(db:Database,options:{url:string;bearerToken?:string}){
 const url=new URL(options.url);if(url.username||url.password||url.hash||!((url.protocol==='https:')||(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('HTTPS monitor destination required');
 if(options.bearerToken!==undefined&&(!options.bearerToken||/[\r\n]/.test(options.bearerToken)))throw new Error('Invalid monitor token');
 const target=createHash('sha256').update(url.href).digest('hex');
 async function runOne(){
  await db.assertNotRecovering();const token=randomUUID();
  const claim=await db.transaction(async sql=>{
   const identity=(await sql.query<{dataset_id:string;recovery_id:string|null}>('SELECT dataset_id,recovery_id FROM data_identity FOR SHARE')).rows[0];if(!identity||identity.recovery_id)return null;
   await sql.query("UPDATE monitor_alert_events SET status='failed',lease_token=NULL,lease_until=NULL,last_error='webhook_delivery_unconfirmed' WHERE target=$1 AND status='running' AND lease_until<clock_timestamp() AND attempt>=5",[target]);
   const row=(await sql.query<{id:string;payload:MonitorAlert;created_at:Date;attempt:number}>("SELECT id,payload,created_at,attempt FROM monitor_alert_events WHERE target=$1 AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp())) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[target])).rows[0];if(!row)return null;
   await sql.query("UPDATE monitor_alert_events SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',attempt=attempt+1 WHERE id=$1",[row.id,token]);return {...row,dataset_id:identity.dataset_id};
  });if(!claim)return false;
  let success=false;
  try{
   await db.assertNotRecovering();
   const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json','idempotency-key':claim.id,...(options.bearerToken?{authorization:`Bearer ${options.bearerToken}`}:{})},body:JSON.stringify({schema_version:1,event_id:claim.id,dataset_id:claim.dataset_id,occurred_at:claim.created_at.toISOString(),alert:claim.payload})});
   success=response.ok;await response.body?.cancel();
  }catch{/* Only a stable code is recorded; URL, token and remote response remain private. */}
  await db.query("UPDATE monitor_alert_events SET status=CASE WHEN $3 THEN 'sent' WHEN attempt>=5 THEN 'failed' ELSE 'queued' END,available_at=clock_timestamp()+LEAST(3600,30*power(2,attempt))*interval '1 second',lease_token=NULL,lease_until=NULL,last_error=CASE WHEN $3 THEN NULL ELSE 'webhook_delivery_unconfirmed' END WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp()",[claim.id,token,success]);return true;
 }
 return {target,runOne};
}
