import type {HookStatus} from './hook-setup.js';

interface CollectionInput {
  local:boolean;remote:boolean;origin:string;bound:boolean;validated:boolean;enabled:boolean;
  runtimeAllowed:boolean;trusted:boolean;gitState:string;hook:HookStatus|undefined;
  guideConfirmed:boolean;canConfirm:boolean;remoteAvailable:boolean;remoteError:string;
  transport:'idle'|'accepted'|'failed';error:string;stale:boolean;
}

/** Keeps semantic collection status separate from the text displayed by the adapter. */
export function collectionPresentation(s:CollectionInput){
  const badge=!s.local?'本机界面不可用':s.error?'需要处理':!s.origin?'待配置':!s.bound?'待登录':!s.validated?'验证连接中':s.remote&&!s.remoteAvailable?'远端待接入':s.remoteError?'远端需处理':!s.enabled||s.validated&&!s.runtimeAllowed?'已暂停':s.hook?.state==='failed'?'Hook需修复':s.hook&&['checking','downloading'].includes(s.hook.state)?'Hook配置中':s.canConfirm&&!s.guideConfirmed?'Hook待验证':s.stale?'离线旧数据':'已接入';
  const setting=(s.guideConfirmed?'启用设置已确认 · 运行待验证':'启用设置待确认 · 运行待验证')+(s.remote&&s.transport==='failed'?' · 最近转发失败，未补传':s.remote&&s.transport==='accepted'?' · 转发请求已结束，保存待核对':'');
  const fallback=!s.local?'本机界面不可用':!s.origin?'等待配置平台地址':!s.bound?'等待登录':!s.validated?'等待平台连接验证':!s.enabled?'本机采集已暂停':!s.runtimeAllowed?'等待本机运行控制恢复':'等待安装检查';
  const hook=s.hook?({checking:'检查中',downloading:'下载中',ready:`文件就绪 · ${setting}`,installed:`文件已安装 · ${setting}`,failed:s.hook.reason==='remote_hook_window_conflict'?'同一远端项目存在多个窗口，Hook已暂停；请仅保留一个窗口':s.hook.reason==='powershell_execution_policy'?'Windows 执行策略阻止安装，请联系管理员确认':s.hook.reason==='hook_installation_timeout'?'Hook 安装超时，请稍后重试':`安装未完成 (${s.hook.reason??'failed'})`}[s.hook.state]):fallback;
  const git=!s.bound||!s.validated?'未认证':!s.enabled||!s.runtimeAllowed?(s.remote?'远端已暂停':'本机已暂停'):!s.trusted?'待工作区信任':s.gitState==='active'?'观测运行中':s.gitState==='retrying'?'等待重试':s.gitState==='unavailable'?'暂不可用':'正在连接';
  return {badge,git,hook,hookPhase:s.hook?.state??'pending'};
}

interface VerificationInput {
  canPass?:boolean;readOnly?:boolean;finalizing?:boolean;
  checks?:{hook?:boolean;account?:boolean};confirmed?:{global?:boolean;local?:boolean;session?:boolean};
}
interface ControlsInput {
  hookPhase?:HookStatus['state']|'pending';remoteError?:string;
  verification?:VerificationInput|null;
  recovery?:{busy?:boolean;blocked?:boolean}|null;
  updates?:{phase?:string};remoteSetup?:{phase?:string;canRetry?:boolean}|null;
}

/** Self-contained so the same decision function runs in tests and the nonce-protected Webview. */
export function overviewControls(s:ControlsInput){
  const v=s.verification,r=s.recovery,u=s.updates;
  const updating=['checking','downloading','installing'].includes(u?.phase??'');
  const disabled:Record<string,boolean>={
    'verification-start':!!v?.finalizing,
    'verification-check':false,
    'verification-pass':!v?.canPass||!!v?.readOnly,
    'verification-fail':!!v?.readOnly,
    'verification-platform':false,
    repair:!!r?.blocked,authorize:false,'confirm-guide':false,
    'update-check':updating,'update-apply':updating,'update-trial':updating,
    recovery:!!r?.busy,
    'remote-install':s.remoteSetup?.phase==='installing','remote-check':!s.remoteSetup?.canRetry,
  };
  for(const key of ['global','local','session'] as const){
    disabled['verification-'+key]=!!v?.readOnly||!v?.checks?.hook||!v?.checks?.account||!!v?.confirmed?.[key]||key==='session'&&(!v?.confirmed?.global||!v?.confirmed?.local);
  }
  if(r?.busy)for(const op of ['verification-start','verification-check','verification-pass','verification-fail','verification-global','verification-local','verification-platform','verification-session','repair','authorize','confirm-guide','update-apply','update-trial'])disabled[op]=true;
  const hookBrief=s.hookPhase==='ready'||s.hookPhase==='installed'?'文件就绪':s.hookPhase==='failed'?'需处理':s.hookPhase==='checking'?'检查中':s.hookPhase==='downloading'?'下载中':'等待检查';
  return {disabled,hookBrief,attention:hookBrief==='需处理'||!!s.remoteError||!!r?.blocked};
}
