import {randomUUID,createHash} from 'node:crypto';
import {createSocket,type Socket} from 'node:dgram';
import {join} from 'node:path';
import {lstat,readFile,writeFile,rename,unlink,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {preparePrivateDirectory} from './private-files.js';
import {acquireDirectoryLock} from './directory-lock.js';
import {observeDiagnostics,type DiagnosticEvent,safeDiagnosticFailure} from './diagnostics.js';

export const VERIFICATION_DURATION=15*60*1000,LOG_LIMIT=1024*1024;
const LEGACY_VERIFICATION_DURATION=30*60*1000;
export type Check='plugin'|'account'|'hook'|'version'|'statistics';
export type Confirmation='global'|'local'|'session';
type Result='active'|'passed'|'failed'|'unconfirmed';
interface State {id:string;started:number;deadline:number;result:Result;scope:string;checks:Record<Check,boolean>;confirmed:Record<Confirmation,boolean>;truncated:boolean;incomplete:boolean;detailsDeleted:boolean;log:string;end_reason?:'environment_repair'}
export interface VerificationWorkspace {id:string;label:string;remote:boolean}
export function verificationWorkspace(remoteName:string,folders:readonly string[],workspaceFile='',name=''):VerificationWorkspace{
  const remote=!!remoteName,roots=[...new Set(folders)].sort();
  return {id:createHash('sha256').update(JSON.stringify([remoteName,workspaceFile,roots])).digest('hex'),remote,label:(remote?'Remote SSH 项目：':'本地项目：')+(name||'未打开项目')};
}
interface Options {directory:string;control:string;workspace?:VerificationWorkspace;environment:()=>Promise<Record<string,string>>;onChange:()=>void;now?:()=>number;prepare?:(path:string)=>Promise<void>}
const checkNames:Check[]=['plugin','account','hook','version','statistics'];
const confirmations:Confirmation[]=['global','local','session'];
const nativeStages=new Set(['hook.entry','hook.runtime','hook.payload','hook.send','hook.response','hook.error']);
const nativeCodes=new Set(['runtime_unavailable','invalid_payload','budget_exhausted','runtime_changed','hook_failed','transport_failed','timeout','config_invalid']);
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Rebind on folder changes without letting old asynchronous work own the new task. */
export class WorkspaceInstallationVerification {
  private active:InstallationVerification;private selected:VerificationWorkspace;private ready=Promise.resolve();private stopped=false;
  constructor(private readonly options:Omit<Options,'workspace'>,private readonly getWorkspace:()=>VerificationWorkspace){this.selected=getWorkspace();this.active=this.create(this.selected);}
  private create(workspace:VerificationWorkspace){const manager=new InstallationVerification({...this.options,workspace,onChange:()=>{if(this.active===manager&&!this.stopped)this.options.onChange();}});return manager;}
  private select(){
    const workspace=this.getWorkspace();
    if(!this.stopped&&workspace.id!==this.selected.id){
      const previous=this.active;this.selected=workspace;const next=this.active=this.create(workspace);
      this.ready=this.ready.then(()=>previous.dispose()).then(async()=>{if(this.active===next&&!this.stopped)await next.restore();});
    }
    return this.active;
  }
  get workspace(){this.select();return this.selected;}
  get logDirectory(){return this.select().logDirectory;}
  snapshot(){return this.select().snapshot();}
  private async work(fn:(manager:InstallationVerification)=>Promise<void>){const manager=this.select();await this.ready;if(this.active===manager&&!this.stopped)await fn(manager);}
  restore(){return this.work(manager=>manager.restore());}
  start(scope:string){return this.work(manager=>manager.start(scope));}
  finish(result:Exclude<Result,'active'>,endReason?:'environment_repair'){return this.work(manager=>manager.finish(result,endReason));}
  setScope(scope:string){return this.select().setScope(scope);}
  setCheck(key:Check,value:boolean){this.select().setCheck(key,value);}
  resetHookVerification(){this.select().resetHookVerification();}
  confirm(key:Confirmation){this.select().confirm(key);}
  event(stage:string,error?:unknown){this.select().event(stage,error);}
  async dispose(){this.stopped=true;await this.ready;await this.active.dispose();}
}
/** One owning window, bounded asynchronous writes, two owned detailed files. */
export class InstallationVerification {
  private state:State|undefined;private socket:Socket|undefined;private release:(()=>Promise<void>)|undefined;private unsubscribe:(()=>void)|undefined;private timer:NodeJS.Timeout|undefined;
  private queue:Promise<void>=Promise.resolve();private queued=0;private bytes=0;private closing=false;private initializing:Promise<void>|undefined;private startWork:Promise<void>|undefined;private markerWork:Promise<void>|undefined;private markerPending=false;
  readonly logDirectory:string;
  private readonly controlDirectory:string;
  private diagnosticRelease:(()=>Promise<void>)|undefined;private retry:NodeJS.Timeout|undefined;private stopped=false;
  constructor(private readonly options:Options){
    if(options.workspace&&!/^[a-f0-9]{64}$/.test(options.workspace.id))throw new Error('invalid_verification_workspace');
    this.logDirectory=join(options.directory,...(options.workspace?['verifications',options.workspace.id]:[]),'debug-logs');
    this.controlDirectory=options.workspace?join(options.control,'verifications',options.workspace.id):options.control;
  }
  private now(){return (this.options.now??Date.now)();}
  snapshot(){const s=this.state;return s?{...s,workspace:this.options.workspace,checks:{...s.checks},confirmed:{...s.confirmed},canPass:s.result==='active'&&checkNames.every(k=>s.checks[k])&&confirmations.every(k=>s.confirmed[k]),logPath:s.result==='passed'&&s.detailsDeleted?'':join(this.logDirectory,s.log),finalizing:this.closing,readOnly:!this.release}:null;}
  private async json(path:string,limit:number){const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(!info)return;if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new Error('unsafe_verification_file');return JSON.parse(await readFile(path,'utf8')) as unknown;}
  private enqueue(work:()=>Promise<void>){if(this.queued>=64){if(this.state)this.state.incomplete=true;return;}this.queued++;this.queue=this.queue.then(work).catch(()=>{if(this.state)this.state.incomplete=true;}).finally(()=>{this.queued--;});}
  private save(){const s=this.state;if(!s||!this.release)return;const copy=JSON.stringify(s);this.enqueue(()=>this.atomic(join(this.logDirectory,'verification.json'),copy));}
  private async atomic(path:string,value:string){const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,value,{flag:'wx',mode:0o600});const previous=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(previous&&(!previous.isFile()||previous.isSymbolicLink()))throw new Error('unsafe_verification_file');await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}}
  private readState(raw:unknown):State|undefined{
    const s=raw as State|undefined;if(!s||!idPattern.test(s.id)||!Number.isSafeInteger(s.started)||!Number.isSafeInteger(s.deadline)||![VERIFICATION_DURATION,LEGACY_VERIFICATION_DURATION].includes(s.deadline-s.started)||!['active','passed','failed','unconfirmed'].includes(s.result)||!/^(?:[a-f0-9]{64})?$/.test(s.scope)||!/^verification-\d{8}T\d{9}Z-[a-f0-9-]{36}\.jsonl$/.test(s.log)||!s.checks||!s.confirmed||checkNames.some(k=>typeof s.checks[k]!=='boolean')||confirmations.some(k=>typeof s.confirmed[k]!=='boolean')||typeof s.truncated!=='boolean'||typeof s.incomplete!=='boolean')return;
    // Preserve historical results; active legacy tasks keep their original start.
    const deadline=s.result==='active'?Math.min(s.deadline,s.started+VERIFICATION_DURATION):s.deadline;
    return {id:s.id,started:s.started,deadline,result:s.result,scope:s.scope,checks:Object.fromEntries(checkNames.map(k=>[k,s.checks[k]])) as State['checks'],confirmed:Object.fromEntries(confirmations.map(k=>[k,s.confirmed[k]])) as State['confirmed'],truncated:s.truncated,incomplete:s.incomplete,detailsDeleted:s.detailsDeleted===true,log:s.log,...(s.end_reason==='environment_repair'?{end_reason:s.end_reason}:{})};
  }
  async restore(){
    if(this.stopped)return;
    if(this.initializing)return this.initializing;
    this.initializing=this.restoreOwned().finally(()=>{this.initializing=undefined;});return this.initializing;
  }
  private async restoreOwned(){
    if(this.release)return;
    if(this.retry)clearTimeout(this.retry);
    try{this.state=this.readState(await this.json(join(this.logDirectory,'verification.json'),16384));if(!this.state||this.state.result!=='active')return;
      await this.claim();this.state=this.readState(await this.json(join(this.logDirectory,'verification.json'),16384));if(this.stopped||!this.state||this.state.result!=='active'){await this.detach();return;}const info=await lstat(join(this.logDirectory,this.state.log));if(!info.isFile()||info.isSymbolicLink()||info.size>LOG_LIMIT)throw new Error('unsafe_verification_file');this.bytes=info.size;
      if(this.now()>=this.state.deadline){await this.finish('unconfirmed');return;}this.save();await this.listen();if(this.stopped){await this.detach();return;}this.event('verification.resume');await this.header();if(this.stopped){await this.detach();return;}this.schedule();
    }catch(error){
      const busy=error instanceof Error&&error.message==='directory_lock_busy';
      if(this.state&&!busy)this.state.incomplete=true;await this.detach();
      if(busy&&this.options.workspace&&!this.stopped){this.retry=setTimeout(()=>void this.restore(),1000);this.retry.unref();}
    }finally{this.options.onChange();}
  }
  private async claim(){const prepare=this.options.prepare??preparePrivateDirectory;await prepare(this.controlDirectory);this.release=await acquireDirectoryLock(this.controlDirectory,'verification.lock',undefined,0);await prepare(this.logDirectory);}
  start(scope:string){this.stopped=false;if(this.startWork)return this.startWork;this.startWork=this.startOwned(scope,this.now()).finally(()=>{this.startWork=undefined;});return this.startWork;}
  private async startOwned(scope:string,started:number){
    if(this.closing)return;
    await this.restore();if(this.stopped)return;if(this.state?.result==='active'){if(!this.release)throw new Error('verification_other_window');return;}
    try{await this.claim();if(this.stopped){await this.detach();return;}const id=randomUUID();this.state={id,started,deadline:started+VERIFICATION_DURATION,result:'active',scope,checks:{plugin:true,account:false,hook:false,version:false,statistics:false},confirmed:{global:false,local:false,session:false},truncated:false,incomplete:false,detailsDeleted:false,log:'verification-'+new Date(started).toISOString().replace(/[-: .]/g,'')+'-'+id+'.jsonl'};
      const files=(await readdir(this.logDirectory)).filter(n=>/^verification-\d{8}T\d{9}Z-[a-f0-9-]{36}\.jsonl$/.test(n)).sort().reverse();for(const old of files.slice(1))await unlink(join(this.logDirectory,old));
      await writeFile(join(this.logDirectory,this.state.log),'',{flag:'wx',mode:0o600});this.bytes=0;this.closing=false;if(this.stopped){await this.detach();return;}await this.listen();if(this.stopped){await this.detach();return;}await this.header();if(this.stopped){await this.detach();return;}this.event('verification.start');this.save();this.schedule();await this.queue;
    }catch(e){await this.detach();throw e;}finally{this.options.onChange();}
  }
  private async header(){const s=this.state;if(!s)return;const environment=await this.options.environment();this.append({time:new Date(this.now()).toISOString(),verification:s.id,stage:'environment',...environment});}
  private schedule(){if(this.timer)clearTimeout(this.timer);const s=this.state;if(s?.result==='active'){this.timer=setTimeout(()=>void this.finish('unconfirmed'),Math.max(1,s.deadline-this.now()));this.timer.unref();}}
  private async listen(){const s=this.state!;this.socket=createSocket('udp4');this.socket.on('error',()=>{s.incomplete=true;});this.socket.on('message',(message,peer)=>{if(peer.address!=='127.0.0.1'||message.length>768)return;try{
    const v=JSON.parse(message.toString());if(v.verification!==s.id||!idPattern.test(v.operation)||!nativeStages.has(v.stage)||!['start','success','failed','skipped'].includes(v.phase))return;
    const event:DiagnosticEvent={operation:v.operation,stage:v.stage,phase:v.phase};if(Number.isInteger(v.elapsed_ms)&&v.elapsed_ms>=0&&v.elapsed_ms<=10000)event.elapsed_ms=v.elapsed_ms;if(Number.isInteger(v.http_status)&&v.http_status>=100&&v.http_status<=599)event.http_status=v.http_status;if(Number.isInteger(v.exit_code)&&v.exit_code>=0&&v.exit_code<=255)event.exit_code=v.exit_code;if(nativeCodes.has(v.code))event.code=v.code;this.record(event);
  }catch{/* Ignore malformed local packets and all unexpected fields. */}});
    this.unsubscribe=observeDiagnostics(e=>{if(this.state?.id===s.id)this.record(e);});
    try{
      // Native Hooks have one machine-local diagnostic marker. Owning that
      // receiver must not prevent another workspace from completing verification.
      if(this.options.workspace){
        if(this.options.workspace.remote){this.closeReceiver();return;}
        const prepare=this.options.prepare??preparePrivateDirectory;await prepare(this.options.control);
        this.diagnosticRelease=await acquireDirectoryLock(this.options.control,'verification.lock',undefined,0);
      }
      await new Promise<void>((resolve,reject)=>{this.socket!.once('error',reject);this.socket!.bind(0,'127.0.0.1',()=>{this.socket!.removeListener('error',reject);resolve();});});this.socket.unref();await this.marker();}
    catch(error){s.incomplete=true;this.closeReceiver();this.event('diagnostics.receiver',error);}

  }
  private marker(){
    if(this.options.workspace&&!this.diagnosticRelease)return Promise.resolve();
    this.markerPending=true;if(this.markerWork)return this.markerWork;
    this.markerWork=(async()=>{do{this.markerPending=false;const s=this.state,socket=this.socket;if(!this.release||!s||!socket||s.result!=='active'||this.closing)return;const address=socket.address();if(typeof address==='string')return;await this.atomic(join(this.options.control,'verification.json'),JSON.stringify({verification:s.id,port:address.port,deadline:s.deadline,owner:s.scope}));}while(this.markerPending);})().finally(()=>{
      this.markerWork=undefined;
      // A new request can arrive after the drain's final check, before this
      // promise's finally runs. Hand that one pending request to a new drain.
      if(this.markerPending&&this.release&&this.socket&&this.state?.result==='active'&&!this.closing)void this.marker().catch(()=>{if(this.state)this.state.incomplete=true;});
    });return this.markerWork;
  }
  private closeReceiver(){const socket=this.socket;this.socket=undefined;if(socket)try{socket.close();}catch{/* Already closed or failed to bind. */}}

  private append(value:Record<string,unknown>){const s=this.state;if(this.stopped||!s||!this.release||s.result!=='active'||this.closing||this.now()>=s.deadline||s.truncated)return;
    const line=JSON.stringify(value)+'\n',size=Buffer.byteLength(line);if(this.bytes+size>LOG_LIMIT-1024){s.truncated=true;this.save();return;}this.bytes+=size;const path=join(this.logDirectory,s.log);
    this.enqueue(async()=>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('unsafe_verification_file');const file=await open(path,constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW);try{const actual=await file.stat();if(!actual.isFile()||actual.size+size>LOG_LIMIT||actual.ino!==info.ino)throw new Error('log_limit');await file.write(line);}finally{await file.close();}});
  }
  record(event:DiagnosticEvent){const s=this.state;if(s)this.append({time:new Date(this.now()).toISOString(),verification:s.id,...event});}
  event(stage:string,error?:unknown){this.record({operation:randomUUID(),stage,phase:error?'failed':'success',...(error?safeDiagnosticFailure(error):{})});}
  setCheck(key:Check,value:boolean){const s=this.state;if(!s||!this.release||s.result!=='active'||s.checks[key]===value)return;s.checks[key]=value;this.event('check.'+key,value?undefined:new Error('unclassified'));this.save();this.options.onChange();}
  async setScope(scope:string){const s=this.state;if(!s||!this.release||s.result!=='active'||s.scope===scope)return;s.scope=scope;s.checks.account=false;s.checks.hook=false;s.checks.version=false;s.checks.statistics=false;s.confirmed={global:false,local:false,session:false};this.event('verification.identity_changed');this.save();void this.marker().catch(()=>{s.incomplete=true;});this.options.onChange();}
  resetHookVerification(){const s=this.state;if(!s||!this.release||s.result!=='active')return;s.checks.hook=false;s.confirmed.session=false;this.event('check.hook.reset');this.save();this.options.onChange();}
  confirm(key:Confirmation){const s=this.state;if(!s||!this.release||s.result!=='active'||!s.checks.hook||!s.checks.account||!confirmations.includes(key))return;if(key==='session'&&(!s.confirmed.global||!s.confirmed.local))return;s.confirmed[key]=true;this.event('confirm.'+key);this.save();this.options.onChange();}
  async finish(result:Exclude<Result,'active'>,endReason?:'environment_repair'){const s=this.state;if(!s||!this.release||s.result!=='active'||this.closing)return;if(this.now()>=s.deadline)result='unconfirmed';if(result==='passed'&&!this.snapshot()?.canPass)return;
    if(endReason)s.end_reason=endReason;this.event(endReason?'verification.interrupted':'verification.'+result);this.closing=true;s.result=result;if(this.timer)clearTimeout(this.timer);this.options.onChange();this.unsubscribe?.();this.unsubscribe=undefined;this.closeReceiver();
    // Control/result writes are diagnostic-only, independent of collection work.
    this.save();await this.queue;
    if(result==='passed'){try{await unlink(join(this.logDirectory,s.log));s.detailsDeleted=true;}catch{s.incomplete=true;}}
    if(!s.detailsDeleted){const line=JSON.stringify({time:new Date(this.now()).toISOString(),verification:s.id,stage:'verification.result',result,checks:s.checks,confirmed:s.confirmed,truncated:s.truncated,incomplete:s.incomplete,detailsDeleted:s.detailsDeleted,...(s.end_reason?{end_reason:s.end_reason}:{})})+'\n';try{const path=join(this.logDirectory,s.log),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size+Buffer.byteLength(line)>LOG_LIMIT)throw new Error('unsafe_verification_file');const file=await open(path,constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW);try{await file.write(line);}finally{await file.close();}}catch{s.incomplete=true;}}
    await this.atomic(join(this.logDirectory,'verification.json'),JSON.stringify(s)).catch(()=>{s.incomplete=true;});await this.detach();this.closing=false;this.options.onChange();
  }
  private async detach(){this.unsubscribe?.();this.unsubscribe=undefined;if(this.timer)clearTimeout(this.timer);this.closeReceiver();if(this.release){await this.markerWork?.catch(()=>{});if(!this.options.workspace||this.diagnosticRelease)await unlink(join(this.options.control,'verification.json')).catch(()=>{});if(this.diagnosticRelease){await this.diagnosticRelease().catch(()=>{});this.diagnosticRelease=undefined;}await this.release().catch(()=>{});this.release=undefined;}}
  async dispose(){this.event('verification.ide_shutdown');this.save();this.stopped=true;if(this.retry)clearTimeout(this.retry);this.unsubscribe?.();this.unsubscribe=undefined;if(this.timer)clearTimeout(this.timer);
    // A stalled disk cannot hold up extension-host shutdown. The owned lock is
    // reclaimed after process exit if these best-effort writes never complete.
    const cleanup=Promise.allSettled([this.startWork,this.initializing]).then(()=>this.queue).then(async()=>{if(this.release&&this.state)await this.atomic(join(this.logDirectory,'verification.json'),JSON.stringify(this.state)).catch(()=>{this.state!.incomplete=true;});await this.detach();});await Promise.race([cleanup,new Promise<void>(resolve=>{const timer=setTimeout(resolve,200);timer.unref();})]);
  }
}
