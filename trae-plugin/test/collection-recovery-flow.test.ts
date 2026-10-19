import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';import {runInNewContext} from 'node:vm';import {transform} from 'esbuild';
import {ProjectCollector} from '../src/collector.js';
import {decodePluginRelease} from '@adi/contracts';import {InstallationVerification,WorkspaceInstallationVerification,verificationWorkspace} from '../src/installation-verification.js';import {verificationEnvironment} from '../src/verification-environment.js';import {diagnosticOperation} from '../src/diagnostics.js';import {PluginHttpError,pluginFailureHint} from '../src/http-client.js';import {RuntimeControl,runtimeOwner} from '../src/runtime-control.js';import {TodayOverview} from '../src/today-overview.js';import {CollectionRecovery,managedGroup,recoveryMessage} from '../src/collection-recovery.js';import type {PreparedHook} from '../src/hook-setup.js';
const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'],id='11111111-1111-4111-8111-111111111111';
async function setup(t:{after(fn:()=>Promise<void>):void},sharedDirectory?:string,collection?:{probe:()=>Promise<void>;submit?:(input:Record<string,unknown>)=>Promise<void>}){
 const directory=sharedDirectory??await mkdtemp(join(tmpdir(),'adi-recovery-flow-')),profile=join(directory,'.trae-cn');await mkdir(profile,{recursive:true});
 const binding={origin:'http://example.invalid',user_id:'a163f758-49a9-4d19-b713-0680c1810f66',email:'synthetic@example.org',api_token:'adi_api_v2.'+'a'.repeat(43)},owner=runtimeOwner(binding.user_id,binding.origin);
 const thirdParty={hooks:[{type:'command',command:'foreign-hook',timeout:5}]};await writeFile(join(profile,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(events.map(event=>[event,[managedGroup(profile,id,event,'darwin'),...(event==='Stop'?[thirdParty]:[])]]))}));
 const prepared:PreparedHook={version:'0.3.0',files:{'send-hook.sh':Buffer.from('managed-sh'),'native-macos.js':Buffer.from('managed-native'),'adi-installation.json':Buffer.from(JSON.stringify({installation_id:id,token:'adi_'+'b'.repeat(43),endpoint:binding.origin+'/hooks',protocol_version:2,runtime_owner:owner}))}};
 let enabled=true,loggedIn=true,downloadFailure=false,installFailure=false,confirm=true,installs=0,confirmations=0,downloads=0,installGate:Promise<void>|undefined,installEntered:(()=>void)|undefined;
 const confirmationDetails:string[]=[];
 let configurationChanged:((event:{affectsConfiguration(key:string):boolean})=>void)|undefined;
 let handler:((v:unknown)=>Promise<void>)|undefined,provider:{resolveWebviewView(v:unknown):void}|undefined;
 type Snapshot=NonNullable<ReturnType<InstallationVerification['snapshot']>>;type State={hook:string;verification:Snapshot|null;recovery:{busy:boolean;blocked:boolean;message:string;hasBackup:boolean};email:string;git:string};
 const messages:{type:string;state:State}[]=[],memory=new Map<string,unknown>(),disposable=()=>({dispose(){}}),collectorStates:boolean[]=[];
 const sdk={version:'1.107.1',StatusBarAlignment:{Right:2},env:{appRoot:directory,openExternal:async()=>true},Uri:{file:(path:string)=>({fsPath:path})},window:{createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:(_id:string,p:typeof provider)=>{provider=p;return disposable();},showWarningMessage:async()=>undefined,showInformationMessage:async(text:string,options?:{detail?:string})=>{if(text==='修复采集环境'){confirmationDetails.push(options?.detail??'');confirmations++;return confirm?'确认修复':undefined;}return undefined;}},workspace:{isTrusted:true,workspaceFolders:collection?[{uri:{scheme:'file',fsPath:join(directory,'workspace')}}]:[],getConfiguration:()=>({inspect:(key:string)=>({globalValue:key==='webUrl'?binding.origin:key==='enabled'?enabled:undefined}),get:()=>false}),onDidChangeConfiguration:(fn:typeof configurationChanged)=>{configurationChanged=fn;return disposable();},onDidChangeWorkspaceFolders:disposable,onDidGrantWorkspaceTrust:disposable},commands:{registerCommand:disposable,executeCommand:async()=>{}}};
 const replacements:Record<string,unknown>={vscode:sdk,'node:os':{homedir:()=>directory},'@adi/contracts':{decodePluginRelease},'./installation-verification.js':{InstallationVerification,WorkspaceInstallationVerification,verificationWorkspace},'./verification-environment.js':{verificationEnvironment},'./diagnostics.js':{diagnosticOperation},'./http-client.js':{PluginHttpError,pluginFailureHint},'./runtime-control.js':{runtimeOwner,RuntimeControl:class extends RuntimeControl{constructor(path:string){super(path,Date.now,async()=>({kind:'macos-continuous-v1',scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000}));}}},'./collection-recovery.js':{CollectionRecovery,recoveryMessage},'./collector.js':{ProjectCollector:collection?ProjectCollector:class{configure(_c:unknown,_roots:unknown,active:boolean){collectorStates.push(active);}status(){return {};}dispose(){}}},'./state.js':{PluginState:class{async identity(){return {source_secret:'synthetic-source-secret',source_config_id:id};}async nextSequence(){return '1';}}},'./git-probe.js':{probeProject:async()=>{await collection?.probe();return {state:'not_git',reason:'not_git',git_root:null,remotes:[]};}},'./platform-session.js':{normalizeWebUrl:(s:string)=>new URL(s).origin,platformRequest:async(_origin:string,path:string,_signal:AbortSignal,options?:{body:Record<string,unknown>})=>{if(path==='/api/v1/plugin/sources')return {data:{collector_id:id,user_id:binding.user_id,email:binding.email}};if(path==='/api/v1/plugin/observations'){await collection?.submit?.(options!.body);return {data:{outcome:'saved',observation_id:options!.body.observation_id,received_at:new Date().toISOString()}};}return {data:path==='/api/v1/plugin/me'?{user_id:binding.user_id,email:binding.email}:path==='/api/v1/plugin/today'?{business_date:new Date(Date.now()+8*3600000).toISOString().slice(0,10),as_of:new Date().toISOString(),official_chat_tokens:null,official_cue_tokens:null,hook_sessions:0,prompt_turns:0}:null};}},'./hook-setup.js':{prepareHook:async()=>{downloads++;if(downloadFailure)throw new PluginHttpError(0,'request_timeout');return prepared;},ensureHook:async(_o:unknown,_t:unknown,_owner:unknown,_storage:unknown,_signal:unknown,_status:unknown,options?:{locked?:boolean})=>{
  installs++;if(!options?.locked)return {state:'failed',reason:'orphaned_managed_hooks',profile};installEntered?.();await installGate;if(installFailure)return {state:'failed',reason:'synthetic_install_failed',profile};
  const hooks=JSON.parse(await readFile(join(profile,'hooks.json'),'utf8'));const next='22222222-2222-4222-8222-222222222222';for(const event of events)hooks.hooks[event]=[...(hooks.hooks[event]??[]),managedGroup(profile,next,event,'darwin')];
  const base=join(profile,'adi-native-collector');await mkdir(join(base,next),{recursive:true});await writeFile(join(base,'.owned'),'adi-native-client-v2');await writeFile(join(base,'manifest.json'),JSON.stringify({version:2,release:next,entries:events.map(event=>({event,group:managedGroup(profile,next,event,'darwin')}))}));for(const name of ['send-hook.sh','native-macos.js'])await writeFile(join(base,next,name),prepared.files[name]!);await writeFile(join(base,next,'config.json'),prepared.files['adi-installation.json']!);await writeFile(join(profile,'hooks.json'),JSON.stringify(hooks));return {state:'installed',profile,restart_required:true};
 }},'./today-overview.js':{TodayOverview},'./overview-ui.js':{overviewHtml:()=>''},'./updater.js':{PluginUpdater:class{snapshot(){return {};}configure(){}async restore(){}async check(){}dispose(){}}}};
 const actualRequire=createRequire(new URL('../src/extension.ts',import.meta.url)),source=await readFile(new URL('../src/extension.ts',import.meta.url),'utf8'),{code}=await transform(source,{loader:'ts',format:'cjs',target:'node18',define:{__ADI_PLUGIN_DEFAULT_SERVER__:'""',__ADI_PLUGIN_RELEASE_VERSION__:'"1.0.4"',__ADI_PLUGIN_BUILD_ID__:JSON.stringify('c'.repeat(64))}}),module={exports:{} as {activate(c:unknown):unknown;deactivate():Promise<void>}};
 runInNewContext(code,{module,exports:module.exports,require:(name:string)=>replacements[name]??actualRequire(name),process:{platform:'darwin'},console,Buffer,URL,AbortController,setInterval:()=>({unref(){}}),clearInterval(){},setTimeout,clearTimeout});
 module.exports.activate({globalStorageUri:{fsPath:join(directory,'storage')},subscriptions:[],globalState:{get:(key:string)=>memory.get(key),update:async(key:string,value:unknown)=>{memory.set(key,value);}},secrets:{get:async()=>loggedIn?JSON.stringify(binding):undefined,onDidChange:disposable}});t.after(async()=>{await module.exports.deactivate();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:25});});
 provider!.resolveWebviewView({visible:false,webview:{postMessage:async(v:typeof messages[number])=>{messages.push(v);return true;},onDidReceiveMessage:(fn:typeof handler)=>{handler=fn;return disposable();}},onDidChangeVisibility:disposable});
 const latest=()=>messages.filter(m=>m.type==='state').at(-1)!.state;
 const until=async(predicate:()=>boolean)=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(predicate());};await until(()=>latest().hook.includes('orphaned_managed_hooks'));
 return {confirmationDetails,notifyConfiguration:(setting='enabled')=>configurationChanged!({affectsConfiguration:(key:string)=>['adiProjectTracker','adiProjectTracker.'+setting].includes(key)}),profile,binding,latest,send:async(op:string)=>handler!({op}),setEnabled:(v:boolean)=>{enabled=v;},setLoggedIn:(v:boolean)=>{loggedIn=v;},setDownloadFailure:(v:boolean)=>{downloadFailure=v;},setInstallFailure:(v:boolean)=>{installFailure=v;},setConfirm:(v:boolean)=>{confirm=v;},counts:()=>({installs,confirmations,downloads}),blockInstall:()=>{let release!:()=>void;installGate=new Promise<void>(r=>{release=r;});const ready=new Promise<void>(r=>{installEntered=r;});return {ready,release};},collectorStates,authMessages:()=>messages.filter(m=>m.type==='auth').length};
}

test('the actual button workflow interrupts old verification, repairs, and starts a fresh unconfirmed session',async t=>{
 const f=await setup(t);await f.send('verification-start');const previous=f.latest().verification!;await f.send('recovery');const current=f.latest();assert.equal(current.recovery.blocked,false);assert.match(current.recovery.message,/修复完成/);assert.equal(current.email,f.binding.email);assert.ok(current.verification);assert.notEqual(current.verification.id,previous.id);assert.equal(current.verification.result,'active');assert.deepEqual(current.verification.confirmed,{global:false,local:false,session:false});
 const oldLog=await readFile(previous.logPath,'utf8');assert.match(oldLog,/verification.interrupted/);assert.match(oldLog,/environment_repair/);assert.ok(f.collectorStates.includes(false));assert.equal(f.collectorStates.at(-1),true);assert.equal(f.counts().confirmations,1);
});
test('declining the single confirmation leaves the existing environment and verification unchanged',async t=>{
 const f=await setup(t);f.setConfirm(false);const before=await readFile(join(f.profile,'hooks.json'));await f.send('recovery');assert.deepEqual(await readFile(join(f.profile,'hooks.json')),before);assert.equal(f.latest().recovery.hasBackup,false);assert.match(f.latest().recovery.message,/已取消/);
});
test('download failure does not clear configuration or interrupt an active verification',async t=>{
 const f=await setup(t);await f.send('verification-start');const previous=f.latest().verification!.id,before=await readFile(join(f.profile,'hooks.json'));f.setDownloadFailure(true);await f.send('recovery');assert.equal(f.latest().verification!.id,previous);assert.equal(f.latest().verification!.result,'active');assert.deepEqual(await readFile(join(f.profile,'hooks.json')),before);assert.equal(f.counts().confirmations,0);assert.equal(f.latest().recovery.hasBackup,false);
});
test('a paused collection switch remains paused after a successful repair',async t=>{
 const f=await setup(t);f.setEnabled(false);await f.send('recovery');assert.equal(f.latest().recovery.blocked,false);assert.equal(f.collectorStates.at(-1),false);assert.equal(f.latest().verification!.checks.hook,false);assert.equal(JSON.parse(await readFile(join(f.profile,'adi-plugin-control/control.json'),'utf8')).enabled,false);
});
test('installation failure retains the original backup and leaves collection paused with accessible evidence',async t=>{
 const f=await setup(t);const before=await readFile(join(f.profile,'hooks.json'));f.setInstallFailure(true);await f.send('recovery');const recovery=new CollectionRecovery({profile:f.profile,platform:'darwin'}),record=(await recovery.status())!;assert.deepEqual(await readFile(join(recovery.paths(record).backup,'hooks.json')),before);assert.equal(f.latest().recovery.blocked,true);assert.equal(f.latest().recovery.hasBackup,true);assert.equal(f.collectorStates.at(-1),false);assert.match(f.latest().recovery.message,/已备份/);
});


test('two clicks share one confirmation and one installation transaction',async t=>{
 const f=await setup(t),gate=f.blockInstall();const first=f.send('recovery');await gate.ready;const second=f.send('recovery');assert.equal(f.counts().confirmations,1);assert.equal(f.latest().recovery.busy,true);gate.release();await Promise.all([first,second]);assert.equal(f.latest().recovery.blocked,false);assert.equal(f.counts().confirmations,1);
});
test('an explicit second repair performs another clean reset with its own confirmation and backup',async t=>{
 const f=await setup(t);await f.send('recovery');const counts=f.counts();await f.send('recovery');assert.equal(f.counts().confirmations,counts.confirmations+1);assert.ok(f.counts().installs>counts.installs);assert.match(f.latest().recovery.message,/修复完成/);
});

test('restoring a bound authenticated window does not open a redundant login form',async t=>{
 const f=await setup(t);assert.equal(f.latest().email,f.binding.email);assert.equal(f.authMessages(),0);
});

test('an explicit enable notification resumes a peer that missed the disabled state',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-multiwindow-pause-'));
 const first=await setup(t,directory),peer=await setup(t,directory);
 const control=async()=>JSON.parse(await readFile(join(first.profile,'adi-plugin-control/control.json'),'utf8'));
 assert.equal((await control()).leases.length,2);
 first.setEnabled(false);first.notifyConfiguration();await first.send('repair');assert.equal((await control()).enabled,false);
 first.setEnabled(true);first.notifyConfiguration();await first.send('repair');assert.equal((await control()).enabled,true);
 // The second host processes the latest setting without having observed false.
 peer.notifyConfiguration();await peer.send('repair');
 assert.notEqual(peer.latest().git,'本机已暂停');assert.equal((await control()).leases.length,2);
});
test('an unrelated setting notification does not restart a peer after shared collection was stopped',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-multiwindow-stopped-'));
 const first=await setup(t,directory),peer=await setup(t,directory);
 first.setEnabled(false);first.notifyConfiguration();await first.send('repair');
 peer.notifyConfiguration('webUrl');await peer.send('repair');
 assert.equal(peer.latest().git,'本机已暂停');
 assert.equal(JSON.parse(await readFile(join(first.profile,'adi-plugin-control/control.json'),'utf8')).enabled,false);
});

test('a peer Git probe finishing during recovery cannot submit through the actual extension',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-recovery-peer-probe-'));let finishProbe!:()=>void,probeEntered!:()=>void,submissions=0;
 const probeReady=new Promise<void>(r=>{probeEntered=r;}),probeHold=new Promise<void>(r=>{finishProbe=r;});
 const first=await setup(t,directory),peer=await setup(t,directory,{probe:async()=>{probeEntered();await probeHold;},submit:async()=>{submissions++;}});
 await probeReady;const gate=first.blockInstall(),repair=first.send('recovery');await gate.ready;finishProbe();
 await new Promise(r=>setTimeout(r,50));assert.equal(submissions,0);assert.equal(peer.latest().git,'本机已暂停');
 gate.release();await repair;assert.equal(submissions,0);
});

test('recovery drains an already started peer HTTP submission before installing',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-recovery-peer-http-'));let finishSubmit!:()=>void,submitEntered!:()=>void;
 const submitReady=new Promise<void>(r=>{submitEntered=r;}),submitHold=new Promise<void>(r=>{finishSubmit=r;});
 const first=await setup(t,directory);await setup(t,directory,{probe:async()=>{},submit:async()=>{submitEntered();await submitHold;}});
 await submitReady;const gate=first.blockInstall();let installing=false;void gate.ready.then(()=>{installing=true;});const repair=first.send('recovery');
 await new Promise(r=>setTimeout(r,50));assert.equal(installing,false);finishSubmit();await gate.ready;gate.release();await repair;
});

test('a peer that misses the entire repair reauthenticates and restores its own lease',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-recovery-missed-peer-'));
 const first=await setup(t,directory),peer=await setup(t,directory);
 await first.send('recovery');
 assert.equal(JSON.parse(await readFile(join(first.profile,'adi-plugin-control/control.json'),'utf8')).leases.length,1);
 await peer.send('repair');assert.notEqual(peer.latest().git,'本机已暂停');
 assert.equal(JSON.parse(await readFile(join(first.profile,'adi-plugin-control/control.json'),'utf8')).leases.length,2);
});

test('malformed hooks are disclosed in the same explicit confirmation before any replacement',async t=>{
 const f=await setup(t);await writeFile(join(f.profile,'hooks.json'),'{');f.setConfirm(false);await f.send('recovery');assert.match(f.confirmationDetails[0]!,/第三方 Hook 也需手动恢复/);assert.equal(await readFile(join(f.profile,'hooks.json'),'utf8'),'{');assert.equal(f.latest().recovery.hasBackup,false);
});
