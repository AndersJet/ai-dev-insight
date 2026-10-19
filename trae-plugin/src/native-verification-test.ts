/** Controlled acceptance only: synthetic account/server/profile; never shipped in VSIX. */
import assert from 'node:assert/strict';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {zipSync,unzipSync} from 'fflate';
import {InstallationVerification,VERIFICATION_DURATION} from './installation-verification.js';
import {verificationEnvironment} from './verification-environment.js';
import {RuntimeControl} from './runtime-control.js';
import {ensureHook} from './hook-setup.js';
import {platformRequest} from './platform-session.js';
import {diagnosticOperation} from './diagnostics.js';
export async function runVerificationAcceptance(base:string,appRoot:string,core:string){
  assert.ok(base.includes('verification-acceptance'),'Owned fixture directory required');
  const directory=await mkdtemp(join(base,'owned-')),previousHome=os.homedir,previousEnv=process.env[process.platform==='win32'?'USERPROFILE':'HOME'];os.homedir=()=>directory;syncBuiltinESMExports();process.env[process.platform==='win32'?'USERPROFILE':'HOME']=directory;
  const profile=join(directory,'.trae-cn'),control=join(profile,'adi-plugin-control');await mkdir(profile);
  const rows:Record<string,unknown>[]=[],record=(value:Record<string,unknown>)=>{rows.push(value);};
  const files=unzipSync(await readFile(join(base,'client.zip'))),scope='a'.repeat(64),userId='a163f758-49a9-4d19-b713-0680c1810f66';let hooks=0,hookStatus=200;
  const server=createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');if(req.url==='/hooks'){hooks++;res.writeHead(hookStatus);res.end();}
    else if(req.url==='/api/v1/plugin/collection-grant')res.end(JSON.stringify({data:{authorization:'synthetic-grant',download_path:'/api/v1/plugin/collection-client',bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),version:'0.3.1'}}));
    else if(req.url==='/api/v1/plugin/collection-client')res.end(archive);
    else if(req.url==='/api/v1/plugin/me')res.end(JSON.stringify({data:{user_id:userId,email:'synthetic@example.invalid'}}));
    else if(req.url==='/api/v1/plugin/today')res.end(JSON.stringify({data:{official_chat_tokens:null,official_cue_tokens:'0',hook_sessions:0,prompt_turns:0}}));else res.end(JSON.stringify({data:null}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const archive=Buffer.from(zipSync({...files,'adi-installation.json':Buffer.from(JSON.stringify({installation_id:userId,token:'adi_'+'a'.repeat(43),endpoint:origin+'/hooks'}))}));
  const runtime=new RuntimeControl(control);let now=Date.now();const options={directory:join(directory,'storage'),control,environment:()=>verificationEnvironment(appRoot,core,'1.0.3','c'.repeat(64)),onChange:()=>{},now:()=>now};let manager=new InstallationVerification(options);
  const install=()=>ensureHook(origin,'synthetic-api-token',scope,options.directory,new AbortController().signal,status=>manager.event('hook.status.'+status.state));
  const send=async()=>{const manifest=JSON.parse(await readFile(join(profile,'adi-native-collector','manifest.json'),'utf8')),release=join(profile,'adi-native-collector',manifest.release);let config=join(release,'config.json');
    const input=JSON.stringify({session_id:'synthetic-session',hook_event_name:'UserPromptSubmit',prompt:'PRIVATE_SYNTHETIC_PROMPT'}),started=Date.now();
    const executable=process.platform==='win32'?join(release,'adi-hook.exe'):'/bin/bash';const args=process.platform==='win32'?[config]:[join(release,'send-hook.sh'),config];
    // Installer binary name is verified from the managed Hook command below.
    if(process.platform==='win32'){const names=await readdir(release);const binary=names.find(n=>n.endsWith('.exe'));assert.ok(binary);config=join(release,binary);}
    const result=await new Promise<{code:number|null;stdout:string}>((resolve,reject)=>{const child=execFile(process.platform==='win32'?config:executable,args,{timeout:1800,maxBuffer:4096,windowsHide:true,env:process.env},(error,stdout)=>{if(error&&error.killed)reject(new Error('native_budget_failed'));else resolve({code:typeof error?.code==='number'?error.code:0,stdout});});child.stdin?.end(input);});
    assert.equal(result.code,0);assert.equal(result.stdout,'');record({step:'native_hook',elapsed_ms:Date.now()-started});await new Promise(resolve=>setTimeout(resolve,100));
  };
  const flushShutdown=async()=>{await manager.dispose();const until=Date.now()+10000;while(await lstat(join(control,'verification.lock')).then(()=>true,()=>false)){assert.ok(Date.now()<until,'flush shutdown');await new Promise(resolve=>setTimeout(resolve,10));}};
  try{
    assert.equal(manager.snapshot(),null);await manager.start(scope);record({step:'start',id:manager.snapshot()!.id});assert.equal(await runtime.pulse(scope,true,{resume:true}),true);
    const installed=await install();assert.equal(installed.state,'installed');manager.setCheck('hook',true);record({step:'install',state:installed.state});
    await platformRequest(origin,'/api/v1/plugin/me',new AbortController().signal);manager.setCheck('account',true);assert.equal((await platformRequest(origin,'/api/v1/plugin-releases/current',new AbortController().signal)).data,null);manager.setCheck('version',true);await platformRequest(origin,'/api/v1/plugin/today',new AbortController().signal);manager.setCheck('statistics',true);
    manager.confirm('global');manager.confirm('local');const first=manager.snapshot()!;await flushShutdown();manager=new InstallationVerification(options);await manager.restore();assert.equal(manager.snapshot()?.id,first.id);assert.equal(manager.snapshot()?.deadline,first.deadline);assert.equal(manager.snapshot()?.confirmed.local,true);record({step:'restart_resume',same_id:true,same_deadline:true});
    await runtime.pulse(scope,true);await send();assert.ok(hooks>0);assert.equal(manager.snapshot()?.canPass,false,'HTTP200 is not persisted receipt');
    manager.confirm('session');assert.equal(manager.snapshot()?.canPass,true);const successfulLog=manager.snapshot()!.logPath;await manager.finish('passed');await assert.rejects(readFile(successfulLog));record({step:'passed',details_deleted:true});
    await manager.start(scope);await runtime.pulse(scope,true);await writeFile(join(profile,'hooks.json'),'{}');const retried=await install();assert.equal(retried.state,'installed');await runtime.pulse(scope,true);hookStatus=503;await send();const failed=diagnosticOperation('account.login');failed(new Error('PRIVATE_SYNTHETIC_PASSWORD COOKIE_TOKEN'));await manager.finish('failed');const failureLog=await readFile(manager.snapshot()!.logPath,'utf8');assert.match(failureLog,/hook.entry/);assert.match(failureLog,/hook.response/);assert.match(failureLog,/503/);assert.doesNotMatch(failureLog,/PRIVATE_SYNTHETIC|COOKIE_TOKEN|Bearer |adi_aaaa/);record({step:'failed',retry:retried.state,native_response_recorded:true,redacted:true,log:manager.snapshot()!.logPath});
    await manager.start(scope);now+=VERIFICATION_DURATION+1;await manager.finish('passed');assert.equal(manager.snapshot()?.result,'unconfirmed');record({step:'timeout',result:'unconfirmed'});
    const retained=(await readdir(manager.logDirectory)).filter(n=>n.endsWith('.jsonl'));assert.equal(retained.length,2);record({step:'retention',files:retained.length});record({step:'environment',...await options.environment()});record({step:'complete',ok:true});
  }catch{record({step:'complete',ok:false});throw new Error('verification_acceptance_failed');}
  finally{await manager.dispose();await runtime.close(scope).catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));os.homedir=previousHome;syncBuiltinESMExports();if(previousEnv===undefined)delete process.env[process.platform==='win32'?'USERPROFILE':'HOME'];else process.env[process.platform==='win32'?'USERPROFILE':'HOME']=previousEnv;await writeFile(join(base,'result-'+process.platform+'.json'),JSON.stringify(rows,null,2));}
}
