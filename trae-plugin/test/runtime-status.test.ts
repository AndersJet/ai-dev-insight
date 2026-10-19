import {decodePluginRelease} from '@adi/contracts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {RuntimeControl,runtimeOwner,isRuntimeActive} from '../src/runtime-control.js';
import {PluginHttpError} from '../src/http-client.js';
import type {LeaseClock} from '../src/runtime-clock.js';

test('the extension clears a recovered runtime error without hiding other failures or resuming a disabled collector',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-status-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const binding={origin:'http://example.invalid',user_id:'a163f758-49a9-4d19-b713-0680c1810f66',email:'synthetic@example.invalid',api_token:'adi_api_v2.'+'a'.repeat(43)};
  const owner=runtimeOwner(binding.user_id,binding.origin);
  const clock:LeaseClock={kind:'macos-continuous-v1',scope:'macos:a163f758-49a9-4d19-b713-0680c1810f66',monotonic_ms:1000};
  let clockFailed=true,enabled=true,collectorState='needs_configuration';
  const posted:{type:string;state:{error:string;badge:string;git:string}}[]=[];
  let provider:{resolveWebviewView(view:unknown):void}|undefined;
  let handler:((message:unknown)=>Promise<void>)|undefined;
  const disposable=()=>({dispose(){}});
  const view={visible:false,webview:{options:{},html:'',postMessage:async(value:typeof posted[number])=>{posted.push(value);return true;},onDidReceiveMessage:(fn:typeof handler)=>{handler=fn;return disposable();}},onDidChangeVisibility:disposable};
  const sdk={StatusBarAlignment:{Right:2},env:{},window:{createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:(_id:string,value:typeof provider)=>{provider=value;return disposable();},showWarningMessage:async()=>undefined},workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({inspect:(key:string)=>({globalValue:key==='webUrl'?binding.origin:key==='enabled'?enabled:undefined}),get:()=>false}),onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidGrantWorkspaceTrust:disposable},commands:{registerCommand:disposable,executeCommand:async()=>{}}};
  const actualRequire=createRequire(new URL('../src/extension.ts',import.meta.url));
  const replacements:Record<string,unknown>={
    vscode:sdk,'@adi/contracts':{decodePluginRelease},'node:os':{homedir:()=>directory},
    './runtime-control.js':{runtimeOwner,RuntimeControl:class extends RuntimeControl{constructor(path:string){super(path,Date.now,async()=>{if(clockFailed)throw new Error('runtime_clock_unavailable');return clock;});}}},
    './collector.js':{ProjectCollector:class{configure(_config:unknown,_roots:unknown,allowed:boolean){collectorState=allowed?'active':'needs_configuration';}status(){return {state:collectorState,lastSavedAt:null};}dispose(){}}},
    './state.js':{PluginState:class{}},
    './git-probe.js':{},
    './platform-session.js':{normalizeWebUrl:(input:string)=>new URL(input).origin,platformRequest:async()=>({data:{user_id:binding.user_id,email:binding.email}}),PlatformSession:class{async setup(){throw new Error('synthetic unrelated action failure');}}},
    './http-client.js':{PluginHttpError},
    './hook-setup.js':{ensureHook:async()=>({state:'ready',profile:directory})},
    './today-overview.js':{TodayOverview:class{snapshot(){return {data:null,stale:false};}async clear(){}async refresh(){}}},
    './overview-ui.js':{overviewHtml:()=>''},
    './updater.js':{PluginUpdater:class{snapshot(){return {};}configure(){}async restore(){}async check(){}dispose(){}}},
  };
  const source=await readFile(new URL('../src/extension.ts',import.meta.url),'utf8');
  const {code}=await transform(source,{loader:'ts',format:'cjs',target:'node18',define:{__ADI_PLUGIN_DEFAULT_SERVER__:'""',__ADI_PLUGIN_RELEASE_VERSION__:'"1.0.1"',__ADI_PLUGIN_BUILD_ID__:'"synthetic"'}});
  const module={exports:{} as {activate(context:unknown):{refresh():void};deactivate():Promise<void>}};
  runInNewContext(code,{module,exports:module.exports,require:(name:string)=>replacements[name]??actualRequire(name),process:{platform:'darwin'},console,Buffer,URL,AbortController,setInterval:()=>({unref(){}}),clearInterval(){},setTimeout,clearTimeout});
  const values=new Map<string,unknown>();
  const api=module.exports.activate({globalStorageUri:{fsPath:join(directory,'storage')},subscriptions:[],globalState:{get:(key:string)=>values.get(key),update:async(key:string,value:unknown)=>{values.set(key,value);}},secrets:{get:async()=>JSON.stringify(binding),onDidChange:disposable}});
  t.after(()=>module.exports.deactivate());
  provider!.resolveWebviewView(view);
  const latest=()=>posted.filter(value=>value.type==='state').at(-1)!.state;
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),JSON.stringify(latest()));};
  await until(()=>latest().error.includes('本机运行控制暂不可用'));
  assert.equal(latest().git,'本机已暂停');
  const retryCount=posted.length;api.refresh();await until(()=>posted.length>retryCount);
  assert.ok(latest().error.includes('本机运行控制暂不可用'),'a continuing runtime failure must remain visible');
  clockFailed=false;api.refresh();await until(()=>latest().git==='观测运行中');
  assert.equal(isRuntimeActive(JSON.parse(await readFile(join(directory,'.trae-cn','adi-plugin-control','control.json'),'utf8')),owner,Date.now(),clock),true);
  assert.equal(latest().error,'','recovered runtime must clear its old paused banner');
  assert.notEqual(latest().badge,'需要处理');
  await handler!({op:'departments'});const unrelatedError=latest().error;assert.ok(unrelatedError);
  const before=posted.length;api.refresh();await until(()=>posted.length>before);
  assert.equal(latest().error,unrelatedError,'a healthy runtime must not clear unrelated action errors');
  clockFailed=true;api.refresh();await until(()=>latest().error.includes('本机运行控制暂不可用'));
  enabled=false;clockFailed=false;api.refresh();await until(()=>latest().error==='');
  assert.equal(latest().badge,'已暂停');assert.equal(latest().git,'本机已暂停');
  assert.equal(JSON.parse(await readFile(join(directory,'.trae-cn','adi-plugin-control','control.json'),'utf8')).enabled,false);
});
