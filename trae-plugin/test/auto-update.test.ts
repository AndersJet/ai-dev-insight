import {verificationWorkspace} from '../src/installation-verification.js';
import {decodePluginRelease} from '@adi/contracts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {PluginUpdater,type UpdateSnapshot} from '../src/updater.js';
import {isPluginBuildInstalled} from '../src/installed-build.js';
import type {PluginReleaseDto} from '@adi/contracts';

test('启动自动更新核对实际安装文件，旧安装记录不阻止离线安装，开启自动重启时仍只准备',async t=>{
 for(const autoRestart of [false,true])await t.test(`autoRestart=${autoRestart}`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-auto-host-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'extensions'),extensionPath=join(root,'ai-dev-insight.adi-project-tracker-1.0.0'),storage=join(directory,'storage'),updates=join(storage,'updates');
  await mkdir(updates,{recursive:true,mode:0o700});await mkdir(extensionPath,{recursive:true});
  const bytes=Buffer.from('synthetic cached package'),build='b'.repeat(64),origin='http://127.0.0.1:1';
  const release:PluginReleaseDto={version:'1.0.1',build_id:build,channel:'stable',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),download_path:`/api/v1/plugin-releases/builds/${build}/download`};
  await writeFile(join(updates,'installed.json'),JSON.stringify(release));await writeFile(join(updates,'pending.json'),JSON.stringify({origin,release,user_id:''}));await writeFile(join(updates,build+'.vsix'),bytes);
  const commands:string[]=[],posted:{type:string;state?:{updates:UpdateSnapshot}}[]=[];
  let provider:{resolveWebviewView(view:unknown):void}|undefined;
  const disposable=()=>({dispose(){}});
  const sdk={StatusBarAlignment:{Right:2},env:{},Uri:{file:(path:string)=>({fsPath:path})},window:{createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:(_id:string,value:typeof provider)=>{provider=value;return disposable();}},workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:(section:string)=>({inspect:(key:string)=>({globalValue:key==='webUrl'?origin:undefined}),get:()=>section==='extensions'?autoRestart:false}),onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidGrantWorkspaceTrust:disposable},commands:{registerCommand:disposable,executeCommand:async(command:string,uri:{fsPath:string})=>{
   commands.push(command);if(command!=='workbench.extensions.installExtension')return;
   assert.deepEqual(await readFile(uri.fsPath),bytes);const target=join(root,'ai-dev-insight.adi-project-tracker-1.0.1');await mkdir(target,{recursive:true});await writeFile(join(target,'package.json'),JSON.stringify({publisher:'ai-dev-insight',name:'adi-project-tracker',version:'1.0.1',adiBuildId:build}));
  }}};
  const actualRequire=createRequire(new URL('../src/extension.ts',import.meta.url));
  const replacements:Record<string,unknown>={vscode:sdk,'@adi/contracts':{decodePluginRelease},'./installation-verification.js':{verificationWorkspace,WorkspaceInstallationVerification:class{workspace={id:'synthetic'};setCheck(){}resetHookVerification(){}snapshot(){return null;}async setScope(){}event(){}async restore(){}async dispose(){}}},'./verification-environment.js':{verificationEnvironment:async()=>({})},'./diagnostics.js':{diagnosticOperation:()=>()=>{}},'node:os':{homedir:()=>directory},'./updater.js':{PluginUpdater},'./installed-build.js':{isPluginBuildInstalled},'./runtime-control.js':{RuntimeControl:class{async close(){}async stop(){}}},'./collector.js':{ProjectCollector:class{configure(){}status(){return {};}dispose(){}}},'./state.js':{PluginState:class{}},'./today-overview.js':{TodayOverview:class{snapshot(){return {data:null};}async clear(){}}},'./overview-ui.js':{overviewHtml:()=>''}};
  const source=await readFile(new URL('../src/extension.ts',import.meta.url),'utf8');
  const {code}=await transform(source,{loader:'ts',format:'cjs',target:'node18',define:{__ADI_PLUGIN_DEFAULT_SERVER__:'""',__ADI_PLUGIN_RELEASE_VERSION__:'"1.0.0"',__ADI_PLUGIN_BUILD_ID__:JSON.stringify('a'.repeat(64))}});
  const module={exports:{} as {activate(context:unknown):unknown;deactivate():Promise<void>}};
  runInNewContext(code,{module,exports:module.exports,require:(name:string)=>replacements[name]??actualRequire(name),process:{platform:'darwin'},console,Buffer,URL,AbortController,setInterval:()=>({unref(){}}),clearInterval(){},setTimeout,clearTimeout});
  module.exports.activate({extensionPath,globalStorageUri:{fsPath:storage},subscriptions:[],globalState:{get:()=>undefined,update:async()=>{}},secrets:{get:async()=>undefined,onDidChange:disposable}});t.after(()=>module.exports.deactivate());
  provider!.resolveWebviewView({visible:false,webview:{postMessage:async(value:typeof posted[number])=>{posted.push(value);return true;},onDidReceiveMessage:disposable},onDidChangeVisibility:disposable});
  const latest=()=>posted.filter(value=>value.type==='state').at(-1)?.state?.updates;
  const deadline=Date.now()+3000;while(!latest()?.message.includes('检查失败')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(latest()?.message.includes('检查失败'),JSON.stringify(latest()));assert.equal(latest()!.phase,autoRestart?'ready':'installed');
  assert.deepEqual(commands.filter(command=>command.startsWith('workbench.')),autoRestart?[]:['workbench.extensions.installExtension']);assert.equal(latest()!.version,'1.0.0','安装完成不伪造运行版本，后台不主动重启');
  if(!autoRestart){assert.equal(await isPluginBuildInstalled(extensionPath,release),true);await writeFile(join(root,'.obsolete'),JSON.stringify({'ai-dev-insight.adi-project-tracker-1.0.1':true}));assert.equal(await isPluginBuildInstalled(extensionPath,release),false,'等待移除的文件不能作为已安装证据');}
 });
});
