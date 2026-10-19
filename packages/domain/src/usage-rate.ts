import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '@adi/storage';
import { UsageProviderError } from './usage-provider.js';
export function createUsageRequestGate(db:Database,options:{providerAccount:string;intervalMs?:number}){
 const account=options.providerAccount;const interval=options.intervalMs??500;
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(account)||!Number.isInteger(interval)||interval<20||interval>5000)throw new Error('Invalid usage request gate');
 async function ensure(){await db.query('INSERT INTO usage_provider_control(provider_account,interval_ms) VALUES($1,$2) ON CONFLICT(provider_account) DO UPDATE SET interval_ms=GREATEST(usage_provider_control.interval_ms,excluded.interval_ms)',[account,interval]);}
 async function acquire(signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();await ensure();
  while(true){
   signal?.throwIfAborted();
   const granted=(await db.query<{at:Date}>(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at)
    UPDATE usage_provider_control c SET last_granted_at=t.at,next_request_at=t.at+c.interval_ms*interval '1 millisecond' FROM instant t
    WHERE c.provider_account=$1 AND c.next_request_at<=t.at AND c.paused_until<=t.at RETURNING t.at`,[account])).rows[0];
   signal?.throwIfAborted();if(granted)return granted.at.toISOString();
   const pending=(await db.query<{wait_ms:number;pause_seconds:number}>("SELECT GREATEST(1,ceil(extract(epoch FROM(GREATEST(next_request_at,paused_until)-clock_timestamp()))*1000))::integer AS wait_ms,GREATEST(0,ceil(extract(epoch FROM(paused_until-clock_timestamp()))))::integer AS pause_seconds FROM usage_provider_control WHERE provider_account=$1",[account])).rows[0]!;
   if(pending.pause_seconds>0)throw new UsageProviderError('provider_rate_limited',null,null,Math.min(3600,pending.pause_seconds));
   await delay(Math.min(5000,pending.wait_ms),undefined,{signal});
  }
 }
 async function pause(seconds:number){if(!Number.isFinite(seconds)||seconds<0)throw new Error('Invalid retry delay');await ensure();await db.query("UPDATE usage_provider_control SET paused_until=GREATEST(paused_until,clock_timestamp()+$2*interval '1 second') WHERE provider_account=$1",[account,Math.max(1,Math.min(3600,Math.ceil(seconds)))]);}
 return {acquire,pause,initialize:ensure};
}
