import console from 'node:console';import {setTimeout,clearTimeout,setInterval,clearInterval} from 'node:timers';import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {createRequire} from 'node:module';import vm from 'node:vm';import process from 'node:process';import {Buffer} from 'node:buffer';import {URL} from 'node:url';
const actualRequire=createRequire(import.meta.url),values=new Map(),memory=new Map(),changes=[],subscriptions=[],posted=[],commands=[],guideMessages=[];let provider,handler;
const dispose=()=>({dispose(){}}),view={visible:true,webview:{options:{},html:'',postMessage:async value=>{posted.push(value);return true;},onDidReceiveMessage:fn=>{handler=fn;return dispose();}},onDidChangeVisibility:()=>dispose()};
const sdk={StatusBarAlignment:{Right:2},env:{remoteName:undefined,openExternal:async()=>true},Uri:{parse:value=>new URL(value)},window:{createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:(_id,p)=>{provider=p;return dispose();},showWarningMessage:async()=>undefined,showInformationMessage:async(...args)=>{guideMessages.push(args);return args.includes('打开 Hooks 设置')?'打开 Hooks 设置':undefined;}},workspace:{isTrusted:true,workspaceFolders:[{uri:{scheme:'file',fsPath:process.env.ADI_SYNTHETIC_WORKSPACE}}],getConfiguration:section=>({inspect:key=>({globalValue:section==='adiProjectTracker'?(key==='webUrl'?process.env.ADI_SYNTHETIC_ORIGIN:key==='enabled'?true:undefined):undefined})}),onDidChangeConfiguration:()=>dispose(),onDidChangeWorkspaceFolders:()=>dispose(),onDidGrantWorkspaceTrust:()=>dispose()},commands:{registerCommand:()=>dispose(),executeCommand:async(command,...args)=>{commands.push([command,...args]);if(command==='adiProjectTracker.overview.focus'&&!handler)provider.resolveWebviewView(view);}}};
let holdNextOverviewClear=false,releaseOverviewClear;
const context={globalStorageUri:{fsPath:process.env.ADI_SYNTHETIC_STORAGE},extension:{packageJSON:{version:'0.3.0'}},subscriptions,globalState:{get:key=>memory.get(key),update:async(key,value)=>{if(key==='today-summary-v1'&&value===undefined&&holdNextOverviewClear){holdNextOverviewClear=false;await new Promise(resolve=>{releaseOverviewClear=resolve;});}memory.set(key,value);}},secrets:{get:async key=>values.get(key),store:async(key,value)=>{values.set(key,value);for(const fn of changes)globalThis.queueMicrotask(()=>fn({key}));},delete:async key=>{values.delete(key);for(const fn of changes)globalThis.queueMicrotask(()=>fn({key}));},onDidChange:fn=>{changes.push(fn);return dispose();}}};
const module={exports:{}};const sandbox={module,exports:module.exports,require:name=>name==='vscode'?sdk:actualRequire(name),console,process,Buffer,URL,AbortController:globalThis.AbortController,setTimeout,clearTimeout,setInterval,clearInterval};vm.runInNewContext(await readFile(process.env.ADI_SYNTHETIC_BUNDLE,'utf8'),sandbox,{filename:'synthetic-extension.cjs'});
const automatic=process.env.ADI_SYNTHETIC_AUTO_HOOK==='1';const profile=join(process.env.HOME,'.trae-cn');if(automatic){await mkdir(profile,{recursive:true});await writeFile(join(profile,'hooks.json'),JSON.stringify({version:1,hooks:{Stop:[{hooks:[{type:'command',command:'synthetic third party'}]}]}}));}
const api=module.exports.activate(context),until=async predicate=>{const end=Date.now()+12000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok(predicate(),'observable plugin state did not converge');};
let checkpointId=0;
const accountCheckpoint=(action,userId)=>new Promise((resolve,reject)=>{
 const id=++checkpointId,timer=setTimeout(()=>{process.removeListener('message',receive);reject(new Error('synthetic_account_checkpoint_timeout'));},10000);
 const receive=message=>{if(message?.type!=='account-checkpoint-result'||message.id!==id)return;clearTimeout(timer);process.removeListener('message',receive);if(message.ok)resolve();else reject(new Error('synthetic_account_checkpoint_failed'));};
 process.on('message',receive);if(!process.send){clearTimeout(timer);process.removeListener('message',receive);reject(new Error('synthetic_account_ipc_required'));return;}
 process.send({type:'account-checkpoint',id,action,user_id:userId});
});
let accountRecovered=false,lateRejectionIgnored=false;
try{
 await until(()=>!!handler);await new Promise(r=>setTimeout(r,100));assert.equal(api.status().lastSavedAt,null);assert.equal(values.size,0);
 await handler({op:'register',input:{email:'plugin.host.synthetic@example.org',password:'SyntheticOnlyHostPassword123!',display_name:'合成插件员工',department_id:process.env.ADI_SYNTHETIC_DEPARTMENT}});
 await until(()=>api.status().lastSavedAt!==null);await until(()=>api.status().state==='active');
 assert.equal(posted.some(value=>JSON.stringify(value).includes('SyntheticOnlyHostPassword123!')||JSON.stringify(value).includes('adi_api_v2.')),false);
 await handler({op:'refresh'});
 // Login can already be refreshing. Wait for the actual view result, not for
 // the redundant refresh message to return while that request is in flight.
 await until(()=>posted.findLast(value=>value.type==='state')?.state.today.data);
 if(process.env.ADI_SYNTHETIC_LATE_REJECTION==='1'){
  const original=JSON.parse(values.get('account-binding-v2')),saved=api.status().lastSavedAt,nextOrigin=process.env.ADI_SYNTHETIC_NEXT_ORIGIN;
  await accountCheckpoint('arm-old-rejection',original.user_id);holdNextOverviewClear=true;
  const rejected=handler({op:'refresh'});await until(()=>typeof releaseOverviewClear==='function');
  // A second authenticated local window shares its successfully acquired
  // binding while this window is still persisting the old target's rejection.
  const login=await globalThis.fetch(nextOrigin+'/api/v1/auth/login',{method:'POST',headers:{Origin:nextOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:'plugin.host.synthetic@example.org',password:'SyntheticOnlyHostPassword123!'})});assert.equal(login.status,200);
  const cookies=login.headers.getSetCookie().map(value=>value.split(';',1)[0]),csrf=cookies.find(value=>value.startsWith('adi_csrf='))?.slice('adi_csrf='.length);assert.ok(csrf);
  const exchange=await globalThis.fetch(nextOrigin+'/api/v1/me/plugin-credential',{method:'POST',headers:{Origin:nextOrigin,'Content-Type':'application/json',Cookie:cookies.join('; '),'X-CSRF-Token':csrf},body:'{}'});assert.equal(exchange.status,200);
  const nextBinding=JSON.stringify({...((await exchange.json()).data),origin:nextOrigin});process.env.ADI_SYNTHETIC_ORIGIN=nextOrigin;await context.secrets.store('account-binding-v2',nextBinding);
  await until(()=>api.status().state==='needs_configuration');releaseOverviewClear();await rejected;
  assert.equal(values.get('account-binding-v2')===nextBinding,true,'an old rejection must not delete the newer authenticated target binding');
  await until(()=>api.status().state==='active'&&api.status().lastSavedAt!==null&&api.status().lastSavedAt!==saved);
  assert.equal(values.get('account-binding-v2')===nextBinding,true);await accountCheckpoint('switched-target',original.user_id);lateRejectionIgnored=true;
 }
 if(process.env.ADI_SYNTHETIC_ACCOUNT_RECOVERY==='1'){
  const original=values.get('account-binding-v2'),bound=JSON.parse(original),saved=api.status().lastSavedAt;
  await accountCheckpoint('suspend',bound.user_id);
  await handler({op:'refresh'});await until(()=>api.status().state==='needs_configuration'&&api.status().queued===0);
  assert.equal(values.get('account-binding-v2')===original,true,'temporary account rejection must retain the exact local binding');
  const stopped=JSON.parse(await readFile(join(profile,'adi-plugin-control','control.json'),'utf8'));assert.equal(stopped.enabled,false);assert.deepEqual(stopped.leases,[]);
  const denied=await globalThis.fetch(process.env.ADI_SYNTHETIC_ORIGIN+'/api/v1/plugin/me',{headers:{Authorization:'Bearer '+bound.api_token}});assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'plugin_account_unavailable');
  await accountCheckpoint('restore',bound.user_id);
  await until(()=>api.status().state==='active'&&api.status().lastSavedAt!==null&&api.status().lastSavedAt!==saved);
  assert.equal(values.get('account-binding-v2')===original,true,'restoration must not require a login or write another credential');
  const restored=await globalThis.fetch(process.env.ADI_SYNTHETIC_ORIGIN+'/api/v1/plugin/me',{headers:{Authorization:'Bearer '+bound.api_token}});assert.equal(restored.status,200);assert.equal((await restored.json()).data.user_id,bound.user_id);
  assert.equal(JSON.parse(await readFile(join(profile,'adi-plugin-control','control.json'),'utf8')).enabled,true);accountRecovered=true;
 }
 if(automatic){
  await until(()=>posted.some(value=>value.type==='state'&&value.state.hook.includes('文件已安装')));
  const latest=()=>posted.findLast(value=>value.type==='state').state;
  assert.equal(latest().badge,'Hook待验证','installed files must not claim that the IDE switch is disabled');
  assert.equal(latest().hookGuide.canConfirm,true);assert.equal(latest().hookGuide.confirmed,false);
  assert.ok(view.webview.html.includes('确认已完成启用设置'));
  const beforeGuide=commands.length;await handler({op:'guide'});
  assert.equal(commands.slice(beforeGuide).some(([command])=>command==='workbench.action.openSettings'),false,'Trae Hooks guidance must not open VS Code settings');
  assert.ok(guideMessages.some(args=>JSON.stringify(args).includes('全局')&&JSON.stringify(args).includes('本地自动运行')));
  await handler({op:'confirm-guide'});assert.equal(memory.get('hook-guide-completed-v2'),true);
  assert.equal(latest().badge,'已接入');assert.ok(latest().hook.includes('启用设置已确认'));assert.ok(latest().hook.includes('运行待验证'));
  const manifestPath=join(profile,'adi-native-collector','manifest.json'),before=JSON.parse(await readFile(manifestPath,'utf8'));const hooks=JSON.parse(await readFile(join(profile,'hooks.json'),'utf8'));assert.equal(hooks.hooks.Stop[0].hooks[0].command,'synthetic third party');
  await handler({op:'login',input:{email:'plugin.host.synthetic@example.org',password:'SyntheticOnlyHostPassword123!'}});await until(()=>posted.some(value=>value.type==='state'&&value.state.hook.includes('文件就绪')));assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).release,before.release);
  hooks.hooks.Stop[1].hooks[0].timeout=5;const modified=JSON.stringify(hooks);await writeFile(join(profile,'hooks.json'),modified);await handler({op:'repair'});assert.equal(await readFile(join(profile,'hooks.json'),'utf8'),modified);await until(()=>api.status().state==='active');assert.ok(posted.some(value=>value.type==='state'&&value.state.hook.includes('managed_hooks_modified')));
 }
 await handler({op:'signout'});await until(()=>!values.has('account-binding-v2'));assert.equal(api.status().queued,0);assert.equal(api.status().state,'needs_configuration');
 process.stdout.write(JSON.stringify({unauthenticated_gate:true,registered_in_plugin:true,private_binding:true,git_saved:true,hook_failure_does_not_pause_git:true,overview_loaded:true,signout_stops:true,...(accountRecovered?{temporary_account_gate:true,original_binding_restored:true,no_password_reentry:true}:{}),...(lateRejectionIgnored?{old_rejection_ignored:true,new_target_binding_preserved:true,new_target_saved:true}:{})}));
}finally{releaseOverviewClear?.();await module.exports.deactivate();for(const item of subscriptions)item.dispose();}
