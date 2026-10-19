import {pluginTimeouts} from './timeouts.js';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile,writeFile,rename,lstat,unlink,readdir} from 'node:fs/promises';
import {decodePluginRelease,PLUGIN_RELEASE_MAX_BYTES,type PluginReleaseDto} from '@adi/contracts';
import {platformRequest,normalizeWebUrl} from './platform-session.js';
import {PluginHttpError,pluginFailureHint} from './http-client.js';
import {preparePrivateDirectory} from './private-files.js';
import {acquireDirectoryLock} from './directory-lock.js';
export interface UpdateSnapshot {version:string;build_id:string;phase:'idle'|'checking'|'downloading'|'installing'|'ready'|'installed'|'failed';available:PluginReleaseDto|null;trialEligible:boolean;trial:boolean;message:string}
interface Cached {origin:string;release:PluginReleaseDto;user_id:string}
interface Receipt {build_id:string;channel:'stable'|'trial'}
interface Options {directory:string;currentVersion:string;currentBuild:string;install:(path:string)=>Promise<void>;isInstalled?:(release:PluginReleaseDto)=>Promise<boolean>;onChange?:()=>void}
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]!>y[i]!?1:-1;}return 0;};
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
/** Owns only update artifacts; it never changes collection settings or credentials. */
export class PluginUpdater {
 private origin='';private token='';private userId='';private generation=0;private disposed=false;private busy=false;private controller=new AbortController();
 private available:PluginReleaseDto|null=null;private pilot:PluginReleaseDto|null=null;private pending:Cached|null=null;private loaded=false;private installedBuild='';private receipt:Receipt|undefined;
 private state:UpdateSnapshot;
 constructor(private readonly options:Options){this.state={version:options.currentVersion,build_id:options.currentBuild,phase:'idle',available:null,trialEligible:false,trial:false,message:'设置平台地址后可检查更新。'};}
 snapshot():UpdateSnapshot{return {...this.state,available:this.available,trialEligible:!!this.pilot};}
 configure(origin:string,token?:string,userId?:string){origin=origin?normalizeWebUrl(origin):'';if(origin===this.origin&&(token??'')===this.token&&(userId??'')===this.userId)return;this.generation++;this.controller.abort();this.controller=new AbortController();this.origin=origin;this.token=token??'';this.userId=userId??'';this.available=null;this.pilot=null;this.pending=null;this.loaded=false;this.busy=false;this.state.phase='idle';this.state.message=origin?'尚未检查更新。':'设置平台地址后可检查更新。';this.emit();}
 private emit(){this.options.onChange?.();}
 private current(g:number){return !this.disposed&&g===this.generation;}
 private set(phase:UpdateSnapshot['phase'],message:string){this.state.phase=phase;this.state.message=message;this.emit();}
 private file(build:string){return join(this.options.directory,build+'.vsix');}
 private runningReceipt(){return 'running-'+this.options.currentBuild+'.json';}
 private async installed(){return decodePluginRelease(await this.json('installed.json'));}
 private async installedIdentity(release:PluginReleaseDto|undefined){return release&&(!this.options.isInstalled||await this.options.isInstalled(release))?release.build_id:'';}
 // Call only while holding update.lock: all windows share the install floor.
 private async checkOrder(candidate:PluginReleaseDto){const installed=await this.installed();const shared=await this.json('pending.json') as Partial<Cached>|undefined;const prepared=decodePluginRelease(shared?.release);if(installed&&compare(candidate.version,installed.version)<0||shared?.origin===this.origin&&prepared&&compare(candidate.version,prepared.version)<0)throw new Error('update_superseded');return installed;}
 private async prune(){for(const name of await readdir(this.options.directory)){if(/^[a-f0-9]{64}\.vsix$/.test(name)&&name!==this.options.currentBuild+'.vsix'&&name!==this.pending?.release.build_id+'.vsix')await unlink(join(this.options.directory,name)).catch(()=>{});}}
 private async json(name:string){const path=join(this.options.directory,name),s=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(!s)return;if(!s.isFile()||s.isSymbolicLink()||s.size>65536)throw new Error('unsafe_update_state');return JSON.parse(await readFile(path,'utf8')) as unknown;}
 private async save(name:string,value:unknown,g?:number){if(g!==undefined&&!this.current(g))return;const temp=join(this.options.directory,randomUUID()+'.tmp');try{await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});if(g===undefined||this.current(g))await rename(temp,join(this.options.directory,name));}finally{await unlink(temp).catch(()=>{});}}
 private async load(g:number){if(this.loaded)return;await preparePrivateDirectory(this.options.directory);const release=await acquireDirectoryLock(this.options.directory,'update.lock',this.controller.signal);try{
  const raw=(await this.json(this.runningReceipt())??await this.json('receipt.json')) as Partial<Receipt>|undefined;if(raw?.build_id===this.options.currentBuild&&['stable','trial'].includes(raw.channel??''))this.receipt=raw as Receipt;
  const installed=await this.installed();this.installedBuild=await this.installedIdentity(installed);
  const cached=await this.json('pending.json') as Partial<Cached>|undefined;
  if(!this.current(g))return;if(!this.receipt&&installed?.build_id===this.options.currentBuild){this.receipt={build_id:installed.build_id,channel:installed.channel};await this.save(this.runningReceipt(),this.receipt,g);if(!this.current(g))return;}this.state.trial=this.receipt?.build_id===this.options.currentBuild&&this.receipt.channel==='trial';
  const candidate=decodePluginRelease(cached?.release);
  if(cached?.origin===this.origin&&candidate&&(candidate.build_id===this.options.currentBuild||candidate.channel==='stable'||!!this.token&&cached.user_id===this.userId)&&compare(candidate.version,this.options.currentVersion)>=0&&(!installed||compare(candidate.version,installed.version)>=0)){
   this.pending={origin:this.origin,release:candidate,user_id:typeof cached.user_id==='string'?cached.user_id:''};
   const cachedRelease=candidate;
   if(cachedRelease.build_id===this.options.currentBuild){this.receipt??={build_id:cachedRelease.build_id,channel:cachedRelease.channel};this.state.trial=this.receipt.channel==='trial';await this.save(this.runningReceipt(),this.receipt,g);if(!this.current(g))return;this.pending=null;await unlink(join(this.options.directory,'pending.json')).catch(()=>{});await unlink(this.file(cachedRelease.build_id)).catch(()=>{});if(!this.current(g))return;this.set('idle','当前构建已生效。');}
   else if(this.installedBuild===candidate.build_id){this.set('installed',`${candidate.version} 已安装，等待生效。`);}else this.set('ready',`已下载 ${candidate.version}，待安装。`);
  }
  if(!this.current(g))return;await this.prune();if(!this.current(g))return;this.loaded=true;
 }finally{await release();}}
 private needs(release:PluginReleaseDto){return compare(release.version,this.options.currentVersion)>=0&&release.build_id!==this.options.currentBuild;}
 private async metadata(path:string,g:number,trial=false){const r=await platformRequest(this.origin,path,this.controller.signal,{...(trial?{headers:{Authorization:`Bearer ${this.token}`}}:{})});if(!this.current(g))throw new Error('superseded');if(r.data===null)return null;const descriptor=decodePluginRelease(r.data);if(!descriptor)throw new Error('invalid_release');return descriptor;}
 async restore(){const g=this.generation;try{await this.load(g);}catch{if(this.current(g))this.set('failed','本机更新缓存暂不可用，当前版本保持不变。');}}
 async check(){if(this.busy||!this.origin||this.disposed)return;const g=this.generation;this.busy=true;try{
  await this.load(g);if(!this.current(g))return;this.set('checking','正在检查正式更新…');
  const stable=await this.metadata('/api/v1/plugin-releases/current',g);this.available=stable?.channel==='stable'&&this.needs(stable)?stable:null;
  const pilot=this.token?await this.metadata('/api/v1/plugin-releases/trial',g,true).catch(()=>null):null;this.pilot=pilot?.channel==='trial'?pilot:null;
  // Resolves promotions even when a newer formal version has already been published.
  const actual=await this.metadata(`/api/v1/plugin-releases/builds/${this.options.currentBuild}`,g,!!this.token).catch(()=>null);
  if(actual?.build_id===this.options.currentBuild){this.receipt={build_id:actual.build_id,channel:actual.channel};this.state.trial=actual.channel==='trial';const lock=await acquireDirectoryLock(this.options.directory,'update.lock',this.controller.signal);try{await this.save(this.runningReceipt(),this.receipt,g);}finally{await lock();}}
  if(!this.current(g))return;this.set(this.pending?(this.installedBuild===this.pending.release.build_id?'installed':'ready'):'idle',this.pending?(this.installedBuild===this.pending.release.build_id?`${this.pending.release.version} 已安装，等待生效。`:`已下载 ${this.pending.release.version}，待安装。`):this.available?`发现正式版 ${this.available.version}。`:'当前没有需要安装的正式更新。');
 }catch(reason){if(this.current(g))this.set(this.pending?(this.installedBuild===this.pending.release.build_id?'installed':'ready'):'failed',this.pending?(this.installedBuild===this.pending.release.build_id?'检查失败，已安装的更新仍等待生效。':'检查失败，已下载的安装包仍可使用。'):`更新检查暂不可用（${reason instanceof PluginHttpError?pluginFailureHint(reason):'本机更新缓存或状态不可用'}），请稍后重试。`);}finally{if(this.current(g)){this.busy=false;this.emit();}}}
 async prepare(channel:'stable'|'trial'){
  if(this.busy||!this.origin||this.disposed)return;const g=this.generation;this.busy=true;try{
   await this.load(g);const candidate=await this.metadata(channel==='stable'?'/api/v1/plugin-releases/current':'/api/v1/plugin-releases/trial',g,channel==='trial');
   if(!candidate||candidate.channel!==channel)throw new Error('release_unavailable');if(!this.needs(candidate)){this.set('idle',compare(candidate.version,this.options.currentVersion)<0?'目标版本低于当前运行版本，不执行降级。':'当前已经运行该构建。');return;}
   if(this.pending?.release.build_id===candidate.build_id&&this.pending.release.sha256===candidate.sha256){const lock=await acquireDirectoryLock(this.options.directory,'update.lock',this.controller.signal);try{const installed=await this.checkOrder(candidate);if(!this.current(g))return;this.installedBuild=await this.installedIdentity(installed);this.pending.release=candidate;this.pending.user_id=channel==='trial'?this.userId:'';await this.save('pending.json',this.pending,g);}finally{await lock();}if(!this.current(g))return;this.set(this.installedBuild===candidate.build_id?'installed':'ready',this.installedBuild===candidate.build_id?`${candidate.version} 已安装，等待生效。`:`已下载 ${candidate.version}，待安装。`);return;}
   this.set('downloading',`正在下载 ${candidate.version}${channel==='trial'?' 试用包':''}…`);
   const response=await platformRequest(this.origin,candidate.download_path,this.controller.signal,{binary:true,maxBytes:PLUGIN_RELEASE_MAX_BYTES,timeout:pluginTimeouts.releaseDownload,...(channel==='trial'?{headers:{Authorization:`Bearer ${this.token}`}}:{})});
   if(!this.current(g))return;const bytes=response.data;if(!Buffer.isBuffer(bytes)||bytes.length!==candidate.bytes||hash(bytes)!==candidate.sha256)throw new Error('package_integrity');
   const release=await acquireDirectoryLock(this.options.directory,'update.lock',this.controller.signal);try{
    const installed=await this.checkOrder(candidate);if(!this.current(g))return;this.installedBuild=await this.installedIdentity(installed);const target=this.file(candidate.build_id);const previous=await lstat(target).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(previous&&(!previous.isFile()||previous.isSymbolicLink()))throw new Error('unsafe_update_file');
    const temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});if(!this.current(g))return;await rename(temp,target);}finally{await unlink(temp).catch(()=>{});}
    const previousBuild=this.pending?.release.build_id;this.pending={origin:this.origin,release:candidate,user_id:channel==='trial'?this.userId:''};await this.save('pending.json',this.pending,g);if(!this.current(g))return;if(previousBuild&&previousBuild!==candidate.build_id)await unlink(this.file(previousBuild)).catch(()=>{});if(!this.current(g))return;this.set('ready',`${candidate.version} 已下载并校验，待安装。`);
   }finally{await release();}
  }catch{if(this.current(g))this.set('failed','更新包获取或校验失败，当前运行版本保持不变。');}finally{if(this.current(g)){this.busy=false;this.emit();}}
 }
 async installPrepared(channel?:'stable',retry=false){if(this.busy||!this.origin||this.disposed)return;const g=this.generation;this.busy=true;try{
  // An explicit retry repairs external reinstalls; automatic checks still share the install receipt.
  await this.load(g);const pending=this.pending;if(!pending||channel&&pending.release.channel!==channel||!retry&&this.installedBuild===pending.release.build_id)return;
  if(pending.release.channel==='trial'){if(!this.token||pending.user_id!==this.userId)throw new Error('trial_owner_changed');const latest=await this.metadata('/api/v1/plugin-releases/trial',g,true).catch(()=>null);if(!latest||latest.build_id!==pending.release.build_id||latest.sha256!==pending.release.sha256){const formal=await this.metadata(`/api/v1/plugin-releases/builds/${pending.release.build_id}`,g).catch(()=>null);if(!formal||formal.channel!=='stable'||formal.build_id!==pending.release.build_id||formal.sha256!==pending.release.sha256)throw new Error('trial_changed');pending.release=formal;pending.user_id='';}}
  const lock=await acquireDirectoryLock(this.options.directory,'update.lock',this.controller.signal);try{
   const installed=await this.checkOrder(pending.release);if(!this.current(g))return;if(!retry&&installed?.build_id===pending.release.build_id&&await this.installedIdentity(installed)===installed.build_id){this.installedBuild=installed.build_id;this.set('installed',`${pending.release.version} 已安装，等待生效。`);return;}
   const shared=await this.json('pending.json') as Partial<Cached>|undefined;const latest=decodePluginRelease(shared?.release);if(shared?.origin!==pending.origin||latest?.build_id!==pending.release.build_id||latest.sha256!==pending.release.sha256)throw new Error('update_superseded');
   const file=this.file(pending.release.build_id),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==pending.release.bytes)throw new Error('package_integrity');const bytes=await readFile(file);if(hash(bytes)!==pending.release.sha256)throw new Error('package_integrity');
   if(!this.current(g))return;await this.save('pending.json',pending,g);this.set('installing','正在安装更新，当前仍运行原构建…');await this.options.install(file);
   if(this.options.isInstalled&&!await this.options.isInstalled(pending.release))throw new Error('installation_not_confirmed');
   // The SDK side effect has completed even if the account/site changed while awaiting it.
   await this.save('installed.json',pending.release);if(!this.current(g))return;this.installedBuild=pending.release.build_id;this.set('installed',`${pending.release.version} 已安装，重新加载扩展或下次启动后生效。`);
  }finally{await lock();}
 }catch(e){if(this.current(g))this.set(e instanceof Error&&e.message==='update_cancelled'?'ready':'failed',e instanceof Error&&e.message==='update_cancelled'?'已取消安装，更新包仍保留；可稍后再试。':'更新安装未完成，当前运行版本保持不变；可重试或手工安装修复包。');}finally{if(this.current(g)){this.busy=false;this.emit();}}}
 dispose(){this.disposed=true;this.generation++;this.controller.abort();}
}
