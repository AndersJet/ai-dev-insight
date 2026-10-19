import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,readFile,writeFile,rm,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {createHash} from 'node:crypto';
import {zipSync,unzipSync} from 'fflate';
import {ensureHook,validatePersonalArchive} from '../src/hook-setup.js';
import {CollectionRecovery} from '../src/collection-recovery.js';
import {RuntimeControl} from '../src/runtime-control.js';

test('plugin reinstalls hooks after the personal configuration is cleared', {skip:!['darwin','win32'].includes(process.platform)}, async t=>{
  if(process.platform==='win32'){
    const previous=process.env.PSExecutionPolicyPreference;process.env.PSExecutionPolicyPreference='Restricted';
    t.after(()=>{if(previous===undefined)delete process.env.PSExecutionPolicyPreference;else process.env.PSExecutionPolicyPreference=previous;});
  }
  const directory=await mkdtemp(join(os.tmpdir(),'adi-plugin-hook-repair-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  t.mock.method(os,'homedir',()=>directory);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../scripts/package-hook-client.mjs',import.meta.url)),'--output',join(directory,'package')]);
  const files=unzipSync(await readFile(join(directory,'package','client.zip')));
  const server=createServer((request,response)=>{
    request.resume();
    if(request.url==='/api/v1/plugin/collection-grant'){
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({data:{authorization:'synthetic-grant',download_path:'/api/v1/plugin/collection-client',bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),version:'0.3.0'}}));
    }else if(request.url==='/api/v1/plugin/collection-client')response.end(archive);
    else response.writeHead(404).end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let archive=Buffer.from(zipSync({...files,'adi-installation.json':Buffer.from(JSON.stringify({installation_id:'a163f758-49a9-4d19-b713-0680c1810f66',token:'adi_'+'a'.repeat(43),endpoint:origin+'/hooks'}))}));
  const install=()=>ensureHook(origin,'synthetic-api-token','a'.repeat(64),join(directory,'storage'),new AbortController().signal,()=>{});
  assert.equal((await install()).state,'installed');
  const profile=join(directory,'.trae-cn'),path=join(profile,'hooks.json');
  const base=join(profile,'adi-native-collector'),state=join(directory,'storage','source.json');
  await mkdir(join(directory,'storage'),{recursive:true});
  await writeFile(state,'synthetic collector identity');
  for(const raw of ['{}','',' \n\t','{"version":1,"hooks":{}}','{"custom":{"preserved":true},"hooks":{"Stop":[]}}',undefined]){
    await t.test(`reinstall from ${raw===undefined?'deleted file':JSON.stringify(raw)}`,async()=>{
      const previous=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'));
      if(raw===undefined)await unlink(path);else await writeFile(path,raw);
      const repaired=await install();
      assert.equal(repaired.state,'installed',JSON.stringify(repaired));
      const hooks=JSON.parse(await readFile(path,'utf8'));
      assert.equal(Object.keys(hooks.hooks).length,6);
      assert.ok(Object.values(hooks.hooks).every(groups=>Array.isArray(groups)&&groups.length===1));
      if(raw?.includes('custom'))assert.deepEqual(hooks.custom,{preserved:true});
      assert.equal(await readFile(state,'utf8'),'synthetic collector identity');
      await assert.rejects(readFile(join(base,previous.release,'config.json')),{code:'ENOENT'});
      assert.equal((await install()).state,'ready');
    });
  }
  const original=JSON.parse(await readFile(path,'utf8'));
  const manifestRaw=await readFile(join(base,'manifest.json'),'utf8');
  const partial=structuredClone(original);delete partial.hooks.Stop;
  const modified=structuredClone(original);modified.hooks.Stop[0].hooks[0].timeout=5;
  const duplicate=structuredClone(original);duplicate.hooks.Stop.push(structuredClone(duplicate.hooks.Stop[0]));
  const unrelated={hooks:[{type:'command',command:'user-validator'}]};
  for(const [value,reason]of [
    [partial,'managed_hooks_modified'],[modified,'managed_hooks_modified'],[duplicate,'managed_hooks_modified'],
    [{hooks:{Stop:[unrelated]}},'managed_hooks_modified'],
    [{hooks:null},'unsupported_hooks_configuration'],[{hooks:[]},'unsupported_hooks_configuration'],
    [{hooks:{Stop:{}}},'unsupported_hooks_configuration'],[{version:2,hooks:{}},'unsupported_hooks_configuration'],
    [null,'unsupported_hooks_configuration'],[[],'unsupported_hooks_configuration'],
  ] as const){
    const raw=JSON.stringify(value);await writeFile(path,raw);
    assert.equal((await install()).reason,reason);
    assert.equal(await readFile(path,'utf8'),raw);
    assert.equal(await readFile(join(base,'manifest.json'),'utf8'),manifestRaw);
  }
  await writeFile(path,'{');assert.equal((await install()).state,'failed');assert.equal(await readFile(path,'utf8'),'{');
  const preserved=structuredClone(original);preserved.hooks.Stop.push(unrelated);
  await writeFile(path,JSON.stringify(preserved));assert.equal((await install()).state,'ready');
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).hooks.Stop.at(-1),unrelated);
  const release=JSON.parse(manifestRaw).release;
  for(const [name,reason]of [[process.platform==='win32'?'native-windows.ps1':'native-macos.js','managed_hook_files_modified'],['config.json','managed_hook_configuration_modified'],...(process.platform==='win32'?[['adi-sender.exe','managed_hook_files_modified']]:[])]){
    const target=join(base,release,name!),saved=await readFile(target);
    await writeFile(path,'{}');await writeFile(target,'manually modified');
    assert.equal((await install()).reason,reason);
    assert.equal(await readFile(path,'utf8'),'{}');await writeFile(target,saved);
  }
  await t.test('environment recovery repairs a real orphaned native installation without deleting project identity',async()=>{
    await writeFile(path,JSON.stringify(preserved));await unlink(join(base,'manifest.json'));
    const owner='a'.repeat(64),prepared={files:validatePersonalArchive(archive,{bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')},origin,owner),version:'0.3.0'};
    const recovery=new CollectionRecovery({profile,platform:process.platform==='win32'?'win32':'darwin'}),runtime=new RuntimeControl(join(profile,'adi-plugin-control'));
    const plan=await recovery.plan(owner,prepared,true);assert.ok(plan.issues.some(v=>v.includes('重建')));
    const result=await recovery.execute(plan,{signal:new AbortController().signal,current:()=>true,onChange:()=>{},pause:async()=>{},install:(material,recordWrites)=>ensureHook(origin,'synthetic-api-token',owner,join(directory,'storage'),new AbortController().signal,()=>{},{prepared:material,locked:true,recoverMissing:true,onInstalled:recordWrites}),resume:async()=>{assert.equal(await runtime.pulse(owner,true,{resume:true,recovery:true}),true);}});
    assert.equal(result.phase,'completed',JSON.stringify(result));assert.equal((await install()).state,'ready');
    assert.equal(await readFile(state,'utf8'),'synthetic collector identity');assert.equal(JSON.parse(await readFile(path,'utf8')).hooks.Stop.filter((group:unknown)=>JSON.stringify(group)===JSON.stringify(unrelated)).length,1);
  });
  await t.test('a real installer followed by resume failure retains the original backup and can retry',async()=>{
    const freshHome=join(directory,'fresh-home'),freshProfile=join(freshHome,'.trae-cn');await mkdir(freshProfile,{recursive:true});
    const {managedGroup}=await import('../src/collection-recovery.js');const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'];
    const original=JSON.stringify({hooks:Object.fromEntries(events.map(event=>[event,[managedGroup(freshProfile,'11111111-1111-4111-8111-111111111111',event,process.platform==='win32'?'win32':'darwin'),...(event==='Stop'?[unrelated]:[])]]))});await writeFile(join(freshProfile,'hooks.json'),original);
    t.mock.method(os,'homedir',()=>freshHome);syncBuiltinESMExports();
    try{
      const owner='a'.repeat(64),prepared={files:validatePersonalArchive(archive,{bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')},origin,owner),version:'0.3.0'},recovery=new CollectionRecovery({profile:freshProfile,platform:process.platform==='win32'?'win32':'darwin'}),runtime=new RuntimeControl(join(freshProfile,'adi-plugin-control'));
      const plan=await recovery.plan(owner,prepared,true),result=await recovery.execute(plan,{signal:new AbortController().signal,current:()=>true,onChange:()=>{},pause:async()=>{},install:(material,recordWrites)=>ensureHook(origin,'synthetic-api-token',owner,join(directory,'storage'),new AbortController().signal,()=>{},{prepared:material,locked:true,recoverMissing:true,onInstalled:recordWrites}),resume:async()=>{throw new Error('synthetic_resume_failure');}});
      assert.equal(result.phase,'failed',JSON.stringify(result));assert.equal(await readFile(join(recovery.paths(result).backup,'hooks.json'),'utf8'),original);
      const retry=await recovery.execute(await recovery.plan(owner,prepared,true),{signal:new AbortController().signal,current:()=>true,onChange:()=>{},pause:async()=>{},install:(material,recordWrites)=>ensureHook(origin,'synthetic-api-token',owner,join(directory,'storage'),new AbortController().signal,()=>{},{prepared:material,locked:true,onInstalled:recordWrites}),resume:async()=>{assert.equal(await runtime.pulse(owner,true,{resume:true,recovery:true}),true);}});
      assert.equal(retry.phase,'completed',JSON.stringify(retry));
    }finally{t.mock.method(os,'homedir',()=>directory);syncBuiltinESMExports();}
  });
  await t.test('explicit reset rebuilds damaged manifests, pending transactions, locks and partial hooks using the real installer',async()=>{
    const current=JSON.parse(await readFile(path,'utf8'));delete current.hooks.Stop;current.hooks.PreToolUse[0].hooks[0].timeout=99;await writeFile(path,JSON.stringify(current));
    await writeFile(join(base,'manifest.json'),'{');await writeFile(join(base,'pending.json'),'interrupted installation');await writeFile(join(profile,'adi-plugin-control/installation.json'),'{');await mkdir(join(profile,'adi-plugin-control/lock'),{recursive:true});await writeFile(join(profile,'adi-plugin-control/lock/unknown'),'residue');
    const owner='a'.repeat(64),prepared={files:validatePersonalArchive(archive,{bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')},origin,owner),version:'0.3.0'},recovery=new CollectionRecovery({profile,platform:process.platform==='win32'?'win32':'darwin'}),runtime=new RuntimeControl(join(profile,'adi-plugin-control'));
    const result=await recovery.execute(await recovery.plan(owner,prepared,true),{signal:new AbortController().signal,current:()=>true,onChange:()=>{},pause:async()=>{},install:(material,recordWrites)=>ensureHook(origin,'synthetic-api-token',owner,join(directory,'storage'),new AbortController().signal,()=>{},{prepared:material,locked:true,onInstalled:recordWrites}),resume:async()=>{assert.equal(await runtime.pulse(owner,true,{resume:true,recovery:true}),true);}});
    assert.equal(result.phase,'completed',JSON.stringify(result));assert.equal((await install()).state,'ready');assert.equal(await readFile(join(recovery.paths(result).backup,'adi-native-collector/manifest.json'),'utf8'),'{');assert.equal(await readFile(state,'utf8'),'synthetic collector identity');
  });
  await t.test('a slow background installer is not killed at thirty seconds and leaves the event loop responsive',{skip:process.platform!=='darwin'},async()=>{
    const saved=archive,slowFiles=unzipSync(archive);slowFiles['install-hook.sh']=Buffer.from(Buffer.from(slowFiles['install-hook.sh']!).toString().replace('\n','\nsleep 31\n'));
    archive=Buffer.from(zipSync(slowFiles));await writeFile(path,'{}');let ticks=0;const timer=setInterval(()=>{ticks++;},100);
    try{const started=performance.now();assert.equal((await install()).state,'installed');assert.ok(performance.now()-started>=31000);assert.ok(ticks>100,'installation must wait asynchronously, without blocking normal editor work');}
    finally{clearInterval(timer);archive=saved;}
  });
});
