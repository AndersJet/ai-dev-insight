import {openTokenAnalysis} from './analysis-panel.js';
import {createHash} from 'node:crypto';
import {CollectionLifecycle} from './collection-lifecycle.js';
import {collectionPresentation} from './overview-state.js';
import {RemoteSetup} from './remote-setup.js';
import {RemoteClient} from './remote-client.js';
import {FORWARD_COMMAND,boundedHookTree,remoteFailureHint,type VerifiedRemoteHook} from './remote-protocol.js';
import {pluginRequest} from './http-client.js';
import {decodePluginRelease,jsonBudgetFailure} from '@adi/contracts';
import {WorkspaceInstallationVerification,verificationWorkspace} from './installation-verification.js';
import {verificationEnvironment} from './verification-environment.js';
import {diagnosticOperation} from './diagnostics.js';
import {PluginUpdater} from './updater.js';
import {isPluginBuildInstalled} from './installed-build.js';
import * as vscode from 'vscode';
import {join} from 'node:path';import {homedir} from 'node:os';
import {ProjectCollector,type CollectorConfig} from './collector.js';import {PluginState} from './state.js';import {probeProject} from './git-probe.js';
import {platformRequest,normalizeWebUrl,PlatformSession,type PluginCredential,type LoginUser} from './platform-session.js';
import {PluginHttpError,pluginFailureHint} from './http-client.js';import {RuntimeControl,runtimeOwner} from './runtime-control.js';import {ensureHook,prepareHook,type HookStatus} from './hook-setup.js';
import {CollectionRecovery,recoveryMessage,type RecoveryRecord} from './collection-recovery.js';
import {TodayOverview} from './today-overview.js';import {overviewHtml} from './overview-ui.js';
import {acquireDirectoryLock} from './directory-lock.js';import {preparePrivateDirectory} from './private-files.js';
declare const __ADI_PLUGIN_DEFAULT_SERVER__:string;
declare const __ADI_PLUGIN_RELEASE_VERSION__:string;
declare const __ADI_PLUGIN_BUILD_ID__:string;
const CREDENTIAL='account-binding-v2';
const RUNTIME_CONTROL_ERROR='本机运行控制暂不可用，已暂停采集；可重新登录或检查权限。';
interface Binding extends PluginCredential {origin:string}
let shutdown:(()=>Promise<void>)|undefined;
export function activate(context:vscode.ExtensionContext){
  const remote=!!vscode.env.remoteName,local=['darwin','win32'].includes(process.platform);
  const target=remote?createHash('sha256').update(JSON.stringify([vscode.env.remoteName,[...new Set((vscode.workspace.workspaceFolders??[]).map(f=>f.uri.authority))].sort()])).digest('hex'):'';
  const state=new PluginState(remote?join(context.globalStorageUri.fsPath,'remote',target):context.globalStorageUri.fsPath,context.secrets);
  let remoteTransport:'idle'|'accepted'|'failed'='idle';
  let remoteSource:{collector_id:string;source_config_id:string}|undefined;
  let remoteCredential:{installation_id:string;token:string}|undefined;
  const remoteClient=new RemoteClient({build:__ADI_PLUGIN_BUILD_ID__,execute:(command,input)=>vscode.commands.executeCommand(command,input),forward:forwardRemoteHook});
  const remoteSetup=remote?new RemoteSetup({build:__ADI_PLUGIN_BUILD_ID__,remoteName:vscode.env.remoteName??'',execute:(command,input)=>vscode.commands.executeCommand(command,input),install:()=>vscode.commands.executeCommand('workbench.extensions.installExtension',vscode.Uri.file(join(context.extensionPath,'dist','remote-workspace.vsix'))),onChange:post}):undefined;
  let remoteError='';
  const localRuntime=new RuntimeControl(join(homedir(),'.trae-cn','adi-plugin-control')),runtime=remote?remoteClient:localRuntime,today=new TodayOverview(context.globalState);
  const lifecycle=new CollectionLifecycle(()=>readOrigin(),()=>readEnabled());
  let analysisWindow:{panel:vscode.WebviewPanel;binding:Binding}|undefined;
  let view:vscode.WebviewView|undefined,busy=false,error='',authPending=false;
  let session:PlatformSession|undefined,user:LoginUser|undefined,hook:HookStatus|undefined,installedOwner='',hookWork:Promise<void>|undefined;
  let poll:NodeJS.Timeout|undefined;
  let overviewRefresh:{generation:number;work:Promise<void>}|undefined;
  let credentialWrites:Promise<unknown>=Promise.resolve();
  const currentVerificationWorkspace=()=>verificationWorkspace(vscode.env.remoteName??'',(vscode.workspace.workspaceFolders??[]).map(folder=>folder.uri.toString()),vscode.workspace.workspaceFile?.toString()??'',vscode.workspace.name??'');
  const verification=new WorkspaceInstallationVerification({directory:context.globalStorageUri.fsPath,control:join(homedir(),'.trae-cn','adi-plugin-control'),environment:()=>verificationEnvironment(vscode.env.appRoot??'',vscode.version??'unknown',__ADI_PLUGIN_RELEASE_VERSION__,__ADI_PLUGIN_BUILD_ID__),onChange:post},currentVerificationWorkspace);
  const verificationChecking=new Set<string>();
  const recovery=new CollectionRecovery({profile:join(homedir(),'.trae-cn'),platform:process.platform==='win32'?'win32':'darwin'});
  let recoveryRecord:RecoveryRecord|undefined,recoveryWork:Promise<void>|undefined,recoveryAbort:AbortController|undefined,recoveryRunning=false,recoveryBlocked=false,recoveryPeerBusy=false,recoveryNotice='',recoveryRestart=false;
  const credentialDirectory=join(homedir(),'.trae-cn','adi-plugin-control');
  function current(active:Binding,generation:number){
    return lifecycle.current(active,generation);
  }
  function sameBinding(a:Binding|undefined,b:Binding){return !!a&&a.user_id===b.user_id&&a.api_token===b.api_token&&a.origin===b.origin&&a.email===b.email;}
  function writeCredential<T>(work:()=>Promise<T>):Promise<T>{
    const next=credentialWrites.catch(()=>{}).then(async()=>{
      await preparePrivateDirectory(credentialDirectory);const release=await acquireDirectoryLock(credentialDirectory,'credential.lock');
      try{return await work();}finally{await release();}
    });credentialWrites=next;return next;
  }
  async function forgetBinding(expected:Binding|undefined,allowed:()=>boolean){
    if(!expected)return false;
    return writeCredential(async()=>{if(!allowed())return false;const saved=await readBinding();if(!allowed()||!sameBinding(saved,expected))return false;await context.secrets.delete(CREDENTIAL);return true;});
  }
  const statusbar=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,70);statusbar.command='adiProjectTracker.open';statusbar.show();
  const rootSettings=()=>vscode.workspace.getConfiguration('adiProjectTracker');
  const readOrigin=()=>{const input=rootSettings().inspect<string>('webUrl')?.globalValue;const value=typeof input==='string'?input:__ADI_PLUGIN_DEFAULT_SERVER__;return value.trim()?normalizeWebUrl(value):'';};
  const readEnabled=()=>rootSettings().inspect<boolean>('enabled')?.globalValue!==false;
  const updater=new PluginUpdater({directory:join(context.globalStorageUri.fsPath,'updates'),currentVersion:__ADI_PLUGIN_RELEASE_VERSION__,currentBuild:__ADI_PLUGIN_BUILD_ID__,isInstalled:release=>isPluginBuildInstalled(context.extensionPath,release),install:async path=>{const key=updateKey;if(vscode.workspace.getConfiguration('extensions').get<boolean>('autoRestart')===true){const answer=await vscode.window.showWarningMessage('Trae 已开启扩展自动重启，继续安装可能重新加载扩展。请先保存当前工作。',{modal:true},'继续安装');if(answer!=='继续安装')throw new Error('update_cancelled');}if(lifecycle.disposed||key!==updateKey||readOrigin()!==lifecycle.origin)throw new Error('superseded');await vscode.commands.executeCommand('workbench.extensions.installExtension',vscode.Uri.file(path));},onChange:post});
  let updateKey='',updateFirst=true;
  async function refreshUpdates(startup=false){const key=updateKey;if(!local||!lifecycle.origin||lifecycle.disposed)return;await updater.restore();if(key!==updateKey||lifecycle.disposed||readOrigin()!==lifecycle.origin)return;if(startup&&updater.snapshot().phase==='ready'&&vscode.workspace.getConfiguration('extensions').get<boolean>('autoRestart')!==true)await updater.installPrepared('stable');await updater.check();if(key!==updateKey||lifecycle.disposed||readOrigin()!==lifecycle.origin)return;if(updater.snapshot().available){await updater.prepare('stable');if(key===updateKey&&readOrigin()===lifecycle.origin&&vscode.workspace.getConfiguration('extensions').get<boolean>('autoRestart')!==true)await updater.installPrepared('stable');}post();}
  function configureUpdates(){const key=JSON.stringify([lifecycle.origin,lifecycle.binding?.user_id,lifecycle.binding?.api_token]);if(key===updateKey)return;updateKey=key;updater.configure(lifecycle.origin,lifecycle.binding?.api_token,lifecycle.binding?.user_id);const startup=updateFirst;updateFirst=false;void refreshUpdates(startup);}
  async function collectionRequest<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
    if(remote){if(signal.aborted||!lifecycle.permits(local,true)||!readEnabled())throw new Error('collection_paused');return work();}
    const check=async()=>{
      const record=await recovery.status();
      if(await recovery.busy()||(record&&record.phase!=='completed')||record?.id!==recoveryRecord?.id){
        lifecycle.pause();collection();void synchronize();throw new Error('collection_paused');
      }
      if(signal.aborted||!lifecycle.permits(local,true)||!readEnabled())throw new Error('collection_paused');
    };
    await check();await preparePrivateDirectory(recovery.directory);const release=await acquireDirectoryLock(recovery.directory,'collection.lock',signal,3000);
    try{await check();return await work();}finally{await release();}
  }
  const collector=new ProjectCollector({
    identity:(config,signal)=>state.identity(config,signal),nextSequence:(signal,sourceConfigId)=>state.nextSequence(signal,sourceConfigId),platform:remote?'linux':process.platform==='win32'?'windows':'macos',version:__ADI_PLUGIN_RELEASE_VERSION__,
    probe:async(workspace,signal)=>{if(remote)return remoteClient.probe(workspace,signal);const configured=vscode.workspace.getConfiguration('git').inspect<string|string[]>('path')?.globalValue;return probeProject(workspace,signal,typeof configured==='string'?configured:Array.isArray(configured)?configured[0]??'git':'git');},
    register:async(input,url,signal)=>collectionRequest(signal,async()=>{
      const active=lifecycle.binding;if(!active||!lifecycle.validated||active.origin!==url)throw new PluginHttpError(401,'plugin_unauthorized');
      const {source_secret,source_config_id,platform,plugin_version}=input;
      const issued=(await platformRequest(url,'/api/v1/plugin/sources',signal,{method:'POST',body:{source_secret,source_config_id,platform,plugin_version},headers:{Authorization:`Bearer ${active.api_token}`}})).data as {collector_id:string;user_id:string;email:string};
      if(issued.user_id!==active.user_id||issued.email!==active.email||typeof issued.collector_id!=='string')throw new PluginHttpError(401,'plugin_unauthorized');
      if(remote)remoteSource={collector_id:issued.collector_id,source_config_id};
      return {collector_id:issued.collector_id,nt_email:issued.email,token:active.api_token};
    }),
    submit:async(input,token,url,signal)=>collectionRequest(signal,async()=>{const identity=await state.identity({ntEmail:input.nt_email,serverUrl:url},signal);if(identity.source_config_id!==input.source_config_id)throw new Error('source_identity_changed');const receipt=(await platformRequest(url,'/api/v1/plugin/observations',signal,{method:'POST',body:input,headers:{Authorization:`Bearer ${token}`,'X-ADI-Source-Secret':identity.source_secret}})).data as {outcome:'saved'|'duplicate';observation_id:string;received_at:string;cleanup_generation?:number};const previous=today.snapshot().data?.cleanup_generation;if(receipt.cleanup_generation!==undefined&&previous!==undefined&&receipt.cleanup_generation!==previous){await today.clear();if(view?.visible)void refreshToday();}return receipt;}),
    onAuthorizationRejected:reason=>{void authorizationRejected(reason);},onStatus:post,
  });
  async function forwardRemoteHook(event:VerifiedRemoteHook,signal:AbortSignal){
    const active=lifecycle.binding,generation=lifecycle.generation,credential=remoteCredential;
    if(!active||!credential||!lifecycle.permits(local,vscode.workspace.isTrusted)||!readEnabled()||!current(active,generation))throw new Error('remote_unauthorized');
    const config={ntEmail:active.email,serverUrl:active.origin},source=await state.identity(config,signal);
    const issued=remoteSource?.source_config_id===source.source_config_id?{...remoteSource,user_id:active.user_id,email:active.email}:(await platformRequest(active.origin,'/api/v1/plugin/sources',signal,{method:'POST',body:{...source,platform:'linux',plugin_version:__ADI_PLUGIN_RELEASE_VERSION__},headers:{Authorization:`Bearer ${active.api_token}`},timeout:400})).data as {collector_id:string;user_id:string;email:string};
    if(!current(active,generation)||issued.user_id!==active.user_id||issued.email!==active.email)throw new Error('remote_unauthorized');
    const probe=event.probe,sequence=probe?await state.nextSequence(signal,source.source_config_id):null;
    const project={collector_id:issued.collector_id,platform:'linux',workspace:event.workspace,unresolved_reason:event.workspace===null?'ambiguous_workspace':null,observation:probe&&sequence?{id:event.event_id,sequence,observed_at:probe.observed_at,state:probe.state,reason:probe.reason,git_root:probe.git_root,remotes:probe.remotes}:null};
    if(!current(active,generation)||signal.aborted)throw new Error('remote_cancelled');
    const metadata:Record<string,unknown>={schema_version:2,installation_id:credential.installation_id,client_event_id:event.event_id,occurred_at:event.occurred_at,timestamp_source:'client_observed',event_type:event.payload.hook_event_name,source_session_id:event.payload.session_id,project};
    if(!boundedHookTree({...metadata,payload:event.payload}))delete metadata.project;
    const encode=()=>JSON.stringify(metadata).slice(0,-1)+',"payload":'+event.raw+'}';
    let body=encode();if(jsonBudgetFailure(body,{wireBytes:1048576})){delete metadata.project;body=encode();if(jsonBudgetFailure(body,{wireBytes:1048576}))throw new Error('remote_event_budget');}
    try{const result=await pluginRequest(active.origin,'/hooks',body,credential.token,signal,300,true,true);if(current(active,generation)){remoteTransport='accepted';post();}return result;}catch(reason){if(current(active,generation)){remoteTransport='failed';post();}throw reason;}
  }
  const owner=()=>lifecycle.binding?runtimeOwner(lifecycle.binding.user_id,lifecycle.binding.origin):'';
  function canConfirmHook(){return lifecycle.permits(local,true)&&!!hook&&['ready','installed'].includes(hook.state);}
  function post(){
    if(synchronized&&!lifecycle.binding&&!authPending){authPending=true;void view?.webview.postMessage({type:'auth'});}
    if(synchronized)void verification.setScope(owner());
    verification.setCheck('account',!!lifecycle.binding&&lifecycle.validated);verification.setCheck('hook',canConfirmHook());
    if(remote&&remoteCredential&&lifecycle.runtimeAllowed)hook=remoteClient.hookStatus();
    const c=collector.status(),s=today.snapshot();
    const hookGuide={canConfirm:canConfirmHook(),confirmed:context.globalState.get<boolean>(remote?'remote-hook-guide-'+target:'hook-guide-completed-v2')===true};
    const presentation=collectionPresentation({local,remote,origin:lifecycle.origin,bound:!!lifecycle.binding,validated:lifecycle.validated,enabled:lifecycle.enabled,runtimeAllowed:lifecycle.runtimeAllowed,trusted:vscode.workspace.isTrusted,gitState:c.state,hook,guideConfirmed:hookGuide.confirmed,canConfirm:hookGuide.canConfirm,remoteAvailable:remoteSetup?.available()??true,remoteError,transport:remoteTransport,error,stale:s.stale});
    const {badge}=presentation;
    const chat=s.data?.official_chat_tokens;statusbar.text=badge==='已接入'?`ADI · Chat ${chat===null||chat===undefined?'—':Number(chat)>=1000?(Number(chat)/1000).toFixed(1)+'k':chat}`:`ADI · ${badge}`;
    statusbar.tooltip='AI Dev Insight · 点击查看本人今日概览';
    void view?.webview.postMessage({type:'state',state:{remote,remoteSetup:remoteSetup?.snapshot()??null,remoteError,updates:updater.snapshot(),origin:lifecycle.origin,email:lifecycle.binding?.email??'',busy,authPending,error,business_date:new Date(Date.now()+8*3600000).toISOString().slice(0,10),today:s,...presentation,hookGuide,profile:hook?.profile??'',saved:c.lastSavedAt,verification:verification.snapshot(),verificationWorkspace:verification.workspace,recovery:remote?null:{busy:!!recoveryWork||recoveryPeerBusy,blocked:recoveryBlocked,message:recoveryNotice,hasBackup:!!recoveryRecord,restartRequired:recoveryRestart}}});
  }
  function requestRuntimeResume(){lifecycle.requestResume();}
  function stopPoll(){if(poll)clearInterval(poll);poll=undefined;}
  function startPoll(){stopPoll();if(view?.visible&&lifecycle.binding){poll=setInterval(()=>void refreshToday(),60000);poll.unref();}}
  async function refreshToday(){
    if(!lifecycle.binding||!lifecycle.origin)return;if(overviewRefresh?.generation===lifecycle.generation)return overviewRefresh.work;
    const active=lifecycle.binding,generation=lifecycle.generation,verificationId=verification.snapshot()?.id,refresh={generation,work:Promise.resolve()};overviewRefresh=refresh;
    refresh.work=(async()=>{
    try{await today.refresh(runtimeOwner(active.user_id,active.origin),async()=>{const reply=await platformRequest(active.origin,'/api/v1/plugin/today',lifecycle.signal,{headers:{Authorization:`Bearer ${active.api_token}`}});if(!current(active,generation))throw new Error('superseded');return reply.data;});}
    catch(reason){if(!current(active,generation))return;if(reason instanceof PluginHttpError&&[401,403].includes(reason.status))await authorizationRejected(reason,active,generation);else if(reason instanceof PluginHttpError&&['collection_disabled','collection_closed','collection_unavailable','recovery_quarantined'].includes(reason.reason)){const stopped=await invalidate();if(!current(active,stopped))return;error='平台数据暂不可用，已停止采集；恢复后会重新验证。';}}
    finally{if(overviewRefresh===refresh)overviewRefresh=undefined;if(current(active,generation)&&verification.snapshot()?.id===verificationId)verification.setCheck('statistics',!!today.snapshot().data&&!today.snapshot().stale);post();}
    })();return refresh.work;
  }
  function collection(){
    const roots=remote?remoteClient.roots():local?(vscode.workspace.workspaceFolders??[]).filter(folder=>folder.uri.scheme==='file').map(folder=>folder.uri.fsPath):[];
    const config:CollectorConfig={ntEmail:lifecycle.binding?.email??'',serverUrl:lifecycle.origin};collector.configure(config,roots,lifecycle.permits(local,vscode.workspace.isTrusted,recoveryRunning||recoveryBlocked));
  }
  async function install(){
    const active=lifecycle.binding;if(!active||!lifecycle.permits(local,true,recoveryRunning||recoveryBlocked)||hookWork)return;const generation=lifecycle.generation;
    const hookComplete=diagnosticOperation('hook.install');
    const setup=remote?(async()=>{const {files}=await prepareHook(active.origin,active.api_token,runtimeOwner(active.user_id,active.origin),lifecycle.signal);if(!current(active,generation))throw new Error('superseded');remoteCredential=JSON.parse(Buffer.from(files['adi-installation.json']!).toString('utf8'));return remoteClient.hookStatus();})().catch(()=>({state:'failed',reason:'remote_hook_setup_failed',profile:'远端工作区'} as HookStatus)):ensureHook(active.origin,active.api_token,runtimeOwner(active.user_id,active.origin),context.globalStorageUri.fsPath,lifecycle.signal,status=>{if(generation===lifecycle.generation){hook=status;post();}});
    hookWork=setup.then(result=>{hookComplete(result.state==='failed'?new Error(result.reason):undefined);if(generation!==lifecycle.generation)return;if(result.state==='failed'&&result.reason==='hook_installation_busy'){hook={state:'checking',profile:result.profile};return;}hook=result;installedOwner=runtimeOwner(active.user_id,active.origin);if(result.state==='failed'){void vscode.window.showWarningMessage('ADI Hook 安装未完成，已认证的 Git 观测继续。请查看今日概览中的原因并重试。');}else if(result.state==='installed'&&!context.globalState.get('hook-guide-shown-v2')){void context.globalState.update('hook-guide-shown-v2',true);void action('guide');}}).finally(()=>{hookWork=undefined;post();});
    await hookWork;
  }
  async function stopRemoteCollection(){lifecycle.pause(true);installedOwner='';remoteCredential=undefined;remoteSource=undefined;remoteTransport='idle';hook=undefined;collector.configure({ntEmail:'',serverUrl:''},[],false);await remoteClient.stop(owner());}
  async function installRemoteHelper(){if(!remoteSetup||lifecycle.disposed)return;await stopRemoteCollection();requestRuntimeResume();await remoteSetup.install();if(lifecycle.disposed)return;if(remoteSetup.available())requestRuntimeResume();await synchronize();}
  async function repairHook(){
    const pending=hookWork;if(pending)await pending;installedOwner='';await synchronize();
    if(hookWork)await hookWork;else if(installedOwner!==owner())await install();post();
  }
  async function invalidate(preserveCache=false,identity?:{origin:string;binding:Binding|undefined}){
    const previous=owner(),generation=lifecycle.invalidate(identity);remoteCredential=undefined;remoteSource=undefined;remoteTransport='idle';remoteError='';installedOwner='';hook=undefined;session?.clear();session=undefined;user=undefined;authPending=false;stopPoll();collector.configure({ntEmail:'',serverUrl:''},[],false);await Promise.all([preserveCache?Promise.resolve():today.clear(),previous&&local?runtime.stop(previous).catch(()=>{error=RUNTIME_CONTROL_ERROR;}):Promise.resolve()]);return generation;
  }
  async function authorizationRejected(reason:unknown,active=lifecycle.binding,generation=lifecycle.generation){
    if(!active||!current(active,generation))return;
    try{
      const stopped=await invalidate();if(!current(active,stopped))return;
      if(reason instanceof PluginHttpError&&['plugin_account_unavailable','registration_required'].includes(reason.reason))error='平台账号暂不可用，已停止本机采集；账号恢复后会重新验证。';
      else {const removed=await forgetBinding(active,()=>current(active,stopped));if(!removed||!current(active,stopped))return;lifecycle.invalidate({origin:lifecycle.origin,binding:undefined});configureUpdates();error='平台已拒绝本机授权，请重新登录绑定。';}
      post();
    }catch{if(current(active,generation+1)){error='本机授权状态暂不可用，已暂停采集；请检查权限或重新登录。';post();}}
  }
  async function readBinding():Promise<Binding|undefined>{
    const raw=await context.secrets.get(CREDENTIAL);if(!raw)return;
    try{const value=JSON.parse(raw);if(normalizeWebUrl(value.origin)!==value.origin||!/^adi_api_v2\.[A-Za-z0-9_-]{43}$/.test(value.api_token)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.user_id)||typeof value.email!=='string')throw new Error('invalid_binding');return value;}catch{throw new Error('本机凭据状态异常，请重新登录。');}
  }
  let synchronized=false;
  function synchronize(){return lifecycle.synchronize(async()=>{
    if(lifecycle.disposed||recoveryRunning)return;
    if(!lifecycle.binding){try{const saved=await readBinding(),target=readOrigin();if(saved?.origin===target){lifecycle.invalidate({origin:target,binding:saved});}}catch{/* Normal synchronization reports invalid binding below. */}}
    try{const record=local&&!remote?await recovery.status():undefined;const wasBlocked=recoveryBlocked,previousRecoveryId=recoveryRecord?.id;recoveryBlocked=!!record&&record.phase!=='completed';recoveryRecord=record;recoveryPeerBusy=recoveryBlocked&&await recovery.busy();if(recoveryBlocked){recoveryNotice=recoveryPeerBusy?'本机环境正在修复或上次修复被中断，请在发起窗口查看。':'上次环境修复未完成，本机采集保持暂停；请重新修复或查看备份。';lifecycle.pause();collection();post();return;}if(record?.phase==='completed'&&record.owner===owner()&&(wasBlocked||previousRecoveryId!==record.id)){requestRuntimeResume();installedOwner='';recoveryNotice='其他窗口已完成环境修复。';}}catch{recoveryBlocked=true;lifecycle.pause();recoveryNotice='环境修复记录不可用，已暂停采集，请查看本机备份。';collection();post();return;}
    let target='';try{target=readOrigin();}catch{error='请在扩展设置中填写有效的 HTTP/HTTPS 平台根地址。';}
    const saved=await readBinding().catch(reason=>{error=reason.message;return undefined;});const changed=!lifecycle.matches(target,saved);
    if(changed){await invalidate(!synchronized&&!!target&&saved?.origin===target,{origin:target,binding:saved?.origin===target?saved:undefined});if(saved&&saved.origin!==lifecycle.origin)await forgetBinding(saved,()=>lifecycle.origin===target&&readOrigin()===target);if(lifecycle.origin)error='';}
    await verification.setScope(owner());configureUpdates();synchronized=true;lifecycle.updateEnabled();if(!local){error='界面插件需要运行在 macOS / Windows 本机。';post();return;}
    if(remoteSetup)await remoteSetup.check();
    if(lifecycle.binding&&!lifecycle.validated){const active=lifecycle.binding,generation=lifecycle.generation;try{const me=(await platformRequest(lifecycle.origin,'/api/v1/plugin/me',lifecycle.signal,{headers:{Authorization:`Bearer ${active.api_token}`}})).data as {user_id:string;email:string};if(generation!==lifecycle.generation)return;if(me.user_id!==active.user_id||me.email!==active.email)throw new PluginHttpError(401,'plugin_unauthorized');const latest=await readBinding();if(!current(active,generation))return;if(latest?.api_token!==active.api_token||latest.user_id!==active.user_id||latest.origin!==lifecycle.origin||readOrigin()!==lifecycle.origin){await invalidate(false,{origin:lifecycle.origin,binding:latest?.origin===lifecycle.origin?latest:undefined});post();return;}lifecycle.validate(active,generation);error='';void refreshToday();startPoll();}catch(reason){if(!current(active,generation))return;if(reason instanceof PluginHttpError&&[401,403].includes(reason.status)){await authorizationRejected(reason,active,generation);return;}error=`暂时无法验证平台连接，采集尚未启动（${pluginFailureHint(reason)}）。`;void refreshToday();}}
    if(lifecycle.binding&&lifecycle.validated){if(remoteSetup&&!remoteSetup.available()){if(lifecycle.runtimeAllowed){await stopRemoteCollection();requestRuntimeResume();}collection();post();return;}const active=lifecycle.binding,generation=lifecycle.generation;try{
      const accepted=await lifecycle.pulse(active,generation,{
        verify:async()=>{const verified=(await platformRequest(lifecycle.origin,'/api/v1/plugin/me',lifecycle.signal,{headers:{Authorization:`Bearer ${active.api_token}`}})).data as {user_id:string;email:string};return {...verified,binding:await readBinding()};},
        pulse:async(owner,enabled,resume,initializing)=>{const complete=enabled?diagnosticOperation(initializing?'runtime.initialize':'runtime.heartbeat',!initializing):()=>{};try{const allowed=await runtime.pulse(owner,enabled,{resume});complete(allowed?undefined:new Error('runtime_unavailable'));return allowed;}catch(reason){complete(reason);throw reason;}},
      });if(!accepted){collection();post();return;}if(error===RUNTIME_CONTROL_ERROR)error='';if(remote)remoteError='';
    }catch(reason){if(!current(active,generation))return;lifecycle.pause();if(reason instanceof PluginHttpError&&[401,403].includes(reason.status)){await authorizationRejected(reason,active,generation);return;}if(reason instanceof PluginHttpError&&['collection_disabled','collection_closed','collection_unavailable','recovery_quarantined'].includes(reason.reason)){const stopped=await invalidate();if(!current(active,stopped))return;error='平台数据暂不可用，已停止采集。';}else if(remote){await stopRemoteCollection();requestRuntimeResume();remoteError=remoteFailureHint(reason);}else error=RUNTIME_CONTROL_ERROR;}}
    collection();post();if(lifecycle.binding&&lifecycle.validated&&lifecycle.runtimeAllowed&&lifecycle.enabled&&installedOwner!==owner())void install();
  });}
  async function recoverCollection(){
    if(recoveryWork)return recoveryWork;
    recoveryAbort=new AbortController();const controller=recoveryAbort;
    recoveryWork=(async()=>{
      let completed=false;
      try{
        if(remote||!local||!lifecycle.binding||!lifecycle.origin)throw new Error('recovery_login_required');
        const active=lifecycle.binding,originalEnabled=readEnabled();let generation=lifecycle.generation;
        const unchanged=()=>current(active,generation)&&readEnabled()===originalEnabled&&!controller.signal.aborted;
        const verify=async()=>{
          const me=(await platformRequest(active.origin,'/api/v1/plugin/me',controller.signal,{headers:{Authorization:`Bearer ${active.api_token}`}})).data as {user_id:string;email:string};
          if(!unchanged()||!sameBinding(await readBinding(),active)||me.user_id!==active.user_id||me.email!==active.email)throw new Error('recovery_cancelled');
        };
        recoveryNotice='正在检查账号、下载材料和本机环境…';post();await verify();
        await verification.restore();if(verification.snapshot()?.result==='active'&&verification.snapshot()?.readOnly)throw new Error('verification_other_window');
        const prepared=await prepareHook(active.origin,active.api_token,owner(),controller.signal),plan=await recovery.plan(owner(),prepared,originalEnabled&&!lifecycle.runtimeAllowed);
        if(!unchanged())throw new Error('recovery_cancelled');
        recoveryNotice='检查完成，等待确认。';post();
        const answer=await vscode.window.showInformationMessage('修复采集环境',{modal:true,detail:plan.issues.map(v=>'• '+v).join('\n')+'\n\n将暂停本机采集，把 hooks.json、adi-native-collector 和 adi-plugin-control 移到私有备份，再使用已校验的本人安装包重新初始化。保留登录、平台地址、原采集开关及持久采集身份。' +(plan.resetAllHooks?'':'第三方 Hook 保留。')+'\n备份目录：'+recovery.directory},'确认修复');
        if(answer!=='确认修复'){recoveryNotice='已取消，采集配置保持不变。';return;}
        await verify();
        recoveryRunning=true;generation=lifecycle.beginRecovery();collection();
        await lifecycle.settled.catch(()=>{});if(hookWork)await hookWork;
        const result=await recovery.execute(plan,{
          signal:controller.signal,current:unchanged,
          pause:async()=>{lifecycle.pause();collection();await verification.finish('unconfirmed','environment_repair');},
          install:async(material,recordWrites)=>{const result=await ensureHook(active.origin,active.api_token,plan.owner,context.globalStorageUri.fsPath,controller.signal,status=>{hook=status;post();},{prepared:material,locked:true,recoverMissing:true,onInstalled:recordWrites});hook=result;recoveryRestart=!!result.restart_required;return result;},
          resume:async()=>{await verify();if(originalEnabled&&!await localRuntime.pulse(plan.owner,true,{resume:true,recovery:true}))throw new Error('runtime_unavailable');lifecycle.completeRecovery(active,generation,originalEnabled);},
          onChange:record=>{recoveryRecord=record;recoveryBlocked=record.phase!=='completed';recoveryNotice=record.phase==='running'?({pause:'正在备份并暂停本机采集…',install:'正在重新安装本人采集环境…',resume:'正在重新验证运行条件…'}[record.step]??'正在修复采集环境…'):record.phase==='completed'?'本机环境修复完成，真实会话仍需重新验证。':record.phase==='rollback_failed'?'修复及回滚未完成，本机采集保持暂停；请查看备份与日志。':'修复未完成，本机采集保持暂停；请查看备份或重新修复。'+recoveryMessage(record.code??'recovery_failed');post();},
        });
        completed=result.phase==='completed';if(!completed)recoveryRestart=false;if(completed){installedOwner=plan.owner;error='';}
      }catch(reason){
        recoveryNotice=reason instanceof Error&&reason.message==='recovery_login_required'?'请先登录并配置平台地址，再修复采集环境。':reason instanceof Error&&reason.message==='verification_other_window'?'请在启动安装验证的窗口执行环境修复。':reason instanceof PluginHttpError?'账号验证或安装材料下载未完成，未开始修改配置：'+pluginFailureHint(reason):recoveryMessage(reason instanceof Error?reason.message:'recovery_failed');
      }finally{
        recoveryRunning=false;recoveryAbort=undefined;
        if(completed){await synchronize();try{await verification.start(owner());await verification.setScope(owner());post();await verifyQueries();}catch{recoveryNotice+=' 自动安装验证未能启动，请点击“开始安装验证”。';}}
        collection();post();
      }
    })().finally(()=>{recoveryWork=undefined;post();});post();return recoveryWork;
  }
  async function finishLogin(){
    if(!session||!user)return;
    if(user.must_change_password){authPending=true;void view?.webview.postMessage({type:'stage',stage:'change'});return;}
    if(!user.registered){authPending=true;void view?.webview.postMessage({type:'stage',stage:'activate'});return;}
    const privateSession=session,loginUser=user,authOrigin=lifecycle.origin,generation=lifecycle.generation;const authCurrent=()=>{try{return !lifecycle.disposed&&lifecycle.generation===generation&&session===privateSession&&user===loginUser&&lifecycle.origin===authOrigin&&readOrigin()===authOrigin;}catch{return false;}};
    const issued=await privateSession.credential(lifecycle.signal);if(!authCurrent())return;if(!/^adi_api_v2\.[A-Za-z0-9_-]{43}$/.test(issued.api_token)||issued.user_id!==loginUser.user_id||issued.email!==loginUser.email)throw new Error('平台授权响应不一致');
    const active:Binding={...issued,origin:authOrigin};const stored=await writeCredential(async()=>{if(!authCurrent())return false;await context.secrets.store(CREDENTIAL,JSON.stringify(active));return true;});if(!stored||!authCurrent())return;await privateSession.close(lifecycle.signal).catch(()=>{});if(!authCurrent())return;session=undefined;user=undefined;authPending=false;collector.resumeAuthorization();requestRuntimeResume();installedOwner='';await synchronize();void install();void refreshToday();startPoll();
  }
  async function verifyHookFiles(){
    const workspace=verification.workspace.id;if(hookWork)await hookWork;if(lifecycle.disposed||workspace!==verification.workspace.id)return;hook={state:'checking',profile:hook?.profile??join(homedir(),'.trae-cn')};verification.resetHookVerification();post();await repairHook();
  }
  async function verifyQueries(){
    const snapshot=verification.snapshot();if(snapshot?.result!=='active'||!lifecycle.origin||verificationChecking.has(snapshot.id))return;const id=snapshot.id;verificationChecking.add(id);const active=lifecycle.binding,generation=lifecycle.generation;const checkCurrent=()=>generation===lifecycle.generation&&verification.snapshot()?.id===id;
    try{const signal=lifecycle.signal;try{const reply=await platformRequest(lifecycle.origin,'/api/v1/plugin-releases/current',signal);if(reply.data===null)verification.event('version.no_release');if(checkCurrent())verification.setCheck('version',reply.data===null||!!decodePluginRelease(reply.data));}catch{if(checkCurrent())verification.setCheck('version',false);}
      if(active&&current(active,generation)){await refreshToday();if(checkCurrent())verification.setCheck('statistics',!!today.snapshot().data&&!today.snapshot().stale);if(current(active,generation)){const summary=today.snapshot().data;if(summary)verification.event(summary.official_configured===false?'statistics.unconfigured':summary.official_chat_tokens===null?'statistics.no_data':summary.official_chat_tokens==='0'?'statistics.zero':'statistics.available');}}
    }finally{verificationChecking.delete(id);post();}
  }
  async function action(op:string,input:Record<string,string>={}){
    if(op!=='ready')verification.event('button.'+op);
    if(remote&&op.startsWith('recovery'))return;
    if(op==='recovery'){await recoverCollection();return;}
    if(op==='recovery-backups'||op==='recovery-log'){if(recoveryRecord)await vscode.env.openExternal(vscode.Uri.file(op==='recovery-backups'?recovery.paths(recoveryRecord).backup:recovery.paths(recoveryRecord).log));return;}
    if(op==='recovery-reload'){await vscode.commands.executeCommand('workbench.action.reloadWindow');return;}
    if(recoveryWork&&!['ready','settings','web','analysis','signout'].includes(op))return;
    if(op==='signout'&&recoveryWork){recoveryAbort?.abort();await recoveryWork;}
    if(op==='remote-install'){await installRemoteHelper();return;}
    if(op==='remote-check'){if(remoteSetup){await remoteSetup.check();if(remoteSetup.available())requestRuntimeResume();await synchronize();}return;}
    if(op==='verification-start'){const workspace=verification.workspace.id;await verification.start(owner());if(workspace!==verification.workspace.id)return;await verification.setScope(owner());await verifyHookFiles();await verifyQueries();post();return;}
    if(op==='verification-check'){const workspace=verification.workspace.id;await verification.restore();if(workspace!==verification.workspace.id)return;if(verification.snapshot()?.readOnly){post();return;}await verifyHookFiles();await verifyQueries();return;}
    if(op==='verification-global'||op==='verification-local'||op==='verification-session'){verification.confirm(op.slice(13) as 'global'|'local'|'session');return;}
    if(op==='verification-pass'||op==='verification-fail'){await verification.finish(op==='verification-pass'?'passed':'failed');const v=verification.snapshot();if(v?.result==='failed')void vscode.window.showInformationMessage('安装验证失败，调试日志：'+v.logPath);return;}
    if(op==='verification-folder'){await vscode.env.openExternal(vscode.Uri.file(verification.logDirectory));return;}
    if(op==='verification-platform'){if(lifecycle.origin)await vscode.env.openExternal(vscode.Uri.parse(lifecycle.origin+'/my/sessions'));return;}
    if(op==='update-check'){await refreshUpdates();return;}
    if(op==='update-trial'){await updater.prepare('trial');if(updater.snapshot().phase==='ready')await updater.installPrepared();post();return;}
    if(op==='update-apply'){await updater.installPrepared(undefined,true);if(updater.snapshot().phase==='installed'){const answer=await vscode.window.showInformationMessage('新构建已安装，重新加载扩展或下次正常启动后生效。','重新加载扩展','稍后');if(answer==='重新加载扩展')await vscode.commands.executeCommand('workbench.action.restartExtensionHost');}post();return;}
    if(op==='ready'){void verification.restore().then(post);post();if(lifecycle.binding)void refreshToday();return;}if(op==='settings'){await vscode.commands.executeCommand('workbench.action.openSettings','@ext:ai-dev-insight.adi-project-tracker');return;}
    if(op==='analysis'){const binding=lifecycle.binding;if(!binding||!lifecycle.validated)throw new Error('请先登录绑定平台');if(analysisWindow&&sameBinding(analysisWindow.binding,binding)){analysisWindow.panel.reveal(vscode.ViewColumn.Active);return;}analysisWindow?.panel.dispose();const panel=openTokenAnalysis(vscode,binding,()=>!lifecycle.disposed&&readOrigin()===binding.origin&&sameBinding(lifecycle.binding,binding));analysisWindow={panel,binding};context.subscriptions.push(panel,panel.onDidDispose(()=>{if(analysisWindow?.panel===panel)analysisWindow=undefined;}));return;}
    if(op==='web'){if(lifecycle.origin)await vscode.env.openExternal(vscode.Uri.parse(lifecycle.origin+'/'));return;}
    if(op==='authorize'){authPending=true;void view?.webview.postMessage({type:'auth',email:lifecycle.binding?.email??''});post();return;}
    if(op==='signout'){updater.configure(lifecycle.origin);updateKey='signing-out';const active=lifecycle.binding,stopped=await invalidate();await forgetBinding(active,()=>!lifecycle.disposed&&lifecycle.generation===stopped&&lifecycle.binding===active);if(lifecycle.generation===stopped&&lifecycle.binding===active){lifecycle.invalidate({origin:lifecycle.origin,binding:undefined});error='';configureUpdates();post();}return;}
    if(op==='confirm-guide'){if(canConfirmHook())await context.globalState.update(remote?'remote-hook-guide-'+target:'hook-guide-completed-v2',true);post();return;}
    if(op==='guide'){
      const detail=remote?'远端 Hook 已写入当前工作区的 .trae/hooks.json。请在 Trae 的 Hooks 设置中选择“项目”，开启已配置的 Hooks，并确认当前远端运行方式允许执行。首次启用可能需要重载专用窗口。文件就绪、启用确认与平台实际保存分别验证。':'1. 打开 Trae 自身的设置，选择左侧 Hooks（不是 VS Code 的扩展设置）。\n2. 在“配置”中选择“全局”，开启“已配置的 Hooks”。\n3. 在“运行方式”中选择“本地自动运行”。\n4. 按 Trae 提示自行重启后，新建对话并在 Hooks 的“查看日志”中检查 Agent Hooks 日志。\n\n若这些设置已完成，直接点击“确认已完成启用设置”。插件不能直接读取 Trae 的 Hooks 开关；确认只记录你已完成设置，不证明本机事件已被执行或保存。';
      const response=await vscode.window.showInformationMessage('Trae 全局 Hooks 启用步骤',{modal:true,detail},...(canConfirmHook()?['确认已完成启用设置']:[]));
      if(response==='确认已完成启用设置')await action('confirm-guide');return;
    }
    if(op==='refresh'){await refreshToday();await verifyQueries();return;}if(op==='repair'){await repairHook();await verifyQueries();return;}
    if(!lifecycle.origin)throw new Error('请先在扩展设置中填写平台地址。');
    if(op==='departments'){const setup=await new PlatformSession(lifecycle.origin).setup(lifecycle.signal);void view?.webview.postMessage({type:'departments',departments:setup.departments});return;}
    if(busy)return;busy=true;error='';post();
    try{
      if(op==='login'||op==='register'){
        session?.clear();session=new PlatformSession(lifecycle.origin);user=undefined;
        if(op==='register')await session.register({email:input.email??'',password:input.password??'',display_name:input.display_name??'',department_id:input.department_id??''},lifecycle.signal);
        user=await session.login(input.email??'',input.password??'',lifecycle.signal);await finishLogin();
      }else if(op==='change'&&session){user=await session.changePassword(input.password??'',input.new_password??'',lifecycle.signal);await finishLogin();}
      else if(op==='activate'&&session){await session.activate(input.department_id??'',lifecycle.signal);user=await session.me(lifecycle.signal);await finishLogin();}
    }catch(reason){const messages:Record<string,string>={invalid_credentials:'邮箱或密码不正确',registration_not_allowed:'此邮箱已有账号，请选择登录',password_length:'密码长度应为12至128个字符',department_unavailable:'部门不可用，请重新选择',plugin_key_unavailable:'平台令牌密钥不可用，请联系管理员',plugin_unauthorized:'平台拒绝授权，请重新登录',request_failed:'平台暂时无法连接',request_timeout:'平台请求超时'};error=reason instanceof PluginHttpError?(messages[reason.reason]??`接入未完成 (${reason.reason})`):'接入未完成，请核对信息后重试。';}
    finally{busy=false;await verification.setScope(owner());await verifyQueries();post();}
  }
  const provider:vscode.WebviewViewProvider={resolveWebviewView(next){view=next;next.webview.options={enableScripts:true,localResourceRoots:[]};next.webview.html=overviewHtml();
    context.subscriptions.push(next.webview.onDidReceiveMessage(async(message:unknown)=>{if(!message||typeof message!=='object')return;const m=message as {op?:unknown;input?:unknown;workspace?:unknown};if(typeof m.op!=='string'||!['recovery','recovery-backups','recovery-log','recovery-reload','remote-install','remote-check','verification-start','verification-check','verification-global','verification-local','verification-session','verification-pass','verification-fail','verification-folder','verification-platform','ready','settings','web','analysis','authorize','update-check','update-trial','update-apply','signout','guide','confirm-guide','refresh','repair','departments','login','register','change','activate'].includes(m.op))return;if(m.op.startsWith('verification-')&&m.workspace!==undefined&&m.workspace!==verification.workspace.id){post();return;}const input:Record<string,string>={};if(m.input&&typeof m.input==='object')for(const key of ['email','password','display_name','department_id','new_password']){const value=(m.input as Record<string,unknown>)[key];if(typeof value==='string'&&value.length<=254)input[key]=value;}try{await action(m.op,input);}catch(reason){verification.event('action.failed',reason);error=reason instanceof Error&&reason.message==='verification_other_window'?'安装验证正在另一个 Trae 窗口中进行，请回到该窗口继续。':'操作未完成，请重试或查看扩展设置。';post();}}),next.onDidChangeVisibility(()=>{if(next.visible){startPoll();void refreshToday();void verification.restore().then(post);}else stopPoll();}));post();if(synchronized&&(!lifecycle.binding||authPending)){authPending=true;void next.webview.postMessage({type:'auth'});}if(next.visible)startPoll();}};
  context.subscriptions.push(vscode.commands.registerCommand(FORWARD_COMMAND,(input:unknown)=>remoteClient.receive(input)),statusbar,vscode.window.registerWebviewViewProvider('adiProjectTracker.overview',provider),vscode.commands.registerCommand('adiProjectTracker.open',()=>vscode.commands.executeCommand('adiProjectTracker.overview.focus')),vscode.commands.registerCommand('adiProjectTracker.authorize',()=>{void vscode.commands.executeCommand('adiProjectTracker.overview.focus');void action('authorize');}),vscode.commands.registerCommand('adiProjectTracker.installRemoteHelper',installRemoteHelper),vscode.commands.registerCommand('adiProjectTracker.repair',repairHook),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('adiProjectTracker')){if(event.affectsConfiguration('adiProjectTracker.enabled')&&readEnabled())requestRuntimeResume();recoveryAbort?.abort();updater.configure('');updateKey='';void synchronize();}else if(event.affectsConfiguration('git.path'))void synchronize();}),vscode.workspace.onDidChangeWorkspaceFolders(()=>{void verification.restore().then(post);if(remote)void invalidate().then(()=>synchronize());else collection();}),vscode.workspace.onDidGrantWorkspaceTrust(collection),context.secrets.onDidChange(event=>{if(event.key===CREDENTIAL){recoveryAbort?.abort();updater.configure('');updateKey='';void synchronize();}}));
  const updateTimer=setInterval(()=>void refreshUpdates(),60*60*1000);updateTimer.unref();
  const heartbeat=setInterval(()=>void synchronize(),5000);heartbeat.unref();
  shutdown=async()=>{if(lifecycle.disposed)return;lifecycle.dispose();remoteSetup?.dispose();recoveryAbort?.abort();updater.dispose();clearInterval(updateTimer);stopPoll();clearInterval(heartbeat);collector.dispose();session?.clear();if(lifecycle.binding&&local)await runtime.close(owner()).catch(()=>{});await verification.dispose();};context.subscriptions.push({dispose:()=>{void shutdown?.();}});
  void verification.restore().then(()=>{post();if(verification.snapshot()?.result==='active')void verifyQueries();});
  void synchronize().then(async()=>{if(!lifecycle.binding&&!context.globalState.get('first-setup-shown-v2')){await context.globalState.update('first-setup-shown-v2',true);await vscode.commands.executeCommand('adiProjectTracker.overview.focus');}});
  return {status:()=>collector.status(),refresh:()=>void synchronize()};
}
export async function deactivate(){await shutdown?.();shutdown=undefined;}
