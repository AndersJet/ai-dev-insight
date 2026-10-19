import {boundedCommand,REMOTE_COMMAND,REMOTE_PROTOCOL} from './remote-protocol.js';
export type RemoteSetupPhase='checking'|'missing'|'mismatch'|'installing'|'reconnect'|'ready'|'failed'|'unsupported';
export interface RemoteSetupStatus {phase:RemoteSetupPhase;message:string;canInstall:boolean;canRetry:boolean}
interface Host {build:string;remoteName?:string;execute<T>(command:string,input:unknown):PromiseLike<T>;install():PromiseLike<unknown>;onChange():void}
/** Availability is independent of platform login and never starts collection. */
export class RemoteSetup {
 private phase:RemoteSetupPhase='checking';private hookConflict=false;private disposed=false;private checking:Promise<void>|undefined;private installing:Promise<void>|undefined;
 constructor(private readonly host:Host){}
 snapshot():RemoteSetupStatus{
  const messages:Record<RemoteSetupPhase,string>={checking:'正在检查当前 SSH 工作区助手…',missing:'尚未连接到远端助手。首次使用请安装；已安装时可检查 SSH 连接后重新检查。',mismatch:'远端助手与主插件不配套，请安装主插件内置的配套助手。',installing:'正在把主插件内置的配套助手安装到当前 SSH 远端…',reconnect:'助手包已安装，但当前 SSH 窗口尚未连接到配套助手。请保存工作后重新连接此 SSH 窗口，再点击重新检查；可能需要再次认证。',ready:'配套助手已连接。登录平台并等待 Hook 文件就绪后，按下方步骤启用采集。',failed:'助手安装未完成，请确认 SSH 已连接后重试。无需另行下载助手包。',unsupported:'当前连接类型或运行环境不受支持；目前仅支持 Linux Remote SSH 工作区。'};
  return {phase:this.phase,message:this.phase==='ready'&&this.hookConflict?'此远端项目存在多个窗口，无法确认 Hook 所属窗口，已暂停 Hook 转发。请仅保留一个窗口使用此目录；Git 观测可继续。':messages[this.phase],canInstall:['missing','mismatch','failed'].includes(this.phase),canRetry:!['checking','installing'].includes(this.phase)};
 }
 private set(phase:RemoteSetupPhase){if(!this.disposed){this.phase=phase;this.host.onChange();}}
 check(){if(this.installing)return this.installing;if(this.checking)return this.checking;this.checking=this.inspect(false).finally(()=>{this.checking=undefined;});return this.checking;}
 private async inspect(afterInstall:boolean){
  if(this.host.remoteName!==undefined&&this.host.remoteName!=='ssh-remote'){this.set('unsupported');return;}
  try{const info=await boundedCommand(this.host.execute<{protocol:number;platform:string;build:string;hook_conflict?:boolean}>(REMOTE_COMMAND,{op:'hello'}),1500);
   this.hookConflict=info?.hook_conflict===true;this.set(!info||info.protocol!==REMOTE_PROTOCOL?'mismatch':info.platform!=='linux'?'unsupported':info.build!==this.host.build?afterInstall||this.phase==='reconnect'?'reconnect':'mismatch':'ready');
  }catch{this.set(afterInstall||this.phase==='reconnect'?'reconnect':this.phase==='failed'?'failed':'missing');}
 }
 install(){
  if(this.host.remoteName!==undefined&&this.host.remoteName!=='ssh-remote'){this.set('unsupported');return Promise.resolve();}
  if(this.installing)return this.installing;
  this.installing=(async()=>{await this.checking;if(this.disposed)return;this.set('installing');try{await this.host.install();if(!this.disposed)await this.inspect(true);}catch{this.set('failed');}})().finally(()=>{this.installing=undefined;});return this.installing;
 }
 available(){return this.phase==='ready';}
 dispose(){this.disposed=true;}
}
