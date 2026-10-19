import {ingestFailureProof,type IngestOptions,type IngestResult,type RuntimeHeartbeat} from '@adi/storage';import {setTimeout as delay} from 'node:timers/promises';import type {DeliveryMessage} from './delivery.js';
export interface IngestWorkerStore{
 policy():Promise<{expiresAt:number;installations:unknown[];writable:boolean}>|{expiresAt:number;installations:unknown[];writable:boolean};
 ingestJson(body:string,options:IngestOptions,retryDeadlineAt?:number):Promise<IngestResult>|IngestResult;
 reportRuntime?(value:RuntimeHeartbeat):Promise<boolean|void>|boolean|void;
 close():Promise<void>|void;
}
/** Common bounded IPC lifecycle; adapters own storage, never the HTTP process. */
export function startIngestWorker(factory:(configuration:Record<string,unknown>)=>Promise<IngestWorkerStore>|IngestWorkerStore){
 let store:IngestWorkerStore|undefined,configured=false,stopping=false,busy=false,pendingBytes=0,reporting=false,latestHeartbeat:RuntimeHeartbeat|undefined,policyTimer:ReturnType<typeof setTimeout>|undefined;
 const pending:DeliveryMessage[]=[];
 function send(message:unknown){if(process.connected)process.send?.(message,error=>{if(error)void stop();});}
 async function reportRuntime(){if(reporting||stopping||!store)return;reporting=true;try{while(latestHeartbeat&&!stopping){const value=latestHeartbeat;latestHeartbeat=undefined;try{await store.reportRuntime?.(value);}catch{/* Observation failure does not authorize capture or log secrets. */}}}finally{reporting=false;}}
 async function refreshPolicy(){if(!store||stopping)return;try{const value=await store.policy();if(!stopping)send({kind:'policy',...value});}catch{
  // A transient query failure leaves only the previous bounded TTL.
 }if(!stopping)policyTimer=setTimeout(()=>{void refreshPolicy();},2000);}
 async function pump(){if(busy||stopping||!store)return;busy=true;try{while(!stopping&&pending.length){const message=pending.shift()!;pendingBytes-=Buffer.byteLength(message.body);const context=message.context;
  if(!context||!Number.isSafeInteger(context.admissionEpoch)||context.admissionEpoch<=0||!Number.isFinite(Date.parse(context.receivedAt))||!/^[a-f0-9]{64}$/.test(context.tokenHash)){send({kind:'result',id:message.id,outcome:'rejected'});continue;}
  const options={admissionEpoch:context.admissionEpoch,receivedAt:new Date(context.receivedAt),tokenHash:context.tokenHash};let retried=false;
  while(!stopping){
   try{const result=await store.ingestJson(message.body,options,retried?message.deadline:undefined);send({kind:'result',id:message.id,outcome:result.outcome});break;}
   catch(error){
    const proof=ingestFailureProof(error);
    if(proof==='deadline_rollback'){send({kind:'result',id:message.id,outcome:'rejected'});break;}
    if(proof==='server_abort'){
     // This deadline only bounds work; the unchanged backend fences still
     // authorize every attempt using the original immutable admission context.
     if(!retried&&Number.isSafeInteger(message.deadline)&&message.deadline!-Date.now()>75){
      await delay(25);if(stopping)break;
      if(message.deadline!>Date.now()+50){retried=true;continue;}
     }
     send({kind:'result',id:message.id,outcome:'rejected'});break;
    }
    if(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^22[A-Z0-9]{3}$/.test(error.code)){send({kind:'result',id:message.id,outcome:'rejected'});break;}
    // A read/connection/COMMIT uncertainty is never automatically replayed.
    void stop();break;
   }
  }
 }}finally{busy=false;}}
 async function stop(){if(stopping)return;stopping=true;latestHeartbeat=undefined;clearTimeout(policyTimer);pending.length=0;pendingBytes=0;const deadline=setTimeout(()=>process.exit(1),5500);deadline.unref();try{await store?.close();}finally{process.exit(0);}}
 process.on('message',(message:unknown)=>{
  if(stopping||!message||typeof message!=='object'||!('kind'in message))return;
  if(message.kind==='configure'&&!configured){configured=true;void(async()=>{try{store=await factory(message as Record<string,unknown>);if(stopping){await store.close();return;}void refreshPolicy();void reportRuntime();send({kind:'ready'});}catch{void stop();}})();return;}
  if(message.kind==='runtime-heartbeat'&&configured&&'value'in message){latestHeartbeat=message.value as RuntimeHeartbeat;void reportRuntime();return;}
  if(message.kind==='runtime-final'&&configured&&'request_id'in message&&typeof message.request_id==='string'&&'value'in message){const requestId=message.request_id;void(async()=>{const value=message.value as RuntimeHeartbeat;let outcome=store?'unsupported':'unconfirmed';if(!value||value.component!=='collector'||value.state!=='stopped')outcome='unconfirmed';else if(store?.reportRuntime){try{outcome=await store.reportRuntime(value)===true?'acknowledged':'unconfirmed';}catch{outcome='unconfirmed';}}send({kind:'runtime-final-result',request_id:requestId,outcome});})();return;}
  if(message.kind!=='deliver'||!('id'in message)||typeof message.id!=='string'||!('body'in message)||typeof message.body!=='string')return;
  const bytes=Buffer.byteLength(message.body);if(!store||pending.length>=128||pendingBytes+bytes>8*1024*1024||bytes>2*1024*1024){send({kind:'result',id:message.id,outcome:'rejected'});return;}
  pending.push(message as DeliveryMessage);pendingBytes+=bytes;void pump();
 });
 process.on('disconnect',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
}
