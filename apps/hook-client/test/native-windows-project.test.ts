import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {unzipSync} from 'fflate';
import type {HookEnvelope} from '../../../packages/contracts/src/index.js';
import {managedRuntime} from './managed-runtime-fixture.js';
const execute=promisify(execFile),windows={skip:process.platform!=='win32'};
const installation='11111111-1111-4111-8111-111111111111';

async function fixture(t:TestContext) {
  const version=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()']);
  assert.match(version.stdout.trim(),/^5\.1\./,'this gate requires Windows PowerShell 5.1');
  const identity=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id);[string]$id.IsSystem+","+[string]$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']);
  assert.equal(identity.stdout.trim(),'False,False','employee acceptance requires a non-administrator user');
  const directory=join(tmpdir(),'adi-native-validation-'+randomUUID());await mkdir(directory);t.after(()=>rm(directory,{recursive:true,force:true}));
  const runtime=await managedRuntime(directory);
  const packageScript=fileURLToPath(new URL('../../../scripts/package-hook-client.mjs',import.meta.url));
  await execute(process.execPath,[packageScript,'--output',directory]);
  const files=unzipSync(await readFile(join(directory,'client.zip')));
  for(const[name,bytes]of Object.entries(files))await writeFile(join(directory,name),bytes);
  const received:HookEnvelope[]=[],wire:string[]=[];let mode='ok';
  const server=createServer((request,response)=>{
    let raw='';request.setEncoding('utf8');request.on('data',part=>{raw+=part;});
    request.on('end',()=>{wire.push(raw);received.push(JSON.parse(raw));if(mode==='ok')response.end();});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const credentials=join(directory,'credentials.json'),profile=join(directory,"profile 'quote $dollar");
  async function configure(token='adi_'+'a'.repeat(43)) {
    await writeFile(credentials,JSON.stringify({protocol_version:2,runtime_owner:runtime.owner,installation_id:installation,token,endpoint:'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/hooks'}));
  }
  async function install(action='install') {
    return execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(directory,'install-hook.ps1'),action,'-TraeDir',profile,'-Credentials',credentials],{timeout:20000});
  }
  await configure();await install();
  async function release() {
    const manifest=JSON.parse(await readFile(join(profile,'adi-native-collector','manifest.json'),'utf8'));
    return {manifest,path:join(profile,'adi-native-collector',manifest.release)};
  }
  async function send(cwd:string,end=true,rawOverride?:string,renewLease=true) {
    if(renewLease)await runtime.renew();
    const hooks=JSON.parse(await readFile(join(profile,'hooks.json'),'utf8')),command=hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{env:runtime.env});
    const start=performance.now(),exited=once(child,'exit');let out='',err='';
    child.stdout.on('data',part=>{out+=part;});child.stderr.on('data',part=>{err+=part;});child.stdin.on('error',()=>{});
    const stop=setTimeout(()=>child.kill(),2500);
    try{
      const raw=rawOverride??JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'windows-project',cwd,prompt:'中文，正文URL https://conversation.example.invalid/unrelated.git'});
      if(end)child.stdin.end(raw);else child.stdin.write(raw);
      const[code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);assert.equal(out,'');assert.equal(err,'');
      // This measures the installed PowerShell command, including its own
      // startup and CLR startup, against the actual Hook timeout. The native
      // executable still enforces its separate 750ms internal deadline.
      assert.ok(performance.now()-start<2000,'installed command exceeded its configured 2s Hook timeout');
    }finally{clearTimeout(stop);child.kill();}
    return received.at(-1);
  }
  return {runtime,directory,profile,received,wire,configure,install,release,send,stall:()=>{mode='stall';}};
}

test('Windows managed sender rejects paused, foreign and expired leases before delivery',windows,async t=>{
  const f=await fixture(t);
  const good=f.runtime.state.leases[0]!;
  for(const update of [{enabled:false},{enabled:true,owner:'b'.repeat(64)},{owner:f.runtime.owner,leases:[]},{leases:[{...good,expires_at:Date.now()-1}]},{leases:[{...good,expires_at:Date.now()+120000}]},{leases:[{...good,monotonic_issued_at:good.monotonic_issued_at-60000,monotonic_expires_at:good.monotonic_expires_at-60000}]},{version:1},{clock_kind:'unknown-clock'}]){
    await f.runtime.renew(update);await f.send(f.directory,true,undefined,false);assert.equal(f.received.length,0);
  }
  await f.runtime.renew({owner:f.runtime.owner,enabled:true});await f.send(f.directory);assert.equal(f.received.length,1);const resumed=f.received[0];assert.ok(resumed);assert.equal(resumed.schema_version,2);
});

test('Windows 5.1 installed sender observes all remotes and keeps identity through upgrade and credential reset',windows,async t=>{
  const f=await fixture(t),repo=join(f.directory,'项目 with spaces');
  await execute('git.exe',['init',repo]);
  await execute('git.exe',['-C',repo,'remote','add','Origin','https://user:synthetic-secret@HOST.example.invalid/Team/App.git?token=synthetic-secret']);
  await execute('git.exe',['-C',repo,'config','--add','remote.Origin.url','git@10.1.2.3:team/app.git']);
  await execute('git.exe',['-C',repo,'config','--add','remote.Origin.pushurl','ssh://push.example.invalid:2222/team/app.git']);
  await execute('git.exe',['-C',repo,'remote','add','alias','https://host.example.invalid/Team/App.git']);
  await execute('git.exe',['-C',repo,'remote','add','local','C:/local/repository']);
  await execute('git.exe',['-C',repo,'remote','add','local-copy','D:/another/repository']);
  const first=await f.send(repo);assert.ok(first?.project?.observation,'cold installed sender must deliver a real observation');
  assert.equal(first.project.platform,'windows');assert.equal(first.project.workspace,repo);assert.equal(first.project.observation.state,'repository');
  assert.deepEqual(first.project.observation.remotes,[
    {address:'https://host.example.invalid/Team/App.git'},
    {address:'10.1.2.3:team/app.git'},
    {address:'ssh://push.example.invalid:2222/team/app.git'},
    {address:null},
  ]);
  assert.equal(JSON.stringify(first.project).includes('synthetic-secret'),false);assert.equal(JSON.stringify(first.project).includes('conversation.example.invalid'),false);
  const cached=await f.send(repo);assert.deepEqual(cached?.project,first.project);
  const previous=await f.release();await f.install();
  assert.equal((await f.send(repo))?.project?.collector_id,first.project.collector_id);
  await assert.rejects(readFile(join(previous.path,'adi-sender.exe')),{code:'ENOENT'});
  await f.configure('adi_'+'b'.repeat(43));await f.install();
  const rotated=await f.send(repo);assert.equal(rotated?.project?.collector_id,first.project.collector_id);assert.equal(rotated?.project?.observation?.sequence,'2');
  const release=await f.release();assert.equal(release.manifest.version,3);
  const acl="$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$bad=@((Get-Acl -LiteralPath '"+release.path.replaceAll("'","''")+"').GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid});if($bad.Count){exit 1}";
  const permissions=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',acl]);assert.equal(permissions.stderr,'');
});

test('Windows sender bounds unfinished stdin and HTTP stalls while delivering nonGit evidence',windows,async t=>{
  const f=await fixture(t),project=join(f.directory,'non-git');await mkdir(project);
  const first=await f.send(project);assert.equal(first?.project?.observation?.state,'not_git');
  const raw='{"hook_event_name":"Stop","session_id":"windows-raw","cwd":'+JSON.stringify(project)+',"n":9007199254740993,"A":1,"a":2,"text":"中文"}';
  await f.send(project,true,raw);assert.ok(f.wire.at(-1)?.endsWith('"payload":'+raw+'}'),'compiled wrapper must preserve exact raw JSON');
  f.stall();const count=f.received.length;await f.send(project);assert.equal(f.received.length,count+1);
  await f.send(project,false);assert.equal(f.received.length,count+1,'unfinished input must not publish a partial event');
});

test('Windows process boundary kills descendants after normal root exit and timeout',windows,async t=>{
  const f=await fixture(t),release=await f.release();
  const check=fileURLToPath(new URL('../../../scripts/test/native-windows-process-tree.ps1',import.meta.url));
  const answer=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',check,'-Root',f.directory,'-Sender',join(release.path,'adi-sender.exe')],{timeout:20000});
  assert.equal(answer.stderr,'');
  assert.match(answer.stdout,/passed: ordinary user Job boundary kills started descendants after root exit and timeout/);
});
