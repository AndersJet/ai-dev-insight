import {setTimeout as delay} from 'node:timers/promises';
import type {createCleanupService} from '../../src/cleanup.js';

// The service bounds each response, not the lifetime of its durable write.
// Positive tests follow the same-request protocol on slower runners. Only this
// specific 503 is eligible; exhausted or unrelated failures still fail the test.
export async function confirmCleanupAcceptance<T>(operation:()=>Promise<T>,onUnconfirmed:()=>void=()=>{}){
 for(let attempt=0;attempt<8;attempt++){
  try{return await operation();}
  catch(error){
   if(!(error instanceof Error&&'code'in error&&error.code==='cleanup_acceptance_unconfirmed'&&'status'in error&&error.status===503))throw error;
   onUnconfirmed();
   if(attempt===7)throw error;
   await delay(100);
  }
 }
 throw new Error('Unreachable cleanup confirmation state');
}

type CleanupService=ReturnType<typeof createCleanupService>;
// Capture the input and key once, including when the caller passes randomUUID().
export function submitCleanupConfirmed(service:Pick<CleanupService,'submit'>,...args:Parameters<CleanupService['submit']>){
 return confirmCleanupAcceptance(()=>service.submit(...args));
}
export function resumeCleanupConfirmed(service:Pick<CleanupService,'resume'>,...args:Parameters<CleanupService['resume']>){
 return confirmCleanupAcceptance(()=>service.resume(...args));
}
