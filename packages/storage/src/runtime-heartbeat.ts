import type {Queryable} from './index.js';import {randomUUID} from 'node:crypto';
export type RuntimeComponent='collector'|'worker'|'usage_worker'|'cleanup_worker'|'maintenance_worker';
export interface RuntimeHeartbeat{component:RuntimeComponent;boot_id:string;sequence:number;state:'running'|'degraded'|'stopped';metrics:Record<string,number|boolean>}
const intake=['received','admitted','filtered','malformed','limited','aborted','readingBytes','readers','limited_body_bytes','limited_inflight_bytes','limited_readers','limited_read_timeout','limited_json_budget','limited_delivery_capacity'].map(v=>`intake_${v}`);
const delivery=['admitted','persisted','duplicate','dropped','deliveryUnknown','refused','ready','retainedItems','retainedBytes','inFlight','inFlightBytes','restarts','policyExpiresAt','pending','backpressured'].map(v=>`delivery_${v}`);
const worker=['cycles','failures','last_success_ms','work_units'];
const keys:Record<RuntimeComponent,Set<string>>={collector:new Set([...intake,...delivery]),worker:new Set(worker),usage_worker:new Set(worker),cleanup_worker:new Set(worker),maintenance_worker:new Set(worker)};
export async function recordRuntimeHeartbeat(db:Queryable,value:RuntimeHeartbeat){
 if(!value||!Object.hasOwn(keys,value.component)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.boot_id)||!Number.isSafeInteger(value.sequence)||value.sequence<1||!['running','degraded','stopped'].includes(value.state)||!value.metrics||typeof value.metrics!=='object'||Array.isArray(value.metrics))throw new Error('Invalid runtime heartbeat');
 for(const [key,metric] of Object.entries(value.metrics))if(!keys[value.component].has(key)||(typeof metric!=='boolean'&&(!Number.isSafeInteger(metric)||metric<0)))throw new Error('Invalid runtime metric');
 return Boolean((await db.query(`INSERT INTO runtime_heartbeats(component,boot_id,sequence,state,metrics) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(component,boot_id) DO UPDATE SET sequence=excluded.sequence,state=excluded.state,metrics=excluded.metrics,last_observed_at=clock_timestamp()
 WHERE runtime_heartbeats.sequence<excluded.sequence RETURNING boot_id`,[value.component,value.boot_id,value.sequence,value.state,JSON.stringify(value.metrics)])).rowCount);
}
export function createRuntimeReporter(db:Queryable,component:'worker'|'usage_worker'|'cleanup_worker'|'maintenance_worker'){
 const boot_id=randomUUID();let sequence=0,next=0,cycles=0,failures=0,lastSuccess=0,work=0,state:'running'|'degraded'|'stopped'='running';
 return {
  success(units=0){cycles++;work+=units;lastSuccess=Date.now();state='running';},
  failure(){cycles++;failures++;state='degraded';},
  async flush(stopped=false){if(stopped)state='stopped';if(!stopped&&Date.now()<next)return;next=Date.now()+10000;try{await recordRuntimeHeartbeat(db,{component,boot_id,sequence:++sequence,state,metrics:{cycles,failures,last_success_ms:lastSuccess,work_units:work}});}catch{/* A missing sample is not proof of health. */}},
 };
}
