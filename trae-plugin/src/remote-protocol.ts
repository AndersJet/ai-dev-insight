/** JSON-only messages carried by the IDE's existing SSH command channel. */
export const REMOTE_COMMAND='_adi.remote.runtime.v1';
export const FORWARD_COMMAND='_adi.local.hook.v1';
export const REMOTE_PROTOCOL=1;
export interface RemoteSession {protocol:1;session:string;owner:string;client:string;build:string}
export interface RemoteInfo {protocol:1;instance:string;platform:'linux';build:string;roots:string[];hook_conflict?:boolean}
export interface RemotePermit {op:'permit';session:string;instance:string;event_id:string}
export interface RemoteHook {permit:string;session:string;instance:string;event_id:string;occurred_at:string;payload:string;workspace:string|null;probe:(import('./collector.js').ProbeResult&{observed_at:string})|null}
export type VerifiedRemoteHook=Omit<RemoteHook,'payload'>&{payload:Record<string,unknown>;raw:string};
export const hookEvents=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'];
export function validHook(value:unknown):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(typeof v.session_id!=='string'||!v.session_id.trim()||v.session_id.length>256||!hookEvents.includes(String(v.hook_event_name)))return false;
  return boundedHookTree(value,19900,31);
}
export function boundedHookTree(value:unknown,maxNodes=20000,maxDepth=32){
  const pending=[{value,depth:0}];let count=0;
  while(pending.length){const item=pending.pop()!;if(++count>maxNodes||item.depth>maxDepth||Array.isArray(item.value)&&item.value.length>2048)return false;if(item.value&&typeof item.value==='object')for(const child of Object.values(item.value)){if(count+pending.length>maxNodes)return false;pending.push({value:child,depth:item.depth+1});}}
  return true;
}
export async function boundedCommand<T>(call:PromiseLike<T>,ms:number,signal?:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{const finish=(error?:Error,result?:T)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result!);};const abort=()=>finish(new Error('remote_cancelled'));const timer=setTimeout(()=>finish(new Error('remote_unavailable')),ms);timer.unref();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else Promise.resolve(call).then(value=>finish(undefined,value),error=>finish(new Error(error instanceof Error&&['managed_hooks_modified','managed_hook_files_modified','unsupported_hooks_configuration','orphaned_managed_hooks','remote_workspace_untrusted','remote_workspace_missing','remote_lease_expired'].includes(error.message)?error.message:'remote_unavailable')));});
}

export function remoteFailureHint(error:unknown){
  const code=error instanceof Error?error.message:'';
  const messages:Record<string,string>={managed_hooks_modified:'远端受管 Hook 被人工修改，已保留原配置，请核对后重试。',managed_hook_files_modified:'远端受管采集文件被修改，已停止覆盖，请核对后重试。',unsupported_hooks_configuration:'远端 Hook 配置格式不受支持，已保留原文件。',orphaned_managed_hooks:'远端受管 Hook 安装记录缺失，已保留现场，请检查原配置。',remote_workspace_untrusted:'远端工作区尚未受信任，采集未启动。',remote_workspace_missing:'请先打开远端工作区。'};
  return messages[code]??'远端助手未连接或构建不匹配，采集已停止。请运行“ADI: 安装配套 Remote SSH 助手”，连接恢复后会重新验证授权。';
}
