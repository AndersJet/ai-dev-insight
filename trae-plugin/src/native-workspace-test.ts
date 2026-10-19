// Acceptance-only suite. Never included in the employee VSIX.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {PluginProject} from '../../packages/contracts/src/plugin-tracking.js';

interface Expected {
  roots:string[];root:string;sub:string;worktree:string;plain:string;empty:string;closed:string;
}

export async function run(){
  const workspace=vscode.workspace.workspaceFile;
  assert.ok(workspace?.scheme==='file'&&workspace.fsPath.includes('/plugin-acceptance/mac-multi/'),'only the owned synthetic workspace is permitted');
  const directory=dirname(workspace.fsPath),expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8')) as Expected;
  assert.deepEqual((vscode.workspace.workspaceFolders??[]).map(folder=>folder.uri.fsPath).sort(),[...expected.roots].sort());
  assert.equal(vscode.workspace.isTrusted,true,'the real workspace must be trusted before collection');
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension);
  const settings=vscode.workspace.getConfiguration('adiProjectTracker');
  const priorEmail=settings.inspect('ntEmail')?.globalValue,priorUrl=settings.inspect('serverUrl')?.globalValue;
  const api=await extension.activate() as {refresh():void};
  const base='http://127.0.0.1:4195',email='mac.multi@example.org';
  const results:Record<string,unknown>={platform:process.platform,arch:process.arch,vscode:vscode.version,host_pid:process.pid,completed:false};
  let cookie='';
  async function projects(){
    const response=await fetch(base+'/api/v1/plugin/projects?'+new URLSearchParams({nt_email:email,limit:'100'}),{headers:{cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const body=await response.json() as {data:{items:PluginProject[]}};
    return body.data.items.filter(item=>expected.roots.includes(item.workspace_path)||item.workspace_path.startsWith(expected.root+'/'));
  }
  try{
    await settings.update('serverUrl',base,vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail',email,vscode.ConfigurationTarget.Global);api.refresh();
    const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'plugin-accept@example.invalid',password:'plugin-accept-synthetic-password'}),signal:AbortSignal.timeout(5000)});
    assert.equal(login.status,200);cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    let found:PluginProject[]=[];const deadline=Date.now()+30000;
    while(Date.now()<deadline){found=await projects();if(found.length===expected.roots.length)break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.deepEqual(found.map(item=>item.workspace_path).sort(),[...expected.roots].sort(),'all opened roots, and no unopened nested repository, must be reported');
    for(const path of [expected.root,expected.sub,expected.worktree]){
      const latest=found.find(item=>item.workspace_path===path)!.latest;assert.ok(latest);
      assert.equal(latest.state,'repository');assert.equal(latest.git_root,path===expected.sub?expected.root:path);
      assert.deepEqual(latest.remotes,[
        {name:'mirror',direction:'fetch',address:'https://git.example.invalid/plugin/mirror.git'},
        {name:'mirror',direction:'push',address:'https://git.example.invalid/plugin/mirror.git'},
        {name:'origin',direction:'fetch',address:'https://git.example.invalid/plugin/multi.git'},
        {name:'origin',direction:'push',address:'ssh://git.example.invalid/plugin/multi-push.git'},
      ]);
    }
    assert.equal(found.find(item=>item.workspace_path===expected.plain)!.latest?.state,'not_git');
    assert.equal(found.find(item=>item.workspace_path===expected.empty)!.latest?.state,'no_remote');
    assert.ok(!JSON.stringify(found).includes('synthetic-secret'));
    const retained=await readFile(workspace.fsPath,'utf8');assert.ok(retained.includes('workspace-injection@example.invalid'),'the workspace override fixture must remain present');
    results.projects=found;results.workspace_overrides_ignored=true;results.unopened_nested_ignored=true;results.completed=true;
  }catch(error){results.error=error instanceof Error?error.message:'workspace_acceptance_failed';throw error;}
  finally{
    await settings.update('ntEmail',priorEmail,vscode.ConfigurationTarget.Global);
    await settings.update('serverUrl',priorUrl,vscode.ConfigurationTarget.Global);api.refresh();
    await writeFile(join(directory,'native-workspace-result.json'),JSON.stringify(results,null,2));
  }
}
