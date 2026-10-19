// Acceptance only. Phase input and results stay in the owned synthetic workspace.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {PluginProject} from '../../packages/contracts/src/plugin-tracking.js';

export async function run(){
  const workspace=vscode.workspace.workspaceFile;
  assert.ok(workspace&&workspace.fsPath.includes('/plugin-acceptance/mac-multi/'),'only the owned synthetic workspace is permitted');
  const directory=dirname(workspace.fsPath),input=JSON.parse(await readFile(join(directory,'lifecycle-input.json'),'utf8')) as {phase:'configure'|'upgrade'|'disabled'|'uninstalled'|'cleanup'};
  assert.ok(['configure','upgrade','disabled','uninstalled','cleanup'].includes(input.phase));
  const base='http://127.0.0.1:4195',email='mac.lifecycle@example.org',extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');
  const result:Record<string,unknown>={phase:input.phase,host_pid:process.pid,completed:false};
  const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'plugin-accept@example.invalid',password:'plugin-accept-synthetic-password'}),signal:AbortSignal.timeout(5000)});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  async function projects(){const response=await fetch(base+'/api/v1/plugin/projects?'+new URLSearchParams({nt_email:email,limit:'100'}),{headers:{cookie},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return ((await response.json()) as {data:{items:PluginProject[]}}).data.items;}
  async function wait(predicate:()=>Promise<boolean>,limit=30000){const end=Date.now()+limit;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('actual lifecycle condition did not arrive');}
  try{
    if(input.phase==='configure'){
      assert.ok(extension&&vscode.workspace.isTrusted);const settings=vscode.workspace.getConfiguration('adiProjectTracker');
      const previous={email:settings.inspect('ntEmail')?.globalValue,url:settings.inspect('serverUrl')?.globalValue};
      await writeFile(join(directory,'lifecycle-prior-settings.json'),JSON.stringify(previous));
      await settings.update('serverUrl',base,vscode.ConfigurationTarget.Global);await settings.update('ntEmail',email,vscode.ConfigurationTarget.Global);
      const api=await extension.activate() as {refresh():void};api.refresh();
      await wait(async()=>(await projects()).filter(item=>item.workspace_path.includes('/mac-multi/')).length>=4);
      const found=await projects();await writeFile(join(directory,'lifecycle-before.json'),JSON.stringify(found,null,2));result.projects=found;result.version=extension.packageJSON.version;
    }else if(input.phase==='upgrade'){
      assert.ok(extension);assert.equal(extension.packageJSON.version,'0.1.1');
      await wait(async()=>extension.isActive&&(await projects()).some(item=>item.latest?.plugin_version==='0.1.1'));
      const previous=JSON.parse(await readFile(join(directory,'lifecycle-before.json'),'utf8')) as PluginProject[],found=await projects();
      for(const old of previous){const current=found.find(item=>item.workspace_path===old.workspace_path);assert.ok(current);assert.equal(current.collector_id,old.collector_id);assert.ok(current.latest);assert.ok(old.latest);assert.ok(BigInt(current.latest.sequence)>BigInt(old.latest.sequence));assert.equal(current.latest.plugin_version,'0.1.1');}
      const settings=vscode.workspace.getConfiguration('adiProjectTracker');assert.equal(settings.inspect('ntEmail')?.globalValue,email);assert.equal(settings.inspect('serverUrl')?.globalValue,base);
      result.projects=found;result.source_and_sequence_continuous=true;
    }else if(input.phase==='cleanup'){
      const previous=JSON.parse(await readFile(join(directory,'lifecycle-prior-settings.json'),'utf8')) as {email?:string;url?:string};
      const settings=vscode.workspace.getConfiguration('adiProjectTracker');
      assert.ok(!previous.email&&[undefined,'http://127.0.0.1:1','http://127.0.0.1:4194','http://127.0.0.1:4195'].includes(previous.url),'cleanup only removes this task\'s synthetic settings');
      await settings.update('ntEmail',undefined,vscode.ConfigurationTarget.Global);await settings.update('serverUrl',undefined,vscode.ConfigurationTarget.Global);
      assert.equal(settings.inspect('ntEmail')?.globalValue,undefined);assert.equal(settings.inspect('serverUrl')?.globalValue,undefined);result.synthetic_settings_removed=true;
    }else{
      if(input.phase==='disabled')assert.ok(!extension||!extension.isActive,'a disabled extension must not be active');else assert.equal(extension,undefined);
      const before=await projects();assert.ok(before.length>0);await new Promise(resolve=>setTimeout(resolve,320000));
      const after=await projects();assert.deepEqual(after,before,'stopped extension must not add observations or remove saved history');
      result.retained_projects=after.length;result.no_new_observations_for_seconds=320;
    }
    result.completed=true;
  }catch(error){result.error=error instanceof Error?error.message:'lifecycle_failed';throw error;}
  finally{await writeFile(join(directory,`native-lifecycle-${input.phase}.json`),JSON.stringify(result,null,2));}
}
