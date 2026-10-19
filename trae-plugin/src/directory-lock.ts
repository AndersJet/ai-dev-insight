import {randomUUID} from 'node:crypto';import {join} from 'node:path';import {performance} from 'node:perf_hooks';
import {mkdir,lstat,writeFile,rename,readdir,readFile,unlink,rmdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const code=(error:unknown)=>(error as NodeJS.ErrnoException).code;
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw new Error('directory_lock_aborted');};
async function removeOwned(directory:string,owner:string){
  try{await unlink(join(directory,owner));}catch(error){if(code(error)==='ENOENT')return;throw error;}
  try{await rmdir(directory);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(code(error)??''))throw error;}
}
async function recoverExitedOwner(directory:string):Promise<'live'|'recovered'|'missing'|'invalid'>{
  try{
    const folder=await lstat(directory);if(!folder.isDirectory()||folder.isSymbolicLink())return 'invalid';
    const names=await readdir(directory);if(names.length!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(names[0]!))return 'invalid';
    const name=names[0]!,file=join(directory,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>128)return 'invalid';
    const value=JSON.parse(await readFile(file,'utf8'));if(!value||Object.keys(value).length!==1||!Number.isSafeInteger(value.pid)||value.pid<1)return 'invalid';
    try{process.kill(value.pid,0);return 'live';}catch(error){if(code(error)==='ESRCH'){await removeOwned(directory,name);return 'recovered';}return code(error)==='EPERM'?'live':'invalid';}
  }catch(error){return code(error)==='ENOENT'?'missing':'invalid';}
}
/** Publish a populated reservation atomically; release and recovery remove only its unique owner file. */
export async function acquireDirectoryLock(directory:string,name:string,signal?:AbortSignal,waitMs=1500):Promise<()=>Promise<void>>{
  if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)||!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>5000)throw new Error('invalid_directory_lock');
  check(signal);const folder=await lstat(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('unsafe_directory_lock');
  const token=randomUUID(),owner=token+'.json',candidate=join(directory,name+'-'+token+'.tmp'),published=join(directory,name),until=performance.now()+waitMs;
  let created=false,backoff=15,recoveryRetry=true;
  try{
    await mkdir(candidate,{mode:0o700});created=true;
    await writeFile(join(candidate,owner),JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
    while(true){
      check(signal);
      try{
        // rename can replace an empty directory. Preserve an observed unknown
        // reservation, including empty ones; protocol owners publish nonempty.
        const existing=await lstat(published).catch(error=>{if(code(error)==='ENOENT')return;throw error;});
        if(existing)throw Object.assign(new Error('reserved'),{code:'EEXIST'});
        await rename(candidate,published);break;
      }catch(error){
        if(!['EEXIST','ENOTEMPTY','EPERM'].includes(code(error)??''))throw error;
        const state=await recoverExitedOwner(published);check(signal);
        // Reclaiming an exited owner is progress, even for a non-waiting caller.
        // Permit one immediate acquisition attempt without extending its budget.
        if(recoveryRetry&&(state==='recovered'||state==='missing')){recoveryRetry=false;continue;}
        // Release briefly leaves an empty directory between unlink and rmdir.
        // Observe again within the existing budget; never alter unknown owners.
        if(performance.now()>=until)throw new Error(state==='invalid'?'directory_lock_invalid':'directory_lock_busy',{cause:error});
        try{await delay(Math.min(backoff,Math.max(1,until-performance.now())),undefined,signal?{signal}:undefined);}catch{check(signal);throw new Error('directory_lock_busy');}
        backoff=Math.min(100,backoff*2);
      }
    }
    let released=false;
    const release=async()=>{if(released)return;released=true;await removeOwned(published,owner);};
    if(signal?.aborted){await release();check(signal);}
    return release;
  }catch(error){
    if(created){await removeOwned(candidate,owner);await rmdir(candidate).catch(()=>{});}
    throw error;
  }
}
