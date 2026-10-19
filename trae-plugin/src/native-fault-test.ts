import {nativeTestServer} from './native-test-config.js';
// Acceptance only: actual IDE settings/editor plus a bounded local fault server.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import type {Socket,AddressInfo} from 'node:net';

export async function run(){
  const file=vscode.workspace.workspaceFile;
  const windows=process.platform==='win32',folder=vscode.workspace.workspaceFolders?.[0];
  const owned=join(tmpdir(),'plugin-acceptance-20261004','windows-isolated-workspace');
  if(windows)assert.ok(process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'&&folder?.uri.scheme==='file'&&resolve(folder.uri.fsPath).toLowerCase()===resolve(owned).toLowerCase(),'only the isolated Windows fixture is permitted');
  else assert.ok(file?.scheme==='file'&&file.fsPath.includes('/plugin-acceptance/mac-multi/'),'only the owned synthetic workspace is permitted');
  const resultDirectory=windows?owned:dirname(file!.fsPath),prefix=windows?'windows':'mac';
  assert.ok(vscode.workspace.isTrusted);
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension);
  const api=await extension.activate() as {refresh():void;status():{state:string;lastSavedAt:string|null;queued:number}};
  const settings=vscode.workspace.getConfiguration('adiProjectTracker'),priorEmail=settings.inspect('ntEmail')?.globalValue,priorUrl=settings.inspect('serverUrl')?.globalValue;
  const git=vscode.workspace.getConfiguration('git'),priorGit=git.inspect('path')?.globalValue;
  let changedGit=false;
  const results:Record<string,unknown>={platform:process.platform,arch:process.arch,host_pid:process.pid,plugin_version:extension.packageJSON.version,started_at:new Date().toISOString(),completed:false};
  let mode:'failed'|'forward'|'stall'|'headers'|'denied'|'limited'='failed',requests=0,maxSockets=0,limitedAt=0,recoveredAt=0;
  const sockets=new Set<Socket>();
  const server=createServer((incoming,outgoing)=>{
    requests++;
    if(mode==='failed'){outgoing.writeHead(503).end();return;}
    if(mode==='stall'){outgoing.writeHead(200,{'content-type':'application/json'});outgoing.write('{"data":');return;}
    if(mode==='headers')return;
    if(mode==='denied'){outgoing.writeHead(401).end();return;}
    if(mode==='limited'){limitedAt=performance.now();outgoing.writeHead(429,{'retry-after':'60'}).end();return;}
    if(limitedAt&&!recoveredAt)recoveredAt=performance.now();
    if(incoming.method!=='POST'||!['/api/v1/plugin/registration','/api/v1/plugin/observations'].includes(incoming.url??'')){outgoing.writeHead(404).end();return;}
    const headers={...incoming.headers};delete headers.host;
    const upstream=new URL(nativeTestServer()+incoming.url);
    const forwarded=request(upstream,{method:'POST',agent:false,headers},response=>{outgoing.writeHead(response.statusCode??502,{'content-type':'application/json'});response.pipe(outgoing);});
    const timer=setTimeout(()=>forwarded.destroy(),3000);forwarded.on('close',()=>clearTimeout(timer));
    forwarded.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});incoming.pipe(forwarded);
  });
  server.on('connection',socket=>{sockets.add(socket);maxSockets=Math.max(maxSockets,sockets.size);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const wait=async(predicate:()=>boolean,limit:number)=>{const deadline=Date.now()+limit;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));assert.ok(predicate(),'actual host condition did not arrive before the deadline');};
  const root=vscode.workspace.workspaceFolders![0]!,document=await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri,'fixture.txt'));await vscode.window.showTextDocument(document);
  async function edit(label:string){const started=performance.now(),change=new vscode.WorkspaceEdit();change.insert(document.uri,new vscode.Position(document.lineCount,0),`Synthetic ${label} edit.\n`);assert.ok(await vscode.workspace.applyEdit(change));assert.ok(await document.save());return performance.now()-started;}
  try{
    if(windows){const fixture=JSON.parse(await readFile(join(owned,'fixture-test.json'),'utf8')) as {git:string};await git.update('path',fixture.git,vscode.ConfigurationTarget.Global);changedGit=true;}
    await settings.update('serverUrl',endpoint,vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail',`${prefix}.faults@example.org`,vscode.ConfigurationTarget.Global);api.refresh();
    await wait(()=>api.status().state==='unavailable'&&requests>0,5000);results.service_503_edit_save_ms=await edit('503');
    const beforeRecovery=requests;mode='forward';
    await wait(()=>api.status().lastSavedAt!==null,40000);assert.ok(requests>beforeRecovery);results.recovered_without_ide_restart=true;
    await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);api.refresh();
    assert.equal(api.status().state,'needs_configuration');await wait(()=>sockets.size===0,4000);
    const afterClear=requests;await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(requests,afterClear);results.removing_email_stops_work=true;
    mode='stall';await settings.update('ntEmail',`${prefix}.stall@example.org`,vscode.ConfigurationTarget.Global);api.refresh();
    await wait(()=>sockets.size>0,2000);const started=performance.now();results.stalled_response_edit_save_ms=await edit('stalled-response');
    await wait(()=>api.status().state==='unavailable'&&sockets.size===0,4000);results.stalled_socket_closed_ms=performance.now()-started;
    assert.ok(Number(results.stalled_socket_closed_ms)<3800);
    await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);api.refresh();
    mode='headers';await settings.update('ntEmail',`${prefix}.headers@example.org`,vscode.ConfigurationTarget.Global);api.refresh();
    await wait(()=>sockets.size>0,2000);const headersStarted=performance.now();results.stalled_headers_edit_save_ms=await edit('stalled-headers');
    await wait(()=>api.status().state==='unavailable'&&sockets.size===0,4000);results.stalled_headers_closed_ms=performance.now()-headersStarted;assert.ok(Number(results.stalled_headers_closed_ms)<3800);
    await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);api.refresh();
    mode='denied';await settings.update('ntEmail',`${prefix}.denied@example.org`,vscode.ConfigurationTarget.Global);api.refresh();
    await wait(()=>api.status().state==='paused',5000);const deniedRequests=requests;results.authorization_paused_edit_save_ms=await edit('401');
    api.refresh();await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(requests,deniedRequests);assert.equal(api.status().state,'paused');results.authorization_not_bypassed_by_refresh=true;
    await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);api.refresh();
    mode='limited';await settings.update('ntEmail',`${prefix}.limited@example.org`,vscode.ConfigurationTarget.Global);api.refresh();
    await wait(()=>limitedAt>0&&api.status().state==='unavailable',5000);const limitedRequests=requests;results.rate_limited_edit_save_ms=await edit('429');
    api.refresh();await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(requests,limitedRequests);mode='forward';
    await wait(()=>api.status().lastSavedAt!==null,65000);assert.ok(recoveredAt-limitedAt>=59000,'server Retry-After must not be shortened');results.retry_after_recovery_ms=recoveredAt-limitedAt;
    assert.equal(maxSockets,1);results.maximum_plugin_sockets=maxSockets;results.completed=true;
  }catch(error){results.error=error instanceof Error?error.message:'native_fault_acceptance_failed';results.state_at_failure=api.status();throw error;}
  finally{
    try{
      await settings.update('ntEmail',priorEmail,vscode.ConfigurationTarget.Global);await settings.update('serverUrl',priorUrl,vscode.ConfigurationTarget.Global);api.refresh();
      if(changedGit){await git.update('path',priorGit,vscode.ConfigurationTarget.Global);assert.equal(git.inspect('path')?.globalValue,priorGit);results.git_setting_restored=true;}
    }finally{
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      await writeFile(join(resultDirectory,'native-fault-result.json'),JSON.stringify(results,null,2));
    }
  }
}
