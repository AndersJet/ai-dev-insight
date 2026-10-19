import {nativeTestServer} from './native-test-config.js';
// Acceptance helper only. Not bundled into the employee extension.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

export async function run(){
  if(process.platform!=='win32')return;
  const folder=vscode.workspace.workspaceFolders?.[0];
  const owned=join(tmpdir(),'plugin-acceptance-20261004',process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'?'windows-isolated-workspace':'windows-workspace');
  if(!folder||folder.uri.scheme!=='file'||resolve(folder.uri.fsPath).toLowerCase()!==resolve(owned).toLowerCase())return;
  let input:{run_id:string;server:string;enabled:boolean;suite?:'basic'|'faults'|'windows-workspace'|'ai-prepare'|'ai-restore'};
  try{input=JSON.parse(await readFile(join(owned,'native-autorun-input.json'),'utf8'));}catch{return;}
  if(!input.enabled)return;
  assert.match(input.run_id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(input.server,nativeTestServer());
  assert.ok(input.suite===undefined||input.suite==='basic'||input.suite==='faults'||input.suite==='windows-workspace'||input.suite==='ai-prepare'||input.suite==='ai-restore');
  const resultName=input.suite==='ai-prepare'?'native-ai-ready.json':input.suite==='ai-restore'?'native-ai-cleanup.json':input.suite==='faults'?'native-fault-result.json':input.suite==='windows-workspace'?'native-windows-workspace-result.json':'native-result.json';
  try{if(await readFile(join(owned,'native-autorun-done.txt'),'utf8')===input.run_id)return;}catch{/* first run */}
  const result:Record<string,unknown>={run_id:input.run_id,suite:input.suite??'basic',host_pid:process.pid,platform:process.platform,arch:process.arch,trusted:vscode.workspace.isTrusted,completed:false};
  try{
    assert.ok(vscode.workspace.isTrusted,'owned synthetic workspace awaits user trust');
    if(input.suite==='ai-restore'){
      const settings=vscode.workspace.getConfiguration('adiProjectTracker');
      assert.equal(settings.inspect('serverUrl')?.globalValue,'http://127.0.0.1:1');
      assert.equal(settings.inspect('ntEmail')?.globalValue,'windows.ai@example.org');
    }else assert.equal(vscode.workspace.getConfiguration('adiProjectTracker').get('serverUrl'),input.server,'only the preset synthetic relay may receive data');
    await writeFile(join(owned,'native-autorun.json'),JSON.stringify({...result,phase:'started'}));
    try{await rename(join(owned,resultName),join(owned,`prior-${input.run_id}-${resultName}`));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await vscode.commands.executeCommand(input.suite==='ai-prepare'?'adiAcceptance.aiPrepare':input.suite==='ai-restore'?'adiAcceptance.aiRestore':input.suite==='faults'?'adiAcceptance.faults':input.suite==='windows-workspace'?'adiAcceptance.windowsWorkspace':'adiAcceptance.run');
    const native=JSON.parse(await readFile(join(owned,resultName),'utf8'));
    assert.equal(native.completed,true,native.error??'native suite did not pass');
    result.completed=true;result.phase='finished';
    await writeFile(join(owned,'native-autorun-done.txt'),input.run_id);
  }catch(error){result.error=error instanceof Error?error.message:'autorun_failed';}
  finally{await writeFile(join(owned,'native-autorun.json'),JSON.stringify(result,null,2));}
}

export function activate(context:vscode.ExtensionContext){
  if(process.platform!=='win32')return;
  const folder=vscode.workspace.workspaceFolders?.[0],owned=join(tmpdir(),'plugin-acceptance-20261004',process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'?'windows-isolated-workspace':'windows-workspace');
  if(!folder||resolve(folder.uri.fsPath).toLowerCase()!==resolve(owned).toLowerCase())return;
  let running=false;
  const start=async()=>{if(running)return;running=true;try{
    // Only the separate CLI-launched acceptance profile receives setup changes.
    // The normal Windows profile and other workspaces never enter this branch.
    if(process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'){
      const input=JSON.parse(await readFile(join(owned,'native-autorun-input.json'),'utf8')) as {server:string;enabled:boolean;suite?:string};
      assert.equal(input.server,nativeTestServer());
      if(input.suite!=='ai-restore'){
      const settings=vscode.workspace.getConfiguration('adiProjectTracker');
      await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);
      await settings.update('serverUrl',input.server,vscode.ConfigurationTarget.Global);
      if(!input.enabled){
        // Recover only the known override left by the interrupted owned fixture.
        const fixture=JSON.parse(await readFile(join(owned,'fixture-test.json'),'utf8')) as {git?:string};
        const git=vscode.workspace.getConfiguration('git');
        if(fixture.git&&git.inspect('path')?.globalValue===fixture.git)await git.update('path',undefined,vscode.ConfigurationTarget.Global);
      }
      }
    }
    await run();
  }catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'ADI owned autorun failed');}finally{running=false;}};
  const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder,'native-autorun-input.json'));
  context.subscriptions.push(watcher,watcher.onDidCreate(()=>void start()),watcher.onDidChange(()=>void start()),vscode.workspace.onDidGrantWorkspaceTrust(()=>void start()));
  void start();
}
