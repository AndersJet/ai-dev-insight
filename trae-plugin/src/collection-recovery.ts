import {randomUUID,createHash} from 'node:crypto';
import {lstat,readFile,writeFile,rename,rm,readdir} from 'node:fs/promises';
import {join,dirname,win32,posix} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {preparePrivateDirectory,protectPrivateFile} from './private-files.js';
import {acquireDirectoryLock} from './directory-lock.js';
import {environmentRecoveryDirectory} from './environment-paths.js';
import type {PreparedHook,HookStatus,HookInstallationWrites} from './hook-setup.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const fail=(code:string):never=>{throw new Error(code);};
const check=(signal:AbortSignal)=>{if(signal.aborted)fail('recovery_cancelled');};
type Platform='win32'|'darwin';
export type RecoveryPhase='running'|'completed'|'failed'|'rollback_failed';
export interface RecoveryRecord {version:1;id:string;owner:string;phase:RecoveryPhase;step:string;updated:number;backup:string;code?:string}
export interface RecoveryPlan {owner:string;issues:string[];fingerprint:string;prepared:PreparedHook;hooks:string;resetAllHooks:boolean}
interface Options {profile:string;platform:Platform;now?:()=>number}
interface Execution {signal:AbortSignal;pause:()=>Promise<void>;install:(prepared:PreparedHook,recordWrites:(writes:HookInstallationWrites)=>Promise<void>)=>Promise<HookStatus>;resume:()=>Promise<void>;current:()=>boolean;onChange:(record:RecoveryRecord)=>void}
const messages:Record<string,string>={recovery_changed:'配置在确认后发生变化，请重新检查。',recovery_cancelled:'身份、平台或窗口状态已变化，本次修复已停止。',recovery_busy:'另一个窗口正在安装或修复，请稍后重试。',recovery_conflict:'检测到无法确认的配置变化，请查看备份并联系管理员。',recovery_unsafe_path:'配置路径或文件不安全，已停止自动修复。',recovery_unknown_hooks:'无法安全识别旧 Hook，请先检查配置。',recovery_permission:'文件被占用或没有写入权限，请关闭其他 Trae 窗口、检查权限后重试。',recovery_policy:'系统执行策略阻止安装，请联系管理员检查策略后重试。',recovery_failed:'环境修复未完成，旧环境已备份，采集保持暂停。'};
export const recoveryMessage=(code:string)=>messages[code]??'环境修复未完成，请查看日志。';

/** Only exact generated groups are owned; substring matches never authorize deletion. */
export function managedGroup(profile:string,release:string,event:string,platform:Platform){
  const path=platform==='win32'?win32:posix,folder=path.join(profile,'adi-native-collector',release);
  const quote=(v:string)=>platform==='win32'?"'"+v.replace(/'/g,"''")+"'":"'"+v.replace(/'/g,"'\\''")+"'";
  const command=platform==='win32'?`try { & ${quote(path.join(folder,'adi-sender.exe'))} ${quote(path.join(folder,'config.json'))} *> $null } catch {} ; exit 0`:`/bin/bash ${quote(path.join(folder,'send-hook.sh'))} ${quote(path.join(folder,'config.json'))} >/dev/null 2>&1; exit 0`;
  return {hooks:[{type:'command',command,timeout:2}],...(['PreToolUse','PostToolUse','Notification'].includes(event)?{matcher:'*'}:{}),...(event==='Stop'?{loop_limit:1000}:{})};
}
function document(raw:Buffer|undefined){
  const v:unknown=raw?.toString().trim()?JSON.parse(raw.toString()):{version:1,hooks:{}};
  if(!object(v)||(v.version!==undefined&&v.version!==1))return fail('recovery_unknown_hooks');
  if(v.hooks===undefined)v.hooks={};if(!object(v.hooks)||Object.values(v.hooks).some(v=>!Array.isArray(v)))return fail('recovery_unknown_hooks');
  return v as Record<string,unknown>&{hooks:Record<string,unknown[]>};
}
export function stripManagedHooks(raw:Buffer|undefined,profile:string,platform:Platform){
  const doc=document(raw),found:{event:string;release:string;group:unknown}[]=[];
  for(const [event,groups]of Object.entries(doc.hooks))doc.hooks[event]=groups.filter(group=>{
    if(!JSON.stringify(group)?.toLowerCase().includes('adi-native-collector'))return true;
    const ids=JSON.stringify(group).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g)??[];
    const release=events.includes(event)?ids.find(id=>isDeepStrictEqual(group,managedGroup(profile,id,event,platform))):undefined;
    if(!release||found.some(row=>row.event===event))return fail('recovery_unknown_hooks');found.push({event,release,group});return false;
  });
  if(found.length&&(found.length!==6||new Set(found.map(v=>v.release)).size!==1))fail('recovery_unknown_hooks');
  if(JSON.stringify(doc).toLowerCase().includes('adi-native-collector'))fail('recovery_unknown_hooks');
  return {doc,found};
}

/** Explicit reset accepts partial/modified ADI groups, but never deletes a peer subhook. */
export function resetHookDocument(raw:Buffer|undefined,profile:string,platform:Platform){
  let doc:ReturnType<typeof document>;
  try{doc=document(raw);}catch{return {hooks:JSON.stringify({version:1,hooks:{}}),resetAllHooks:true};}
  // Match the complete generated command, not only its executable prefix: a
  // user may append another command that must never disappear with ADI.
  const owned=(hook:unknown)=>{
    if(!object(hook)||hook.type!=='command'||typeof hook.command!=='string')return false;
    const ids=hook.command.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g)??[];
    return ids.some(id=>hook.command===managedGroup(profile,id,'Stop',platform).hooks[0]!.command);
  };
  for(const [event,groups]of Object.entries(doc.hooks))doc.hooks[event]=groups.flatMap(group=>{
    if(!object(group)||!Array.isArray(group.hooks))return [group];
    const hooks=group.hooks.filter(hook=>!owned(hook));return hooks.length===group.hooks.length?[group]:hooks.length?[{...group,hooks}]:[];
  });
  return {hooks:JSON.stringify(doc),resetAllHooks:false};
}

/** Fixed reset roots only. Backups and coordination survive replacement of control. */
export class CollectionRecovery {
  readonly control:string;readonly directory:string;
  constructor(private readonly options:Options){this.control=join(options.profile,'adi-plugin-control');this.directory=environmentRecoveryDirectory(options.profile);}
  private now(){return (this.options.now??Date.now)();}
  private async safe(path:string){
    let at=path;while(at.startsWith(this.options.profile)){const info=await lstat(at).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(info&&(info.isSymbolicLink()||(at!==path&&!info.isDirectory())))fail('recovery_unsafe_path');if(at===this.options.profile)break;at=dirname(at);}
  }
  private async read(path:string,limit=1048576):Promise<Buffer|undefined>{
    await this.safe(path);const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(!info)return;
    if(!info.isFile()||info.size>limit)fail('recovery_unsafe_path');return readFile(path);
  }
  private async atomic(path:string,data:Uint8Array|string){
    await this.safe(path);const temp=join(dirname(path),randomUUID()+'.tmp');
    try{await writeFile(temp,data,{flag:'wx',mode:0o600});await protectPrivateFile(temp);await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  async status():Promise<RecoveryRecord|undefined>{
    // Read the previous version's barrier until a new reset supersedes it.
    const raw=await this.read(join(this.directory,'current.json'),4096)??await this.read(join(this.control,'recovery','current.json'),4096);if(!raw)return;
    const v=JSON.parse(raw.toString()) as RecoveryRecord;
    if(v.version!==1||!uuid.test(v.id)||!/^[a-f0-9]{64}$/.test(v.owner)||!['running','completed','failed','rollback_failed'].includes(v.phase)||!(v.backup===v.id||v.backup.endsWith('-'+v.id)&&/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(v.backup))||!Number.isSafeInteger(v.updated)||typeof v.step!=='string'||v.step.length>64)fail('recovery_conflict');return v;
  }
  async busy(){
    const folder=join(this.directory,'recovery.lock');await this.safe(folder);const names=await readdir(folder).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    if(!names.length)return false;if(names.length!==1||!uuid.test(names[0]!.replace(/\.json$/,'')))return true;
    const raw=await this.read(join(folder,names[0]!),128);if(!raw)return false;const v=JSON.parse(raw.toString());if(!Number.isSafeInteger(v.pid)||v.pid<1)return true;
    try{process.kill(v.pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}
  }
  private async fingerprint(){
    const hooks=await this.read(join(this.options.profile,'hooks.json'));
    const roots=[];
    for(const name of ['adi-native-collector','adi-plugin-control']){
      const path=join(this.options.profile,name);await this.safe(path);const stat=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});
      if(stat&&!stat.isDirectory())fail('recovery_unsafe_path');roots.push([name,stat?.ino??null]);
    }
    return hash(JSON.stringify([hooks?.toString('base64')??null,roots]));
  }
  async plan(owner:string,prepared:PreparedHook,_runtimeIssue:boolean):Promise<RecoveryPlan>{
    if(!/^[a-f0-9]{64}$/.test(owner))fail('recovery_conflict');
    const fingerprint=await this.fingerprint(),parsed=resetHookDocument(await this.read(join(this.options.profile,'hooks.json')),this.options.profile,this.options.platform);
    return {owner,prepared,fingerprint,...parsed,issues:['备份并重建 ADI 采集程序和运行环境',parsed.resetAllHooks?'Hook 配置无法解析：备份整份 hooks.json 后重建，原有第三方 Hook 也需手动恢复':'重新生成 ADI Hook，保留第三方 Hook 和其他配置']};
  }
  private async save(record:RecoveryRecord,step:string,phase=record.phase,code?:string){
    record={...record,step,phase,updated:this.now(),...(code?{code}:{})};
    const log=join(this.directory,record.backup,'recovery.jsonl'),previous=await this.read(log,65536);const lines=(previous?.toString().split('\n').filter(Boolean)??[]).slice(-127);lines.push(JSON.stringify({time:new Date(record.updated).toISOString(),stage:step,result:phase,...(code?{code}:{})}));await this.atomic(log,lines.join('\n')+'\n');await this.atomic(join(this.directory,'current.json'),JSON.stringify(record));return record;
  }
  private async disabled(owner:string){
    await preparePrivateDirectory(this.control);
    await this.atomic(join(this.control,'control.json'),JSON.stringify({version:2,owner,generation:randomUUID(),clock_kind:this.options.platform==='win32'?'windows-qpc-v1':'macos-continuous-v1',enabled:false,leases:[]}));
  }
  async execute(plan:RecoveryPlan,work:Execution):Promise<RecoveryRecord>{
    await preparePrivateDirectory(this.directory);const unlock=await acquireDirectoryLock(this.directory,'recovery.lock',work.signal,0).catch(()=>fail('recovery_busy'));
    let installationUnlock:(()=>Promise<void>)|undefined,collectionUnlock:(()=>Promise<void>)|undefined,record:RecoveryRecord|undefined;
    const notify=(v:RecoveryRecord)=>{try{work.onChange(v);}catch{/* UI failures do not change the committed environment. */}};
    try{
      installationUnlock=await acquireDirectoryLock(this.directory,'install.lock',work.signal,0).catch(()=>fail('recovery_busy'));
      check(work.signal);if(!work.current())fail('recovery_cancelled');if(await this.fingerprint()!==plan.fingerprint)fail('recovery_changed');
      const id=randomUUID(),backup=new Date(this.now()).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')+'-'+id,folder=join(this.directory,backup);await preparePrivateDirectory(folder);
      record={version:1,id,backup,owner:plan.owner,phase:'running',step:'pause',updated:this.now()};record=await this.save(record,'pause');notify(record);
      // Stable locks live outside the reset roots; peers cannot install, pulse,
      // or submit through a freshly recreated directory while it is replaced.
      collectionUnlock=await acquireDirectoryLock(this.directory,'collection.lock',work.signal,5000);
      await work.pause();check(work.signal);if(!work.current())fail('recovery_cancelled');
      if(await this.fingerprint()!==plan.fingerprint)fail('recovery_changed');
      const runtimeUnlock=await acquireDirectoryLock(this.directory,'runtime.lock',work.signal,5000);
      try{
        const hooksRaw=await this.read(join(this.options.profile,'hooks.json'));if(hooksRaw)await this.atomic(join(folder,'hooks.json'),hooksRaw);
        for(const name of ['adi-native-collector','adi-plugin-control']){
          const path=join(this.options.profile,name);await this.safe(path);
          try{await rename(path,join(folder,name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        }
        await this.disabled(plan.owner);await this.atomic(join(this.options.profile,'hooks.json'),plan.hooks);
      }finally{await runtimeUnlock();}
      record=await this.save(record,'install');notify(record);
      const installed=await work.install(plan.prepared,async()=>{});
      if(!['ready','installed'].includes(installed.state))fail(installed.reason==='hook_file_permission'?'recovery_permission':installed.reason==='powershell_execution_policy'?'recovery_policy':'recovery_failed');check(work.signal);if(!work.current())fail('recovery_cancelled');
      record=await this.save(record,'resume');notify(record);await work.resume();check(work.signal);if(!work.current())fail('recovery_cancelled');
      record=await this.save(record,'complete','completed');notify(record);return record;
    }catch(reason){
      if(!record)throw reason;
      const error=(reason??{}) as NodeJS.ErrnoException,code=['EACCES','EPERM','EBUSY'].includes(error.code??'')?'recovery_permission':Object.hasOwn(messages,error.message)?error.message:'recovery_failed';
      // Do not restore broken programs or overwrite any concurrent external edit.
      // The complete original trees remain in this private backup for inspection.
      try{await work.pause();}catch{/* Keep the persistent barrier on any failure. */}
      try{const release=await acquireDirectoryLock(this.directory,'runtime.lock',undefined,5000);try{await this.disabled(plan.owner);}finally{await release();}}catch{/* The persistent barrier also prevents subsequent plugin heartbeats. */}
      record=await this.save(record,'failed','failed',code);notify(record);return record;
    }finally{await collectionUnlock?.();await installationUnlock?.();await unlock();}
  }
  paths(record:RecoveryRecord){const directory=record.backup===record.id?join(this.control,'recovery'):this.directory;return {backup:join(directory,record.backup),log:join(directory,record.backup,'recovery.jsonl')};}
}
