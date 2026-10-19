import {nativeTestServer} from './native-test-config.js';
// Acceptance helper only. Public API/DB assertions are made by the host driver.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

export async function run(){
  const owned=join(tmpdir(),'plugin-acceptance-20261004','windows-isolated-workspace');
  const original=vscode.workspace.workspaceFolders??[],first=original[0];
  assert.ok(process.platform==='win32'&&process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'&&original.length===5&&first?.uri.scheme==='file'&&resolve(first.uri.fsPath).toLowerCase()===resolve(owned).toLowerCase(),'open and trust the five-root isolated Windows fixture before starting');
  assert.ok(vscode.workspace.isTrusted);
  const expected=JSON.parse(await readFile(join(owned,'expected.json'),'utf8')) as {roots:string[];git:string};
  assert.equal(expected.roots.length,5);assert.equal(resolve(expected.roots[0]!).toLowerCase(),resolve(owned).toLowerCase());
  const parent=resolve(owned,'..').toLowerCase();
  assert.ok(expected.roots.every(root=>resolve(root).toLowerCase().startsWith(parent+'\\')),'all roots must remain inside the owned fixture parent');
  const normalized=(roots:string[])=>roots.map(root=>resolve(root).toLowerCase()).sort();
  assert.deepEqual(normalized(original.map(folder=>folder.uri.fsPath)),normalized(expected.roots),'exactly the five synthetic folders must be open');
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension);
  const api=await extension.activate() as {refresh():void;status():{lastSavedAt:string|null}};
  const settings=vscode.workspace.getConfiguration('adiProjectTracker'),git=vscode.workspace.getConfiguration('git');
  const priorEmail=settings.inspect('ntEmail')?.globalValue,priorUrl=settings.inspect('serverUrl')?.globalValue,priorGit=git.inspect('path')?.globalValue;
  const result:Record<string,unknown>={platform:process.platform,arch:process.arch,host_pid:process.pid,plugin_version:extension.packageJSON.version,started_at:new Date().toISOString(),completed:false,api_history_verified:false};
  try{
    await git.update('path',expected.git,vscode.ConfigurationTarget.Global);
    assert.ok(vscode.workspace.isTrusted);
    await settings.update('serverUrl',nativeTestServer(),vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail','windows.multi@example.org',vscode.ConfigurationTarget.Global);api.refresh();
    const deadline=Date.now()+30000;
    while(api.status().lastSavedAt===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(api.status().lastSavedAt,'the actual host must receive at least one saved receipt');
    result.first_saved_at=api.status().lastSavedAt;
    await writeFile(join(owned,'native-windows-workspace-running.json'),JSON.stringify({...result,roots:expected.roots}));
    // Preserve this host/configuration across two real thirty-minute intervals with unchanged Git associations.
    await new Promise(resolve=>setTimeout(resolve,3610000));
    result.finished_at=new Date().toISOString();result.last_saved_at=api.status().lastSavedAt;
    result.elapsed_periods_wait_ms=3610000;result.completed=true;
  }catch(error){result.error=error instanceof Error?error.message:'windows_workspace_acceptance_failed';throw error;}
  finally{
    try{
      await settings.update('ntEmail',priorEmail,vscode.ConfigurationTarget.Global);
      await settings.update('serverUrl',priorUrl,vscode.ConfigurationTarget.Global);api.refresh();
      await git.update('path',priorGit,vscode.ConfigurationTarget.Global);
      assert.equal(git.inspect('path')?.globalValue,priorGit);result.git_setting_restored=true;
    }finally{await writeFile(join(owned,'native-windows-workspace-result.json'),JSON.stringify(result,null,2));}
  }
}
