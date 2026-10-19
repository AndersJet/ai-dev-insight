import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

export async function run(){
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension,'extension must be present in the actual host');
  const settings=vscode.workspace.getConfiguration('adiProjectTracker');
  const priorEmail=settings.inspect('ntEmail')?.globalValue,priorUrl=settings.inspect('serverUrl')?.globalValue;
  const results:Record<string,unknown>={platform:process.platform,arch:process.arch,host_pid:process.pid,plugin_version:extension.packageJSON.version,started_at:new Date().toISOString(),node:process.version,vscode:vscode.version,trusted:vscode.workspace.isTrusted};
  const api=await extension.activate() as {status():{state:string;lastSavedAt:string|null;queued:number};refresh():void};
  try{
    await settings.update('ntEmail','',vscode.ConfigurationTarget.Global);api.refresh();assert.equal(api.status().state,'needs_configuration');results.empty_email_gate=true;
    await settings.update('serverUrl',process.env.ADI_PLUGIN_TEST_SERVER??'http://127.0.0.1:4194',vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail',process.platform==='win32'?'windows.native@example.org':'mac.native@example.org',vscode.ConfigurationTarget.Global);
    api.refresh();const until=Date.now()+30000;while(!api.status().lastSavedAt&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
    assert.ok(api.status().lastSavedAt,'actual IDE must receive a durable report confirmation');results.durable_report=true;
    const folder=vscode.workspace.workspaceFolders?.[0];assert.ok(folder,'fixture folder must be open');
    const document=await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri,'fixture.txt'));await vscode.window.showTextDocument(document);
    await settings.update('serverUrl','http://127.0.0.1:1',vscode.ConfigurationTarget.Global);api.refresh();
    const started=performance.now(),edit=new vscode.WorkspaceEdit();edit.insert(document.uri,new vscode.Position(document.lineCount,0),'Synthetic edit during backend failure.\n');
    assert.ok(await vscode.workspace.applyEdit(edit));assert.ok(await document.save());results.edit_save_during_failure_ms=performance.now()-started;
    await new Promise(r=>setTimeout(r,3500));results.failure_state=api.status().state;assert.notEqual(api.status().state,'active');
    results.completed=true;
  }catch(e){results.completed=false;results.error=e instanceof Error?e.message:'native_test_failed';throw e;}
  finally{
    await settings.update('ntEmail',priorEmail,vscode.ConfigurationTarget.Global);await settings.update('serverUrl',priorUrl,vscode.ConfigurationTarget.Global);api.refresh();
    if(process.env.ADI_PLUGIN_TEST_RESULT)await writeFile(process.env.ADI_PLUGIN_TEST_RESULT,JSON.stringify(results,null,2));
  }
}
