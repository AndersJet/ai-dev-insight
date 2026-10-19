import type {Transaction} from '@adi/storage';
import type {DatabaseObservation} from './database-monitor.js';
export interface MonitorAlert {key:string;severity:'warning'|'high'|'critical'|'resolved'|'unknown';subject:string|null;value:string|null}
export function evaluateDatabaseAlerts(data:DatabaseObservation,budget?:string):MonitorAlert[]{
 const alerts:MonitorAlert[]=[];
 if(budget){const percent=BigInt(data.schema_bytes)*100n/BigInt(budget);if(percent>=70n)alerts.push({key:'storage_budget',severity:percent>=95n?'critical':percent>=85n?'high':'warning',subject:null,value:percent.toString()});}
 if(!data.track_counts)alerts.push({key:'statistics_disabled',severity:'high',subject:null,value:null});
 if(!data.autovacuum_enabled)alerts.push({key:'autovacuum_disabled',severity:'high',subject:null,value:null});
 for(const table of data.tables){
  if(data.autovacuum_enabled&&!table.autovacuum_enabled)alerts.push({key:`autovacuum_disabled:${table.table}`,severity:'warning',subject:table.table,value:null});
  if(table.dead_estimate!==null&&table.live_estimate!==null){const dead=BigInt(table.dead_estimate),total=dead+BigInt(table.live_estimate);if(dead>=10000n&&dead*100n>=total*20n)alerts.push({key:`dead_tuple_backlog:${table.table}`,severity:'warning',subject:table.table,value:table.dead_estimate});}
 }
 return alerts;
}
export async function persistMonitorAlerts(sql:Transaction,alerts:MonitorAlert[],target:string|null,unassessed:{budget:boolean;statistics:boolean;tableAutovacuum:boolean}){
 const previous=(await sql.query<MonitorAlert>('SELECT key,severity,subject,value FROM monitor_alerts')).rows;
 const changes=alerts.filter(alert=>!previous.some(old=>old.key===alert.key&&old.severity===alert.severity));
 for(const old of previous)if(old.severity!=='resolved'&&!alerts.some(item=>item.key===old.key)){
  const unknown=(old.key==='storage_budget'&&unassessed.budget)||(old.key.startsWith('dead_tuple_backlog:')&&unassessed.statistics)||(old.key.startsWith('autovacuum_disabled:')&&unassessed.tableAutovacuum);
  const next:MonitorAlert={...old,severity:unknown?'unknown':'resolved',value:unknown?null:old.value};if(next.severity!==old.severity)changes.push(next);
 }
 for(const alert of alerts.concat(changes.filter(item=>item.severity==='resolved'||item.severity==='unknown'))){await sql.query(`INSERT INTO monitor_alerts(key,severity,subject,value) VALUES($1,$2,$3,$4)
  ON CONFLICT(key) DO UPDATE SET severity=excluded.severity,subject=excluded.subject,value=excluded.value,last_observed_at=clock_timestamp()`,[alert.key,alert.severity,alert.subject,alert.value]);}
 for(const alert of changes)await sql.query("INSERT INTO monitor_alert_events(payload,target,status) VALUES($1,$2,CASE WHEN $2::text IS NULL THEN 'disabled' ELSE 'queued' END)",[alert,target]);
 await sql.query("UPDATE monitor_alert_events SET status='cancelled',last_error='delivery_expired' WHERE id IN(SELECT id FROM monitor_alert_events WHERE created_at<clock_timestamp()-interval '30 days' AND status='queued' LIMIT 100)");
 // Operational transitions are not identity/security audit records. Keep 30 days,
 // never delete an in-flight delivery or an active condition.
 await sql.query("DELETE FROM monitor_alert_events WHERE id IN(SELECT id FROM monitor_alert_events WHERE created_at<clock_timestamp()-interval '30 days' AND status IN('sent','disabled','failed','cancelled') ORDER BY created_at LIMIT 100)");
 await sql.query("DELETE FROM monitor_alerts WHERE severity='resolved' AND last_observed_at<clock_timestamp()-interval '30 days'");
}
