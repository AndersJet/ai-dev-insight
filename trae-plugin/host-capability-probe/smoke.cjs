'use strict';
// Node-level checks only. This stub is never packaged as host evidence.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {startMockServer}=require('./mock-server.cjs'),{createTransport}=require('./transport.cjs');
(async()=>{
 for(const address of ['http://u:p@127.0.0.1:1234','http://127.0.0.1:1234/?x=1','http://127.0.0.1:1234/#x','http://example.invalid:1234/'])assert.throws(()=>createTransport(address));
 const server=await startMockServer();try{const client=createTransport(server.origin),result=await client.run();assert.equal(result.summary.synthetic,true);assert.equal(result.checks.same_account_mock_token_reused,true);assert.equal(server.safeChecks().api_token_creations,1);assert.equal(server.safeChecks().origin_rejections,0);assert(!JSON.stringify(result).includes('probe_api_'));assert(!JSON.stringify(result).includes('csrf_token'));const retry=await client.run();assert.equal(retry.checks.bearer_today,true);assert.equal(server.safeChecks().api_token_creations,1);}finally{await server.close();}assert.equal(server.safeChecks().open_connections,0);
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'adi-probe-smoke-')),folder=path.join(temp,'adi-host-probe-workspace');await fs.mkdir(folder);
 const commands=new Map(),secretValues=new Map(),globalValues=new Map(),secretEvents=[];let provider,publicMessage,errors=0;
 const disposable=()=>({dispose(){}});
 const vscode={version:'synthetic-sdk-stub',env:{appName:'synthetic-stub',remoteName:undefined},Uri:{joinPath:(u,n)=>({scheme:'file',fsPath:path.join(u.fsPath,n)})},workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:folder}}],getConfiguration:()=>({get:k=>k==='enabled'?'must-not-export-this-invalid-value':'https://example.invalid/'}),onDidChangeConfiguration:()=>disposable()},window:{createOutputChannel:()=>({replace:v=>{assert(!v.includes('must-not-export-this-invalid-value'));assert(!v.includes('probe_api_'));},dispose(){}}),showErrorMessage:()=>{errors++;},showInformationMessage:()=>{},showSaveDialog:async()=>null,registerWebviewViewProvider:(_id,p)=>{provider=p;return disposable();}},commands:{registerCommand:(id,f)=>{commands.set(id,f);return disposable();},executeCommand:async()=>{} }};
 const context={globalStorageUri:{fsPath:path.join(temp,'adi-test.adi-host-capability-probe')},subscriptions:[],globalState:{get:k=>globalValues.get(k),update:async(k,v)=>{if(v===undefined)globalValues.delete(k);else globalValues.set(k,v);}},secrets:{store:async(k,v)=>{secretValues.set(k,v);secretEvents.forEach(f=>f({key:k}));},get:async k=>secretValues.get(k),delete:async k=>secretValues.delete(k),onDidChange:f=>{secretEvents.push(f);return disposable();}}};
 const priorLoad=Module._load;Module._load=function(name,...args){return name==='vscode'?vscode:priorLoad.call(this,name,...args);};const extension=require('./extension.cjs');Module._load=priorLoad;
 extension.activate(context);
 try{
  await commands.get('adiHostProbe.write')();assert.equal(secretValues.size,0);assert.equal(errors,1,'no fixture must refuse writes');
  await fs.writeFile(path.join(folder,'.adi-probe-fixture.json'),JSON.stringify({synthetic:true,probe_id:'adi-test.adi-host-capability-probe'}));
  const view={visible:false,webview:{options:{},html:'',postMessage:async m=>{publicMessage=m;assert(!JSON.stringify(m).includes('synthetic-host-probe:'));assert(!JSON.stringify(m).includes('probe_api_'));},onDidReceiveMessage:()=>disposable()},onDidChangeVisibility:()=>disposable(),onDidDispose:()=>disposable()};await provider.resolveWebviewView(view);
  await commands.get('adiHostProbe.write')();assert.equal(secretValues.size,1);await commands.get('adiHostProbe.verify')();assert.equal(publicMessage.report.checks.secret_verify,'pass');
  globalValues.set('synthetic_expected_hash','wrong');await commands.get('adiHostProbe.verify')();assert.equal(publicMessage.report.checks.secret_verify,'not_confirmed');assert.equal(publicMessage.report.checks.secret_read,'pass');
  await Promise.all([commands.get('adiHostProbe.run')(),commands.get('adiHostProbe.run')()]);assert.equal(publicMessage.report.transport.loopback_only,true);assert.equal(publicMessage.report.transport.synthetic_logins,2,'concurrent runs must share a single mock server');assert.equal(publicMessage.report.configuration.enabled,null);assert.equal(publicMessage.report.checks.http_transport,'pass');
  await commands.get('adiHostProbe.clear')();assert.equal(secretValues.size,0);
 }finally{await extension.deactivate();await fs.rm(temp,{recursive:true,force:true});}
 console.log(JSON.stringify({node_smoke:'pass',http_transport:'local_node_only',workspace_guard:'stub_unit_only',secret_report_filter:'stub_unit_only',actual_trae_host:'not_run',windows:'not_run'}));
})().catch(()=>{console.error('synthetic_probe_smoke_failed');process.exitCode=1;});
