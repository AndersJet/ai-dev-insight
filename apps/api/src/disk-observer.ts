import {statfs} from 'node:fs/promises';import {isAbsolute} from 'node:path';import type {DiskObservation} from '@adi/domain';
/** Deployment-only mount observation. No path can be supplied by an HTTP caller. */
export function createDiskObserver(path:string){
 if(!isAbsolute(path))throw new Error('Storage observer requires an absolute configured path');
 const missing=(reason:string):DiskObservation=>({observed:false,available_bytes:null,total_bytes:null,observed_at:null,reason,source:'configured_application_mount'});
 let pending:Promise<DiskObservation>|null=null,cached:DiskObservation|null=null,cachedAt=0;
 return async()=>{
  if(cached&&Date.now()-cachedAt<30000)return cached;
  if(!pending){pending=statfs(path,{bigint:true}).then(value=>({observed:true,available_bytes:(value.bavail*value.bsize).toString(),total_bytes:(value.blocks*value.bsize).toString(),observed_at:new Date().toISOString(),reason:null,source:'configured_application_mount' as const})).catch(()=>missing('observation_failed')).then(value=>{cached=value;cachedAt=Date.now();return value;}).finally(()=>{pending=null;});}
  let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([pending,new Promise<DiskObservation>(resolve=>{timer=setTimeout(()=>resolve(missing('observation_timeout')),500);})]);}finally{clearTimeout(timer);}
 };
}
