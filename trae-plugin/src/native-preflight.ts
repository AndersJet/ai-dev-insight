// Acceptance helper only; never bundled into the employee extension.
import * as vscode from 'vscode';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

export function activate(context:vscode.ExtensionContext){
  if(process.platform!=='win32')return;
  const owned=join(tmpdir(),'plugin-acceptance-20261004',process.env.ADI_PLUGIN_ACCEPT_ISOLATED==='1'?'windows-isolated-workspace':'windows-workspace');
  const timer=setTimeout(()=>void (async()=>{
    // The fixture must already exist; do not create or write in user projects.
    const fixture=JSON.parse(await readFile(join(owned,'fixture-test.json'),'utf8')) as {git?:string};
    const folders=vscode.workspace.workspaceFolders??[];
    const first=folders[0];
    const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');
    const git=vscode.workspace.getConfiguration('git').inspect<string>('path')?.globalValue;
    const result={host_pid:process.pid,observed_at:new Date().toISOString(),helper_version:String(context.extension.packageJSON.version),
      owned_fixture:folders.length>0&&first!==undefined&&first.uri.scheme==='file'&&resolve(first.uri.fsPath).toLowerCase()===resolve(owned).toLowerCase()&&folders.every(folder=>folder.uri.scheme==='file'&&resolve(folder.uri.fsPath).toLowerCase().startsWith(resolve(owned,'..').toLowerCase()+'\\')),
      workspace_count:folders.length,trusted:vscode.workspace.isTrusted,
      business_present:extension!==undefined,business_active:extension?.isActive??false,
      business_version:extension?.packageJSON.version??null,
      nt_configured:Boolean(vscode.workspace.getConfiguration('adiProjectTracker').inspect<string>('ntEmail')?.globalValue),
      git_global_defined:git!==undefined,git_is_fixture:fixture.git!==undefined&&git===fixture.git};
    await writeFile(join(owned,`preflight-${process.pid}.json`),JSON.stringify(result,null,2));
  })().catch(()=>{/* unavailable preflight is not a pass */}),5000);
  context.subscriptions.push({dispose:()=>clearTimeout(timer)});
}
