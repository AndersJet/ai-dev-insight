import type {Database} from '@adi/storage';
import {DomainError} from './errors.js';
import {evaluateDatabaseAlerts,persistMonitorAlerts,type MonitorAlert} from './monitor-alerts.js';

export interface DatabaseObservation {
 source:'postgres_catalog_estimates';observed_at:string;schema_bytes:string;budget_bytes:string|null;delivery_configured:boolean;bloat_bytes:null;
 track_counts:boolean;autovacuum_enabled:boolean;stats_reset_at:string|null;table_count:number;
 tables:{table:string;bytes:string;live_estimate:string|null;dead_estimate:string|null;last_vacuum_at:string|null;last_analyze_at:string|null;autovacuum_enabled:boolean}[];
}
export function createDatabaseMonitor(db:Database,options:{storageBudgetBytes?:string;deliveryTarget?:string}={}){
 if(options.storageBudgetBytes!==undefined&&!/^[1-9]\d{0,19}$/.test(options.storageBudgetBytes))throw new Error('Invalid storage budget');
 if(options.deliveryTarget!==undefined&&!/^[a-f0-9]{64}$/.test(options.deliveryTarget))throw new Error('Invalid delivery target');
 async function runOne(){
  let revision:string|undefined;try{return await db.transaction(async sql=>{
   await sql.query("SET LOCAL statement_timeout='1500ms'");await sql.query("SET LOCAL lock_timeout='100ms'");
   const identity=(await sql.query('SELECT recovery_id FROM data_identity FOR SHARE')).rows[0];if(!identity||identity.recovery_id)throw new DomainError('recovery_quarantined',503);
   const due=await sql.query<{revision:string}>('SELECT revision::text FROM database_monitor_state WHERE next_run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED');if(!due.rowCount)return false;revision=due.rows[0]!.revision;
   const config=(await sql.query<{track_counts:boolean;autovacuum_enabled:boolean;stats_reset_at:Date|null}>("SELECT current_setting('track_counts')='on' AS track_counts,current_setting('autovacuum')='on' AS autovacuum_enabled,(SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()) AS stats_reset_at")).rows[0]!;
   const tables=(await sql.query<{table:string;bytes:string;live_estimate:string;dead_estimate:string;last_vacuum_at:Date|null;last_analyze_at:Date|null;autovacuum_enabled:boolean}>(`SELECT c.relname AS table,pg_total_relation_size(c.oid)::text AS bytes,
    pg_stat_get_live_tuples(c.oid)::text AS live_estimate,pg_stat_get_dead_tuples(c.oid)::text AS dead_estimate,
    GREATEST(pg_stat_get_last_vacuum_time(c.oid),pg_stat_get_last_autovacuum_time(c.oid)) AS last_vacuum_at,GREATEST(pg_stat_get_last_analyze_time(c.oid),pg_stat_get_last_autoanalyze_time(c.oid)) AS last_analyze_at,
    $1::boolean AND COALESCE((SELECT option_value::boolean FROM pg_options_to_table(c.reloptions) WHERE option_name='autovacuum_enabled'),true) AS autovacuum_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN('r','m') ORDER BY pg_stat_get_dead_tuples(c.oid) DESC,c.relname LIMIT 501`,[config.autovacuum_enabled])).rows;
   if(tables.length>500)throw new DomainError('monitor_relation_limit',503);
   const observation:DatabaseObservation={source:'postgres_catalog_estimates',observed_at:new Date().toISOString(),schema_bytes:tables.reduce((sum,row)=>sum+BigInt(row.bytes),0n).toString(),bloat_bytes:null,budget_bytes:options.storageBudgetBytes??null,delivery_configured:!!options.deliveryTarget,...config,stats_reset_at:config.stats_reset_at?.toISOString()??null,table_count:tables.length,tables:tables.map(row=>({...row,live_estimate:config.track_counts?row.live_estimate:null,dead_estimate:config.track_counts?row.dead_estimate:null,last_vacuum_at:row.last_vacuum_at?.toISOString()??null,last_analyze_at:row.last_analyze_at?.toISOString()??null}))};
   await persistMonitorAlerts(sql,evaluateDatabaseAlerts(observation,options.storageBudgetBytes),options.deliveryTarget??null,{budget:options.storageBudgetBytes===undefined,statistics:!observation.track_counts,tableAutovacuum:!observation.autovacuum_enabled});
   await sql.query("UPDATE database_monitor_state SET observation=$1,observed_at=clock_timestamp(),next_run_at=clock_timestamp()+interval '60 seconds',last_error=NULL,revision=revision+1",[observation]);return true;
  });}catch(error){if(revision!==undefined)await db.query("UPDATE database_monitor_state SET last_error='monitor_sample_failed',next_run_at=clock_timestamp()+interval '60 seconds',revision=revision+1 WHERE revision=$1",[revision]).catch(()=>{});throw error;}
 }
 async function read(){
  const row=(await db.query<{observation:DatabaseObservation|null;observed_at:Date|null;last_error:string|null;stale:boolean}>("SELECT observation,observed_at,last_error,observed_at<clock_timestamp()-interval '3 minutes' AS stale FROM database_monitor_state")).rows[0]!;
  const alertRows=(await db.query<MonitorAlert&{total:number}>("SELECT count(*) OVER()::int AS total,key,severity,subject,value FROM monitor_alerts WHERE severity<>'resolved' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,key LIMIT 100")).rows;
  const events=(await db.query<MonitorAlert&{id:string;status:string;created_at:string;last_error:string|null}>("SELECT id,payload->>'key' AS key,payload->>'severity' AS severity,payload->>'subject' AS subject,payload->>'value' AS value,status,created_at::text,last_error FROM monitor_alert_events ORDER BY created_at DESC,id DESC LIMIT 20")).rows;
  return {alerts:alertRows.map(({total:_,...alert})=>{void _;return alert;}),alerts_total:alertRows[0]?.total??0,events,state:row.last_error?'degraded' as const:!row.observed_at?'unobserved' as const:row.stale?'stale' as const:'observed' as const,observation:row.observation,last_error:row.last_error};
 }
 return {runOne,read};
}
