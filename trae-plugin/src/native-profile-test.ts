// Acceptance-only CPU sampling. It neither ships nor adds runtime diagnostics.
import * as vscode from 'vscode';
import {Session,type Profiler} from 'node:inspector';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export async function run(){
  const workspace=vscode.workspace.workspaceFile;
  assert.ok(workspace&&workspace.fsPath.includes('/plugin-acceptance/mac-multi/'),'only the owned synthetic workspace is permitted');
  assert.ok(vscode.workspace.isTrusted);
  const extension=vscode.extensions.getExtension('ai-dev-insight.adi-project-tracker');assert.ok(extension);
  const api=await extension.activate() as {refresh():void};
  const settings=vscode.workspace.getConfiguration('adiProjectTracker'),priorEmail=settings.inspect('ntEmail')?.globalValue,priorUrl=settings.inspect('serverUrl')?.globalValue;
  const directory=dirname(workspace.fsPath),session=new Session();session.connect();
  const post=<T>(method:string,params:Record<string,unknown>={})=>new Promise<T>((resolve,reject)=>session.post(method,params,(error,value)=>error?reject(error):resolve(value as T)));
  const results:Record<string,unknown>={platform:process.platform,arch:process.arch,host_pid:process.pid,completed:false,full_resource_gate_passed:false};
  try{
    await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');
    await settings.update('serverUrl','http://127.0.0.1:4195',vscode.ConfigurationTarget.Global);
    await settings.update('ntEmail','mac.profile@example.org',vscode.ConfigurationTarget.Global);api.refresh();
    await writeFile(join(directory,'native-profile-running.json'),JSON.stringify({host_pid:process.pid,started_at:new Date().toISOString(),duration_seconds:620}));
    // Ten-minute resource sample: covers initial collection and idle time, not the thirty-minute probe deadline.
    await new Promise(resolve=>setTimeout(resolve,620000));
    const {profile}=await post<{profile:Profiler.Profile}>('Profiler.stop');
    const nodes=new Map(profile.nodes.map(node=>[node.id,node])),parents=new Map<number,number>();
    for(const node of profile.nodes)for(const child of node.children??[])parents.set(child,node.id);
    const owned=new Set(profile.nodes.filter(node=>node.callFrame.url.includes('ai-dev-insight.adi-project-tracker')&&node.callFrame.url.endsWith('/dist/extension.cjs')).map(node=>node.id));
    const inPlugin=(id:number)=>{let current:number|undefined=id;while(current!==undefined){if(owned.has(current))return true;current=parents.get(current);}return false;};
    let runMicros=0,maximum=0,ownSamples=0;const segments:number[]=[];
    for(let index=0;index<(profile.samples?.length??0);index++){
      const id=profile.samples![index]!,delta=profile.timeDeltas?.[index]??1000;
      if(inPlugin(id)){ownSamples++;runMicros+=delta;}
      else if(runMicros){segments.push(runMicros/1000);maximum=Math.max(maximum,runMicros);runMicros=0;}
    }
    if(runMicros){segments.push(runMicros/1000);maximum=Math.max(maximum,runMicros);}
    results.own_sample_count=ownSamples;results.maximum_sampled_contiguous_run_ms=maximum/1000;results.sampled_runs_ms=segments;
    results.own_frames=[...owned].map(id=>{const frame=nodes.get(id)!.callFrame;return {function:frame.functionName,line:frame.lineNumber+1};});
    results.limitations=['sampling is not exact callback instrumentation','Git subprocess CPU and RSS are outside this profile','normal five-root Mac scenario only'];
    assert.ok(ownSamples>0,'without own samples this profile proves no plugin timing');
    assert.ok(maximum/1000<=20,'observed plugin synchronous run exceeded the twenty-millisecond budget');results.completed=true;
  }catch(error){results.error=error instanceof Error?error.message:'native_profile_failed';throw error;}
  finally{
    try{await post('Profiler.stop');await post('Profiler.disable');}catch{/* may already be stopped */}session.disconnect();
    await settings.update('ntEmail',priorEmail,vscode.ConfigurationTarget.Global);await settings.update('serverUrl',priorUrl,vscode.ConfigurationTarget.Global);api.refresh();
    await writeFile(join(directory,'native-profile-result.json'),JSON.stringify(results,null,2));
  }
}
