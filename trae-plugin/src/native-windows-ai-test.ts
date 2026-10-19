import {nativeTestServer} from './native-test-config.js';
// Acceptance only: prepare/restore an unreachable backend for a real IDE chat.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

export async function run(restore=false){
  const root=join(tmpdir(),'plugin-acceptance-20261004','windows-isolated-workspace');
  const first=vscode.workspace.workspaceFolders?.[0];
  assert.ok(process.platform==='win32'&&process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'&&first?.uri.scheme==='file'&&resolve(first.uri.fsPath).toLowerCase()===resolve(root).toLowerCase()&&vscode.workspace.isTrusted);
  const expected=JSON.parse(await readFile(join(root,'expected.json'),'utf8')) as {roots:string[]};
  const normalize=(paths:string[])=>paths.map(path=>resolve(path).toLowerCase()).sort();
  assert.deepEqual(normalize((vscode.workspace.workspaceFolders??[]).map(folder=>folder.uri.fsPath)),normalize(expected.roots));
  const settings=vscode.workspace.getConfiguration('adiProjectTracker');
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension);
  const api=await extension.activate() as {refresh():void;status():{state:string}};
  if(restore){
    const previous=JSON.parse(await readFile(join(root,'native-ai-prior.json'),'utf8')) as {email?:string;url?:string};
    assert.ok(!previous.email&&previous.url===nativeTestServer());
    await settings.update('ntEmail',previous.email,vscode.ConfigurationTarget.Global);
    await settings.update('serverUrl',previous.url,vscode.ConfigurationTarget.Global);api.refresh();
    assert.equal(api.status().state,'needs_configuration');
  }else{
    const previous={email:settings.inspect('ntEmail')?.globalValue,url:settings.inspect('serverUrl')?.globalValue};
    assert.ok(!previous.email&&previous.url===nativeTestServer());
    await writeFile(join(root,'native-ai-prior.json'),JSON.stringify(previous));
    await settings.update('serverUrl','http://127.0.0.1:1',vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail','windows.ai@example.org',vscode.ConfigurationTarget.Global);api.refresh();
    const end=Date.now()+8000;while(api.status().state!=='unavailable'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(api.status().state,'unavailable');
  }
  await writeFile(join(root,restore?'native-ai-cleanup.json':'native-ai-ready.json'),JSON.stringify({completed:true,host_pid:process.pid,phase:restore?'cleanup':'ready',state:api.status().state,ai_response_verified:false}));
}
