import type {CollectorConfig} from './collector.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,writeFile,rename,unlink,readdir,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
export interface SecretStore {get(key:string):PromiseLike<string|undefined>;store(key:string,value:string):PromiseLike<void>}
interface LocalState {version:1;sequence:string;owner:string;config:string;source_hash?:string;source_slot?:string}
export class PluginState {
  constructor(private readonly directory:string,private readonly secrets:SecretStore){}
  private secretKey(slot?:string){return (slot?'source-secret-v2:':'source-secret-v1:')+createHash('sha256').update(this.directory).digest('hex')+(slot?':'+slot:'');}
  private credentialKey(){return 'upload-credential-v1:'+createHash('sha256').update(this.directory).digest('hex');}
  private check(signal:AbortSignal){if(signal.aborted)throw new Error('state_aborted');}
  private async locked<T>(signal:AbortSignal,action:()=>Promise<T>):Promise<T>{
    await mkdir(this.directory,{recursive:true,mode:0o700});
    // Windows can spend over two seconds handing a reservation through concurrent
    // windows, even when each holder is brief. Cancellation still stops each retry.
    const path=join(this.directory,'state.lock'),until=performance.now()+5000,token=randomUUID(),owner=`${token}.json`,candidate=join(this.directory,`${token}.lock.tmp`);
    let acquired=false;
    try{
      this.check(signal);await mkdir(candidate,{mode:0o700});await writeFile(join(candidate,owner),JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
      while(true){
        this.check(signal);
        // Publish a nonempty directory atomically. A live owner always has its
        // unique file, so neither rename nor rmdir can replace its reservation.
        try{await rename(candidate,path);acquired=true;break;}
        catch(e){
          if(!['EEXIST','ENOTEMPTY','EPERM'].includes((e as NodeJS.ErrnoException).code??''))throw e;
          try{
            const entries=await readdir(path);
            if(entries.length===1&&/^[a-f0-9-]{36}\.json$/.test(entries[0]!)){
              const stale=join(path,entries[0]!),lock=JSON.parse(await readFile(stale,'utf8'));
              if(Number.isInteger(lock.pid)&&lock.pid>0){
                try{process.kill(lock.pid,0);}catch(error){
                  if((error as NodeJS.ErrnoException).code==='ESRCH'){
                    // Remove only the dead owner's unique file. Another owner
                    // has a different name and prevents removal of its folder.
                    await unlink(stale);await rmdir(path);
                  }
                }
              }
            }else if(entries.length===0)await rmdir(path);
          }catch{/* A competing owner may have changed the folder; retry within the budget. */}
          if(performance.now()>=until)throw new Error('state_busy',{cause:e});await new Promise(r=>setTimeout(r,20));
        }
      }
      this.check(signal);return await action();
    }finally{
      const directory=acquired?path:candidate;
      await unlink(join(directory,owner)).catch(()=>{});await rmdir(directory).catch(()=>{});
    }
  }
  private async read():Promise<LocalState|undefined>{
    let file;try{file=await open(join(this.directory,'state.json'),'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    try{const info=await file.stat();if(!info.isFile()||info.size>8192)throw new Error('state_invalid');const value=JSON.parse(await file.readFile('utf8'));
      if(value.version!==1||typeof value.sequence!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(value.sequence)||BigInt(value.sequence)>9223372036854775807n||typeof value.owner!=='string'||typeof value.config!=='string'||value.source_hash!==undefined&&(typeof value.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.source_hash)))throw new Error('state_invalid');if(value.source_slot!==undefined&&(typeof value.source_slot!=='string'||!/^[-a-f0-9]{36}$/.test(value.source_slot)))throw new Error('state_invalid');return value;
    }finally{await file.close();}
  }
  private async write(state:LocalState,signal:AbortSignal){
    this.check(signal);const path=join(this.directory,`${randomUUID()}.tmp`),file=await open(path,'wx',0o600);
    try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
    try{this.check(signal);await rename(path,join(this.directory,'state.json'));}finally{await unlink(path).catch(()=>{});}
  }
  async identity(config:CollectorConfig,signal:AbortSignal){
    return this.locked(signal,async()=>{
      let state=await this.read(),secret=await this.secrets.get(this.secretKey(state?.source_slot));this.check(signal);
      const owner=createHash('sha256').update(JSON.stringify([config.ntEmail,config.serverUrl])).digest('hex');
      if(state&&secret){
        if(!/^[A-Za-z0-9_-]{43}$/.test(secret)||Buffer.from(secret,'base64url').length!==32)throw new Error('source_state_invalid');
        const sourceHash=createHash('sha256').update(secret).digest('hex');
        if(state.source_hash&&state.source_hash!==sourceHash)throw new Error('source_identity_changed');
        if(!state.source_hash){state={...state,source_hash:sourceHash};await this.write(state,signal);}
      }
      if(!state||!secret||state.owner!==owner){
        // Publish the secret under a new slot before atomically changing its
        // state reference. Cancellation cannot overwrite the previous proof.
        // A missing state always starts a fresh proof, even after reinstall.
        const slot=randomUUID();secret=randomBytes(32).toString('base64url');
        await this.secrets.store(this.secretKey(slot),secret);this.check(signal);
        state={version:1,sequence:state?.sequence??'0',owner,config:randomUUID(),source_slot:slot,source_hash:createHash('sha256').update(secret).digest('hex')};await this.write(state,signal);
      }
      this.check(signal);return {source_secret:secret,source_config_id:state.config};
    });
  }
  async nextSequence(signal:AbortSignal,sourceConfigId?:string){return this.locked(signal,async()=>{const state=await this.read();if(!state)throw new Error('sequence_state_missing');if(sourceConfigId!==undefined&&state.config!==sourceConfigId)throw new Error('source_identity_changed');const next=BigInt(state.sequence)+1n;if(next>9223372036854775807n)throw new Error('sequence_overflow');await this.write({...state,sequence:String(next)},signal);return String(next);});}
  async storeCredential(config:CollectorConfig,sourceConfigId:string,token:string,signal:AbortSignal){
    if(!token.startsWith('adi_plugin_v1.')||token.length>4096)throw new Error('invalid_credential');
    return this.locked(signal,async()=>{
      const state=await this.read(),owner=createHash('sha256').update(JSON.stringify([config.ntEmail,config.serverUrl])).digest('hex');
      if(!state||state.config!==sourceConfigId||state.owner!==owner)throw new Error('source_identity_changed');
      this.check(signal);await this.secrets.store(this.credentialKey(),token);this.check(signal);
    });
  }
}
