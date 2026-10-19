'use strict';
const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {startMockServer}=require('./mock-server.cjs'),{createTransport}=require('./transport.cjs');
const EXT='adi-test.adi-host-capability-probe',SECRET='synthetic-host-probe-marker-v1',MARKER='.adi-probe-fixture.json';
const hash=v=>createHash('sha256').update(v).digest('hex');
let cleanup=async()=>{};
function activate(context){
 let view,server,serverPromise,transport,disposed=false,epoch=0,poll,today,busy=false;
 const output=vscode.window.createOutputChannel('ADI Host Probe · safe report');
 const report={schema_version:1,probe_version:'0.0.1',synthetic_only:true,runtime:{app_name:vscode.env.appName,editor_api_version:vscode.version,platform:process.platform,process_arch:process.arch,node_version:process.version},checks:{fixture:'not_run',sidebar:'not_run',message_bridge:'not_run',http_transport:'not_run',secret_write:'not_run',secret_verify:'not_run'},counters:{configuration_events:0,secret_events:0,visibility_events:0,poll_requests:0,late_replies_dropped:0},not_run:['real_platform_auth','real_account_token_uniqueness','real_usage_accuracy','hook_installation','hook_execution','30_second_stop','https_tls','full_ide_restart_manual_evidence']};
 const namespaceOkay=String(context.globalStorageUri?.fsPath||'').replace(/\\/g,'/').toLowerCase().endsWith('/'+EXT);
 report.storage_namespace_matches=namespaceOkay;
 async function fixture(){
  const folders=vscode.workspace.workspaceFolders;
  if(vscode.env.remoteName||!folders||folders.length!==1||folders[0].uri.scheme!=='file'||path.basename(folders[0].uri.fsPath).toLowerCase()!=='adi-host-probe-workspace')throw new Error('open_synthetic_workspace');
  const dir=folders[0].uri.fsPath;if((await fs.lstat(dir)).isSymbolicLink())throw new Error('synthetic_workspace_required');
  const f=path.join(dir,MARKER),stat=await fs.lstat(f);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw new Error('synthetic_workspace_required');
  const value=JSON.parse(await fs.readFile(f,'utf8'));if(value.synthetic!==true||value.probe_id!==EXT)throw new Error('synthetic_workspace_required');
  report.checks.fixture='pass';return folders[0].uri;
 }
 function snapshot(){const c=vscode.workspace.getConfiguration('adiHostProbe');let root=false;try{const u=new URL(c.get('platformUrl'));root=['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}catch{}const enabled=c.get('enabled');report.configuration={enabled:typeof enabled==='boolean'?enabled:null,enabled_type_valid:typeof enabled==='boolean',url_is_root:root,scope:'application_declared'};}
 function safe(){snapshot();return JSON.parse(JSON.stringify({...report,transport:server?.safeChecks()}));}
 function post(){if(view&&!disposed)void view.webview.postMessage({type:'report',report:safe(),summary:today});}
 async function api(){if(disposed)throw new Error('probe_disposed');if(!serverPromise)serverPromise=startMockServer().then(async value=>{if(disposed){await value.close();throw new Error('probe_disposed');}server=value;transport=createTransport(server.origin);return transport;}).catch(error=>{serverPromise=undefined;throw error;});return serverPromise;}
 function stopPoll(){clearInterval(poll);poll=undefined;}
 function startPoll(){stopPoll();if(!view?.visible||!today||disposed)return;poll=setInterval(async()=>{if(busy||!view?.visible)return;const generation=epoch;busy=true;try{const value=await (await api()).today();if(generation===epoch&&view?.visible){today=value;report.counters.poll_requests++;post();}else report.counters.late_replies_dropped++;}catch{report.last_error='probe_poll_failed';}finally{busy=false;}},2000);}
 async function action(op,input={}){
  await fixture();
  if(op==='run'){
   const generation=epoch;try{const result=await (await api()).run(input.email||'probe@example.invalid',input.password||'SyntheticOnly1234');report.http_checks=result.checks;report.checks.http_transport='pass';if(generation===epoch){today=result.summary;post();startPoll();}else report.counters.late_replies_dropped++;}catch{report.checks.http_transport='fail';report.last_error='probe_transport_failed';throw new Error('probe_transport_failed');}
  }else if(op==='write'){
   if(!namespaceOkay)throw new Error('storage_namespace_mismatch');const value='synthetic-host-probe:'+randomUUID();await context.secrets.store(SECRET,value);await context.globalState.update('synthetic_expected_hash',hash(value));report.checks.secret_write='pass';report.synthetic_secret_fingerprint=hash(value);post();
  }else if(op==='verify'){
   if(!namespaceOkay)throw new Error('storage_namespace_mismatch');const value=await context.secrets.get(SECRET);
   if(!value?.startsWith('synthetic-host-probe:')){report.checks.secret_verify='fail';report.last_error='synthetic_marker_missing';}
   else{const digest=hash(value),expected=context.globalState.get('synthetic_expected_hash');report.checks.secret_read='pass';report.checks.secret_verify=typeof expected==='string'&&expected===digest?'pass':'not_confirmed';report.synthetic_secret_fingerprint=digest;report.known_write_hash_matches=expected===digest;report.known_write_hash_present=typeof expected==='string';}post();
  }else if(op==='clear'){
   if(!namespaceOkay)throw new Error('storage_namespace_mismatch');await context.secrets.delete(SECRET);await context.globalState.update('synthetic_expected_hash',undefined);delete report.synthetic_secret_fingerprint;report.synthetic_marker_cleared=true;post();
  }else if(op==='settings')await vscode.commands.executeCommand('workbench.action.openSettings','@ext:'+EXT);
  else if(op==='export'){
   const folder=await fixture();const target=await vscode.window.showSaveDialog({defaultUri:vscode.Uri.joinPath(folder,'host-probe-report.json'),filters:{JSON:['json']}});if(target){if(target.scheme!=='file')throw new Error('local_report_required');await fs.writeFile(target.fsPath,JSON.stringify(safe(),null,2));void vscode.window.showInformationMessage('已保存仅含版本、布尔/计数和合成秘密指纹的探针报告。');}
  }
 }
 async function guarded(op,input){try{await action(op,input);post();output.replace(JSON.stringify(safe(),null,2));}catch{report.last_error='probe_action_failed';post();void vscode.window.showErrorMessage('探针未完成：确认打开合成工作区，并查看ADI Host Probe输出。不要关闭安全策略。');}}
 const provider={async resolveWebviewView(v){
  view=v;epoch++;v.webview.options={enableScripts:true,localResourceRoots:[]};
  try{await fixture();report.checks.sidebar='pass';v.webview.html=html();}catch{v.webview.html='<html><body><p>仅允许打开交付包中的 adi-host-probe-workspace 合成目录。</p></body></html>';return;}
  context.subscriptions.push(v.webview.onDidReceiveMessage(message=>{
   if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.id!=='string'||message.id.length>64||!['ready','run','write','verify','clear','settings','export'].includes(message.op))return;
   if(Object.keys(message).some(k=>!['id','op','email','password'].includes(k)))return;
   if(message.op==='ready'){report.checks.message_bridge='pass';post();return;}
   if(message.email!==undefined&&message.email!=='probe@example.invalid')return;
   if(message.password!==undefined&&(typeof message.password!=='string'||message.password.length>128))return;
   void guarded(message.op,{email:message.email,password:message.password});
  }),v.onDidChangeVisibility(()=>{report.counters.visibility_events++;if(!v.visible){epoch++;stopPoll();}else{post();startPoll();}}),v.onDidDispose(()=>{epoch++;stopPoll();view=undefined;}));post();
 }};
 context.subscriptions.push(output,vscode.window.registerWebviewViewProvider('adiHostProbe.overview',provider),vscode.workspace.onDidChangeConfiguration(ev=>{if(ev.affectsConfiguration('adiHostProbe')){report.counters.configuration_events++;post();}}),context.secrets.onDidChange(ev=>{if(ev.key===SECRET){report.counters.secret_events++;post();}}));
 for(const op of ['run','write','verify','clear','settings','export'])context.subscriptions.push(vscode.commands.registerCommand('adiHostProbe.'+op,()=>guarded(op)));
 context.subscriptions.push(vscode.commands.registerCommand('adiHostProbe.open',async()=>{try{await fixture();await vscode.commands.executeCommand('adiHostProbe.overview.focus');}catch{void vscode.window.showErrorMessage('请打开交付包中的 adi-host-probe-workspace 合成目录。');}}));
 cleanup=async()=>{disposed=true;epoch++;stopPoll();if(serverPromise)try{await serverPromise;}catch{}transport?.clear();if(server)await server.close();};
 function html(){const nonce=randomUUID().replace(/-/g,'');return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">body{font:13px/1.6 system-ui;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:12px}button,input{font:inherit;padding:8px;margin:4px 0;max-width:100%}input{width:95%}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px monospace}.note{border-left:3px solid #60a5fa;padding-left:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.value{font-size:20px}small{opacity:.8}</style></head><body><h2>Host Probe · 合成数据</h2><p class="note">不连接平台，不运行Git/Hook，不读取已有密码或令牌。</p><form id="form"><label>合成邮箱<input id="email" value="probe@example.invalid" readonly></label><label>合成密码（不要填写真实密码）<input id="password" type="password" value="SyntheticOnly1234" autocomplete="off"></label><button type="submit">合成表单 / HTTP检查</button></form><button data-op="run">运行自动HTTP检查</button><button data-op="write">写入合成秘密</button><button data-op="verify">读取并验证合成秘密</button><button data-op="clear">清理合成秘密</button><button data-op="settings">打开探针原生设置</button><button data-op="export">导出安全报告</button><h3>今日概览 · 模拟</h3><div id="today">尚未运行检查</div><p><small>可见时每2秒观察模拟读取；产品60秒刷新不是本探针业务验收。</small></p><h3>宿主报告</h3><pre id="report"></pre><script nonce="${nonce}">const host=acquireVsCodeApi();let seq=0;function send(op,extra={}){host.postMessage({id:'probe-'+(++seq),op,...extra});}document.querySelector('#form').addEventListener('submit',event=>{event.preventDefault();const password=document.querySelector('#password').value;document.querySelector('#password').value='';send('run',{email:'probe@example.invalid',password});});document.querySelectorAll('[data-op]').forEach(button=>button.onclick=()=>send(button.dataset.op));window.addEventListener('message',event=>{const data=event.data;if(data?.type!=='report')return;document.querySelector('#report').textContent=JSON.stringify(data.report,null,2);const d=data.summary;if(d?.synthetic){document.querySelector('#today').textContent='官方Chat: '+d.official_chat_tokens+' Token / CUE: '+d.official_cue_tokens+' Token / Hook会话: '+d.hook_sessions+' / 提问: '+d.prompt_turns+' / 内容估算: '+d.content_estimate_tokens+' Token（独立）';}});send('ready');</script></body></html>`;}
}
module.exports={activate,deactivate:()=>cleanup()};
