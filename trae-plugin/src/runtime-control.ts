import {environmentRecoveryDirectory} from './environment-paths.js';
import {pluginTimeouts} from './timeouts.js';
import {randomUUID,createHash} from 'node:crypto';
import {lstat,readFile,writeFile,rename,rm} from 'node:fs/promises';import {join,dirname,basename} from 'node:path';
import {preparePrivateDirectory,protectPrivateFile} from './private-files.js';import {acquireDirectoryLock} from './directory-lock.js';
import {readLeaseClock,activeRuntimeLease,validClockScope,type LeaseClock} from './runtime-clock.js';
export const runtimeOwner=(userId:string,origin:string)=>createHash('sha256').update(JSON.stringify([userId,origin])).digest('hex');
export interface RuntimeLease {id:string;expires_at:number;issued_at:number;clock_scope:string;monotonic_issued_at:number;monotonic_expires_at:number}
export interface ControlRecord {version:2;owner:string;generation:string;clock_kind:LeaseClock['kind'];enabled:boolean;leases:RuntimeLease[]}
interface LegacyControlRecord {version:1;owner:string;generation:string;enabled:boolean;leases:{id:string;expires_at:number}[]}
type StoredControl=ControlRecord|LegacyControlRecord;
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const validClock=(clock:LeaseClock)=>validClockScope(clock.kind,clock.scope)&&Number.isSafeInteger(clock.monotonic_ms)&&clock.monotonic_ms>=0;
function validReservation(value:unknown,clock:LeaseClock):value is RuntimeLease {
  const lease=value as Partial<RuntimeLease>|null;if(!lease||!uuid(lease.id)||!validClockScope(clock.kind,lease.clock_scope)||clock.kind!=='windows-qpc-v1'&&lease.clock_scope!==clock.scope)return false;
  const {issued_at:issued,expires_at:expires,monotonic_issued_at:monoIssued,monotonic_expires_at:monoExpires}=lease;
  return [issued,expires,monoIssued,monoExpires].every(Number.isSafeInteger)&&typeof issued==='number'&&typeof expires==='number'&&typeof monoIssued==='number'&&typeof monoExpires==='number'&&monoIssued>=0&&expires-issued>0&&expires-issued<=30000&&monoExpires-monoIssued>0&&monoExpires-monoIssued<=30000;
}
const localClockKind=():LeaseClock['kind']=>process.platform==='darwin'?'macos-continuous-v1':process.platform==='win32'?'windows-qpc-v1':'linux-boottime-v1';
export function isRuntimeActive(value:unknown,owner:string,now=Date.now(),clock?:LeaseClock):value is ControlRecord {
  const v=value as Partial<ControlRecord>|null;
  return !!v&&v.version===2&&v.owner===owner&&/^[a-f0-9]{64}$/.test(owner)&&uuid(v.generation)&&v.enabled===true&&!!clock&&validClock(clock)&&v.clock_kind===clock.kind&&Array.isArray(v.leases)&&v.leases.length<=100&&v.leases.some(lease=>activeRuntimeLease(lease,now,clock));
}
export class RuntimeControl {
  private readonly id=randomUUID();private stopped=false;private initialized=false;private revision=0;
  constructor(readonly directory:string,private readonly now=()=>Date.now(),private readonly clock:()=>Promise<LeaseClock>=readLeaseClock,private readonly protectFile:(path:string)=>Promise<void>=protectPrivateFile){}
  private async prepare(){
    const parent=await lstat(dirname(this.directory)).catch(error=>{if(error.code==='ENOENT')return;throw error;});if(parent&&(!parent.isDirectory()||parent.isSymbolicLink()))throw new Error('unsafe_runtime_path');
    if(!this.initialized){await preparePrivateDirectory(this.directory);this.initialized=true;}const info=await lstat(this.directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('unsafe_runtime_path');
  }
  private async read():Promise<StoredControl|undefined>{
    const path=join(this.directory,'control.json');
    try{
      const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw new Error('unsafe_runtime_file');
      const v=JSON.parse(await readFile(path,'utf8'));
      if(![1,2].includes(v.version)||typeof v.owner!=='string'||!/^[a-f0-9]{64}$/.test(v.owner)||!uuid(v.generation)||typeof v.enabled!=='boolean'||!Array.isArray(v.leases)||v.leases.length>100||v.version===2&&!['macos-continuous-v1','windows-qpc-v1','linux-boottime-v1'].includes(v.clock_kind))throw new Error('invalid_runtime_file');
      return v as StoredControl;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  private async mutate(action:(record:StoredControl|undefined)=>StoredControl|undefined,admit?:boolean):Promise<boolean>{
    await this.prepare();const coordination=(basename(this.directory)==='adi-plugin-control'?environmentRecoveryDirectory(dirname(this.directory)):join(this.directory,'coordination'));await preparePrivateDirectory(coordination);let release:()=>Promise<void>;
    try{release=await acquireDirectoryLock(coordination,'runtime.lock',undefined,pluginTimeouts.runtimeLock);}catch(error){if(error instanceof Error&&error.message==='directory_lock_busy')throw new Error('runtime_busy',{cause:error});if(error instanceof Error&&error.message==='directory_lock_invalid')throw new Error('runtime_coordination_requires_repair',{cause:error});throw error;}
    try{
      if(admit===false){const path=join(coordination,'current.json'),info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return;throw error;});if(info){if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return false;const recovery=JSON.parse(await readFile(path,'utf8'));if(recovery.phase!=='completed')return false;}}
      const next=action(await this.read());if(!next)return false;
      const temp=join(this.directory,`${randomUUID()}.tmp`);try{await writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await this.protectFile(temp);await rename(temp,join(this.directory,'control.json'));}finally{await rm(temp,{force:true});}
      return true;
    }finally{await release();}
  }
  async pulse(owner:string,enabled:boolean,options:{resume?:boolean;recovery?:boolean}={}):Promise<boolean>{
    if(this.stopped)return false;if(!/^[a-f0-9]{64}$/.test(owner))throw new Error('invalid_runtime_owner');
    if(!enabled){await this.stop(owner);return false;}
    const revision=this.revision;await this.prepare();const before=await this.read();if(this.stopped||revision!==this.revision)return false;
    if(!options.resume&&(!before||before.version!==2||before.owner!==owner||!before.enabled||!before.leases.some(lease=>lease.id===this.id)))return false;
    const clock=await this.clock();if(this.stopped||revision!==this.revision)return false;if(!validClock(clock))throw new Error('runtime_clock_unavailable');
    return this.mutate(record=>{
      if(this.stopped||revision!==this.revision||record?.generation!==before?.generation)return;
      const now=this.now(),same=record?.version===2&&record.owner===owner&&record.clock_kind===clock.kind;
      // Peers' Windows scopes are retained by time; native readers additionally
      // verify each writer's live PID and immutable process creation time.
      const peerClock=clock.kind==='windows-qpc-v1'&&same?{...clock,active_scopes:record.leases.filter(lease=>validClockScope(clock.kind,lease.clock_scope)).map(lease=>lease.clock_scope)}:clock;
      if(!options.resume&&(!same||!record.enabled||!record.leases.some(lease=>lease.id===this.id&&validReservation(lease,clock))))return;
      const peers=(same&&record.enabled?record.leases:[]).filter(lease=>lease.id!==this.id&&validReservation(lease,clock));
      const active=peers.filter(lease=>activeRuntimeLease(lease,now,peerClock));if(active.length>99)return;
      // Expired entries reserve a live window's ID, never its old permission to
      // run. Its own new heartbeat must write new deadlines; peers never do so.
      const leases=[...active,...peers.filter(lease=>!activeRuntimeLease(lease,now,peerClock)).slice(0,99-active.length)];
      return {version:2,owner,generation:same&&record.enabled?record.generation:randomUUID(),clock_kind:clock.kind,enabled:true,leases:[...leases,{id:this.id,expires_at:now+20000,issued_at:now,clock_scope:clock.scope,monotonic_issued_at:clock.monotonic_ms,monotonic_expires_at:clock.monotonic_ms+20000}]};
    },options.recovery===true);
  }
  async stop(owner:string){
    this.revision++;
    await this.mutate(record=>!record?{version:2,owner,generation:randomUUID(),clock_kind:localClockKind(),enabled:false,leases:[]}:record.owner===owner?{...record,generation:randomUUID(),enabled:false,leases:[]}:undefined);
  }
  /** Recovery only: replace a damaged internal control record with a disabled generation. */
  async reset(owner:string){
    if(!/^[a-f0-9]{64}$/.test(owner))throw new Error('invalid_runtime_owner');this.revision++;await this.prepare();
    const coordination=(basename(this.directory)==='adi-plugin-control'?environmentRecoveryDirectory(dirname(this.directory)):join(this.directory,'coordination'));await preparePrivateDirectory(coordination);
    const release=await acquireDirectoryLock(coordination,'runtime.lock',undefined,pluginTimeouts.runtimeLock);
    try{
      const path=join(this.directory,'control.json'),info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return;throw error;});
      if(info&&(!info.isFile()||info.isSymbolicLink()||info.size>32768))throw new Error('unsafe_runtime_file');
      const temp=join(this.directory,randomUUID()+'.tmp');
      try{await writeFile(temp,JSON.stringify({version:2,owner,generation:randomUUID(),clock_kind:localClockKind(),enabled:false,leases:[]}),{flag:'wx',mode:0o600});await this.protectFile(temp);await rename(temp,path);}finally{await rm(temp,{force:true});}
    }finally{await release();}
  }
  async close(owner:string){
    this.revision++;this.stopped=true;
    await this.mutate(record=>record?.owner===owner?record.version===1?{...record,leases:record.leases.filter(lease=>lease.id!==this.id)}:{...record,leases:record.leases.filter(lease=>lease.id!==this.id)}:undefined);
  }
}
