import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,realpath,readdir,stat,statfs,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import type {HookEnvelope} from '../../../packages/contracts/src/index.js';
import {managedRuntime} from './managed-runtime-fixture.js';
const execute=promisify(execFile),source=new URL('../native/',import.meta.url);
const installation='11111111-1111-4111-8111-111111111111';
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};

async function fixture(t:TestContext,profileParent?:string,slowRead=false){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'adi-native-project-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runtime=await managedRuntime(directory);
  for(const name of ['install-hook.sh','send-hook.sh'])await writeFile(join(directory,name),await readFile(new URL(name,source)));
  let nativeSource=await readFile(new URL('macos.js',source),'utf8');
  if(slowRead){
    // Delay only the filesystem boundary in this temporary test artifact.
    // No delay switch is added to production source or release packages.
    const anchor='function read(path, maximum) {';assert.equal(nativeSource.split(anchor).length,2);
    const delay=`
    var testEnv=ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
    function testDelay(path,mode){
      if(mode==='read'&&testEnv.ADI_TEST_DISK_MODE==='before-git'&&path.endsWith('/identity.json'))$.NSThread.sleepForTimeInterval(0.25);
      if(path.indexOf('/project-state/')!==-1&&(testEnv.ADI_TEST_DISK_MODE===mode||(mode==='read'&&testEnv.ADI_TEST_DISK_MODE==='fast-fail'))){
        $(mode+':'+$.NSProcessInfo.processInfo.processIdentifier).writeToFileAtomicallyEncodingError($(testEnv.ADI_TEST_DISK_MARKER),false,$.NSUTF8StringEncoding,null);
        if(testEnv.ADI_TEST_DISK_MODE==='fast-fail')throw new Error('test_read_failed');
        $.NSThread.sleepForTimeInterval(2.5);
      }
    }`;
    nativeSource=nativeSource.replace('  function read(path, maximum) {',delay+'\n  function read(path, maximum) { testDelay(path,"read");');
    nativeSource=nativeSource.replace('  function write(path, value, replace) {','  function write(path, value, replace) { testDelay(path,"write");');
    nativeSource=nativeSource.replace('      void file.synchronizeFile;', '      testDelay(path,"flush"); void file.synchronizeFile;');
  }
  await writeFile(join(directory,'native-macos.js'),await readFile(new URL('core.js',source),'utf8')+'\n'+nativeSource);
  const received:HookEnvelope[]=[];
  const server=createServer((request,response)=>{let body='';request.setEncoding('utf8');request.on('data',part=>{body+=part;});request.on('end',()=>{received.push(JSON.parse(body));response.end();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const credentials=join(directory,'credentials.json'),profile=profileParent?join(profileParent,'profile-'+randomUUID()):join(directory,'profile');
  if(profileParent)t.after(()=>rm(profile,{recursive:true,force:true}));
  const configure=async(token='adi_'+'a'.repeat(43))=>writeFile(credentials,JSON.stringify({installation_id:installation,token,endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`,protocol_version:2,runtime_owner:runtime.owner}),{mode:0o600});
  await configure();
  const install=()=>execute('/bin/bash',[join(directory,'install-hook.sh'),'install','--trae-dir',profile,'--credentials',credentials],{env:gitEnv});await install();
  const git=(...args:string[])=>execute('/usr/bin/git',args,{env:gitEnv});
  async function send(cwd:string,extra:Record<string,unknown>={},environment:NodeJS.ProcessEnv={},renewLease=true){
    if(renewLease)await runtime.renew();
    const configuration=JSON.parse(await readFile(join(profile,'hooks.json'),'utf8')),command=configuration.hooks.UserPromptSubmit[0].hooks[0].command;
    const child=spawn('/bin/bash',['-c',command],{env:{...gitEnv,...environment,HOME:directory,USERPROFILE:directory}});const start=performance.now(),exited=once(child,'exit');let output='',errors='';
    child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{errors+=data;});child.stdin.on('error',()=>{});const timeout=setTimeout(()=>child.kill('SIGKILL'),2000);
    try{child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'native-project-session',cwd,...extra}));const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);assert.equal(output,'');assert.equal(errors,'');assert.ok(performance.now()-start<1200);}
    finally{clearTimeout(timeout);child.kill('SIGKILL');}
    return received.at(-1);
  }
  return {directory,profile,received,configure,install,git,send,runtime};
}

test('installed macOS Hook rejects paused runtime before Git and network work',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),bin=join(f.directory,'guard-git'),calls=join(f.directory,'guard-git-calls');await mkdir(bin);
  await writeFile(join(bin,'git'),'#!/bin/bash\nprintf "probe\\n" >> "$ADI_TEST_CALLS"\nexit 1\n',{mode:0o700});
  await f.runtime.renew({enabled:false});await f.send(f.directory,{}, {PATH:bin+':/usr/bin:/bin',ADI_TEST_CALLS:calls});
  assert.equal(f.received.length,0,'a paused runtime must not transmit a normal Hook');
  await assert.rejects(readFile(calls),{code:'ENOENT'},'a paused runtime must not probe Git');
});

test('runtime generation establishes new project evidence without resetting the collector sequence',async()=>{
  const text=await readFile(new URL('core.js',source),'utf8'),core=runInNewContext(text+'\nADI;'),files=new Map<string,string>();
  let address='https://before.example.invalid/app.git',probes=0;
  const settings={installation_id:installation,token:'adi_'+'a'.repeat(43),endpoint:'http://example.invalid/hooks',runtime_generation:randomUUID()};
  const io={root:'/state',platform:'macos',uuid:randomUUID,hash:(value:string)=>createHash('sha256').update(value).digest('hex'),now:()=>Date.parse('2026-10-09T00:00:00Z'),tick:()=>1000,read:(path:string)=>files.get(path)??null,atomic:(path:string,value:string)=>{files.set(path,value);},directory:()=>{},lock:()=>()=>{},probe:()=>{probes++;return {state:'repository',reason:null,git_root:'/workspace',remotes:[{address}]};}};
  const first=JSON.parse(JSON.stringify(core.project(io,settings,{cwd:'/workspace'})));assert.equal(first.observation.sequence,'1');
  address='https://after.example.invalid/app.git';settings.runtime_generation=randomUUID();
  const next=JSON.parse(JSON.stringify(core.project(io,settings,{cwd:'/workspace'})));assert.equal(next.collector_id,first.collector_id);assert.equal(next.observation.sequence,'2');assert.deepEqual(next.observation.remotes,[{address:'https://after.example.invalid/app.git'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(core.project(io,settings,{cwd:'/workspace'}))),next);assert.equal(probes,2);
});

test('managed macOS lease owner and expiry boundaries reject saved credentials without transmitting',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t);
  const good=f.runtime.state.leases[0]!;
  for(const update of [{owner:'b'.repeat(64)},{owner:f.runtime.owner,leases:[]},{leases:[{...good,expires_at:Date.now()-1}]},{leases:[{...good,expires_at:Date.now()+120000}]},{leases:[{...good,monotonic_issued_at:good.monotonic_issued_at-60000,monotonic_expires_at:good.monotonic_expires_at-60000}]},{leases:[{...good,clock_scope:'macos:44444444-4444-4444-8444-444444444444'}]},{version:1},{clock_kind:'unknown-clock'}]){
    await f.runtime.renew(update);await f.send(f.directory,{}, {},false);assert.equal(f.received.length,0);
  }
  await f.runtime.renew({owner:f.runtime.owner,enabled:true});await f.send(f.directory);assert.equal(f.received.length,1,'a fresh matching lease can resume without issuing new credentials');const resumed=f.received[0];assert.ok(resumed);assert.equal(resumed.schema_version,2);
});

test('macOS pause during Git work fences the completed Hook before network delivery',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'pause-repository'),bin=join(f.directory,'pause-bin'),stopped=join(f.directory,'paused-control.json'),marker=join(f.directory,'pause-probe-marker');
  await f.git('init','--quiet','--template=',repo);await mkdir(bin);
  await writeFile(stopped,JSON.stringify({...f.runtime.state,enabled:false}),{mode:0o600});
  await writeFile(join(bin,'git'),'#!/bin/bash\n[ "$1" != --version ] || exit 0\nprintf "probe\\n" > "$ADI_TEST_MARKER"\n/bin/cp "$ADI_TEST_STOPPED" "$ADI_TEST_CONTROL"\nexec /Library/Developer/CommandLineTools/usr/bin/git "$@"\n',{mode:0o700});
  await execute(join(bin,'git'),['--version']);
  await f.send(repo,{}, {PATH:bin+':/usr/bin:/bin',ADI_TEST_STOPPED:stopped,ADI_TEST_CONTROL:f.runtime.path,ADI_TEST_MARKER:marker});
  assert.equal(await readFile(marker,'utf8'),'probe\n','the pause must happen after the actual Git phase begins');assert.equal(f.received.length,0,'the completed result cannot escape after pause');
});

test('a full isolated state volume fails open without replacing identity and resumes its original cached observation',
  {skip:process.platform!=='darwin'||!process.env.ADI_TEST_STATE_VOLUME},async t=>{
  const volume=await realpath(process.env.ADI_TEST_STATE_VOLUME!);
  assert.equal(volume,'/private/tmp/adi-io-mount','only the explicitly created test volume may be filled');
  const fs=await statfs(volume),host=await statfs('/private/tmp');
  assert.notEqual(fs.type,host.type,'refuse to fill the host filesystem');
  assert.ok(fs.bsize*fs.blocks<=25*1024*1024,'test volume must be at most 25MB');
  const f=await fixture(t,volume),repo=join(f.directory,'project'),next=join(f.directory,'next');
  await f.git('init','--quiet','--template=',repo);await f.git('-C',repo,'remote','add','origin','https://volume.example.invalid/app.git');await mkdir(next);
  const first=await f.send(repo);assert.equal(first?.project?.observation?.state,'repository');
  const identity=join(f.profile,'adi-native-collector','project-state','identity.json'),before=await readFile(identity);
  const filler=join(volume,'filler-'+randomUUID()),handle=await open(filler,'wx');let full=false;
  try{
    try{for(let bytes=0;bytes<25*1024*1024;bytes+=65536)await handle.write(Buffer.alloc(65536,1));}
    catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ENOSPC');full=true;}
    await handle.close();assert.equal(full,true,'the injected write failure must actually be reached');
    const tail=await open(filler,'a');
    try{try{for(let bytes=0;bytes<65536;bytes+=4096)await tail.write(Buffer.alloc(4096,1));}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ENOSPC');}}finally{await tail.close();}
    const saturated=await statfs(volume);t.diagnostic('test volume available bytes: '+saturated.bavail*saturated.bsize);
    await assert.rejects(writeFile(join(volume,'write-probe-'+randomUUID()),Buffer.alloc(4096)),{code:'ENOSPC'},'a new file must also fail before testing atomic state writes');
    const count=f.received.length;const failed=await f.send(next);
    assert.equal(f.received.length,count+1,'state write failure must not drop the normal Hook');
    assert.equal(failed?.project??null,null,'an uncommitted identity sequence must not become metadata');
    assert.deepEqual(await readFile(identity),before,'atomic write failure must preserve identity bytes');
  }finally{await handle.close().catch(()=>{});await rm(filler,{force:true});}
  const resumed=await f.send(repo);assert.deepEqual(resumed?.project,first?.project,'space recovery must reuse original identity and cached evidence');
});

test('installed macOS sender records distinct configured repository addresses without remote names, directions or credentials',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'项目 with spaces'),cwd=join(repo,'sub');await f.git('init','--quiet','--template=',repo);await mkdir(cwd);
  await f.git('-C',repo,'config','--add','remote.upstream.url','https://user:synthetic-secret@git.example.invalid/team/app.git?token=synthetic-secret');
  await f.git('-C',repo,'config','--add','remote.upstream.url','https://mirror.example.invalid/team/app.git');
  await f.git('-C',repo,'config','--add','remote.upstream.pushurl','git@10.1.2.3:team/app.git');
  await f.git('-C',repo,'config','--add','remote.upstream.url','https://git.example.invalid/team/app.git');
  await f.git('-C',repo,'remote','add','z-copy','https://git.example.invalid/team/app.git');
  const event=await f.send(cwd,{prompt:'对话地址 https://not-a-remote.example.invalid/ignore.git'});
  assert.ok(event?.project,'valid normal Hook must include its separately observed project');
  assert.equal(event.project.workspace,cwd);assert.equal(event.project.observation?.state,'repository');assert.equal(event.project.observation.git_root,repo);
  assert.deepEqual(event.project.observation.remotes,[{address:'https://git.example.invalid/team/app.git'},{address:'https://mirror.example.invalid/team/app.git'},{address:'10.1.2.3:team/app.git'}]);
  assert.equal(JSON.stringify(event.project).includes('synthetic-secret'),false);assert.equal(JSON.stringify(event.project).includes('not-a-remote'),false);
});

test('native address collection collapses duplicate remotes and unknown addresses after sanitization',async()=>{
  const core=runInNewContext((await readFile(new URL('core.js',source),'utf8'))+'\nADI;');
  const remotes=core.projectRemotes([
    {name:'origin',direction:'fetch',address:'https://user:synthetic-secret@HOST.example.invalid/team/app.git?token=synthetic-secret'},
    {name:'mirror',direction:'push',address:'https://host.example.invalid/team/app.git'},
    {address:'ssh://push.example.invalid/team/app.git'},
    {address:'/local/repository'},{address:null},{address:'/another/local/repository'},
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(remotes)),[{address:'https://host.example.invalid/team/app.git'},{address:'ssh://push.example.invalid/team/app.git'},{address:null}]);
});

test('project probe ignores inherited Git config redirection and reads the Hook project configuration',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'actual-project'),redirect=join(f.directory,'unrelated.config');
  await f.git('init','--quiet','--template=',repo);await f.git('-C',repo,'remote','add','origin','https://actual.example.invalid/app.git');
  await writeFile(redirect,'[remote "unrelated"]\nurl=https://unrelated.example.invalid/app.git\n');
  const event=await f.send(repo,{}, {GIT_CONFIG:redirect});
  assert.equal(event?.project?.observation?.state,'repository');
  assert.deepEqual(event.project.observation.remotes,[{address:'https://actual.example.invalid/app.git'}]);
});

test('simultaneous Hooks share one durable project attempt and cached observation without advancing its time',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'concurrent'),bin=join(f.directory,'bin'),calls=join(f.directory,'git-calls');
  await f.git('init','--quiet','--template=',repo);await mkdir(bin);
  await writeFile(join(bin,'git'),'#!/bin/bash\nprintf "call\\n" >> "$ADI_TEST_CALLS"\n/bin/sleep 0.025\nexec /Library/Developer/CommandLineTools/usr/bin/git "$@"\n',{mode:0o700});
  // macOS assesses a newly created executable on first launch (~450 ms here).
  // Warm only that OS check so this case isolates simultaneous pipe readers.
  await execute(join(bin,'git'),['--version'],{env:{...gitEnv,ADI_TEST_CALLS:calls}});await writeFile(calls,'');
  // Establish only the collector identity, without a guessed workspace or Git run.
  const initial=await f.send('');assert.equal(initial?.project?.observation,null);
  const start=f.received.length,environment={PATH:bin+':/usr/bin:/bin',ADI_TEST_CALLS:calls};
  await Promise.all([f.send(repo,{session_id:'concurrent-1'},environment),f.send(repo,{session_id:'concurrent-2'},environment),f.send(repo,{session_id:'concurrent-3'},environment)]);
  const events=f.received.slice(start);assert.equal(events.length,3);
  for(const event of events)assert.equal(event.project?.collector_id,initial.project.collector_id);
  const observed=events.flatMap(event=>event.project?.observation?[event.project.observation]:[]);assert.ok(observed.length>0);
  assert.equal(observed[0]!.sequence,'1');assert.equal(observed[0]!.state,'no_remote',JSON.stringify(observed[0]));
  for(const value of observed)assert.deepEqual(value,observed[0]);
  const repeated=await f.send(repo,{},environment);assert.deepEqual(repeated?.project?.observation,observed[0]);
  assert.equal(await readFile(calls,'utf8'),'call\ncall\n','only the first attempt may execute the two Git reads');
});

test('a stalled Git process and its TERM-resistant descendant are killed while the normal Hook is delivered',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),bin=join(f.directory,'slow-bin'),pidFile=join(f.directory,'git-pids');await mkdir(bin);
  const pids:number[]=[];t.after(()=>{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{ /* Already reaped. */ }});
  await writeFile(join(bin,'git'),'#!/bin/bash\n[ "${ADI_TEST_WARM:-}" != 1 ] || exit 0\ntrap "" TERM\n/bin/sleep 30 &\nchild=$!\nprintf "%s %s" "$$" "$child" > "$ADI_TEST_PIDS"\nwait "$child"\n',{mode:0o700});
  await execute(join(bin,'git'),[],{env:{...gitEnv,ADI_TEST_WARM:'1'}});
  const event=await f.send(f.directory,{}, {PATH:bin+':/usr/bin:/bin',ADI_TEST_PIDS:pidFile});
  assert.equal(event?.payload.session_id,'native-project-session');assert.equal(event.project?.observation?.state,'failed');assert.equal(event.project.observation.reason,'timeout');
  pids.push(...(await readFile(pidFile,'utf8')).split(' ').map(Number));assert.equal(pids.length,2);
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(let attempt=0;attempt<20&&pids.some(alive);attempt++)await delay(25);
  if(pids.some(alive))t.diagnostic((await execute('/bin/ps',['-o','pid,ppid,pgid,stat,comm','-p',pids.join(',')])).stdout);
  assert.deepEqual(pids.filter(alive),[],'the wrapper must reap the entire inherited process group');
});

test('native project evidence distinguishes non-Git, no remote, missing Git and unresolved multi-root context',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),plain=join(f.directory,'plain'),repo=join(f.directory,'empty-repo'),missingGit=join(f.directory,'missing-git');
  await mkdir(plain);await mkdir(missingGit);await f.git('init','--quiet','--template=',repo);
  const notGit=(await f.send(plain))!.project!;assert.equal(notGit.observation?.state,'not_git');assert.equal(notGit.observation.reason,null);
  const noRemote=(await f.send(repo))!.project!;assert.equal(noRemote.observation?.state,'no_remote');assert.equal(noRemote.observation.git_root,repo);assert.deepEqual(noRemote.observation.remotes,[]);
  const unavailable=(await f.send(missingGit,{}, {PATH:missingGit}))!.project!;assert.equal(unavailable.observation?.state,'failed');assert.equal(unavailable.observation.reason,'git_missing');
  const multiple=(await f.send(repo,{workspace_roots:[repo,plain]}))!.project!;assert.equal(multiple.workspace,null);assert.equal(multiple.unresolved_reason,'ambiguous_workspace');assert.equal(multiple.observation,null);
  const absent=(await f.send(''))!.project!;assert.equal(absent.workspace,null);assert.equal(absent.unresolved_reason,'missing_workspace');assert.equal(absent.observation,null);
  const single=(await f.send('',{workspace_roots:[repo]}))!.project!;assert.equal(single.workspace,repo);assert.deepEqual(single.observation,noRemote.observation);
});

test('native observation reads a linked worktree and URL rewriting without interpreting quoted paths as shell code',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'main'),worktree=join(f.directory,"worktree 'quoted $path"),cwd=join(worktree,'sub');
  await f.git('init','--quiet','--template=',repo);
  await f.git('-C',repo,'-c','core.hooksPath=/dev/null','-c','user.name=Synthetic Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--quiet','--allow-empty','-m','synthetic worktree');
  await f.git('-C',repo,'remote','add','origin','short:team/app.git');await f.git('-C',repo,'config','url.https://rewrite.example.invalid/.insteadOf','short:');
  await f.git('-C',repo,'worktree','add','--quiet','--detach',worktree);await mkdir(cwd);
  const observed=(await f.send(cwd))!.project!;assert.equal(observed.workspace,cwd);assert.equal(observed.observation?.state,'repository');assert.equal(observed.observation.git_root,worktree);
  assert.deepEqual(observed.observation.remotes,[{address:'https://rewrite.example.invalid/team/app.git'}]);
});

test('project throttle uses elapsed time, preserves pending reservations and never rewinds sequence after a clock rollback',async()=>{
  const sourceText=await readFile(new URL('core.js',source),'utf8'),files=new Map<string,string>();
  let wall=Date.parse('2026-09-30T00:00:00Z'),tick=1000,locked=false,probes=0;
  const settings={installation_id:installation,token:'adi_'+'a'.repeat(43),endpoint:'http://example.invalid/hooks'},payload={cwd:'/workspace'};
  const io={root:'/state',platform:'macos',uuid:randomUUID,hash:(value:string)=>createHash('sha256').update(value).digest('hex'),now:()=>wall,tick:()=>tick,read:(path:string)=>files.get(path)??null,atomic:(path:string,value:string)=>{files.set(path,value);},directory:()=>{},
    lock:()=>{if(locked)throw new Error('busy');locked=true;return()=>{locked=false;};},
    probe:()=>{probes++;if(probes===1){const concurrent=observe();assert.equal(concurrent.observation,null,'an in-flight attempt has no fabricated result');assert.equal(probes,1,'a reserved attempt cannot start another Git process');}return {state:'no_remote',reason:null,git_root:'/workspace',remotes:[]};},
  };
  function observe(){return JSON.parse(JSON.stringify(runInNewContext(sourceText+'\nADI;').project(io,settings,payload))) as NonNullable<HookEnvelope['project']>;}
  const first=observe();assert.equal(first.observation?.sequence,'1');assert.equal(probes,1);
  tick+=299999;wall+=299999;assert.deepEqual(observe(),first);assert.equal(probes,1);
  tick++;wall++;const next=observe();assert.equal(next.observation?.sequence,'2');assert.notEqual(next.observation.id,first.observation.id);assert.equal(probes,2);
  // Wall-clock rollback cannot prevent a new attempt after five monotonic minutes.
  tick+=300000;wall-=3600000;const rolled=observe();assert.equal(rolled.observation?.sequence,'3');assert.equal(rolled.observation.observed_at,'2026-09-29T23:05:00.000Z');assert.equal(probes,3);
  // A reboot resets uptime. If both clocks move backwards, fence the retry while
  // preserving the old evidence time, then allow a new attempt after five minutes.
  tick=1;wall-=1000;assert.deepEqual(observe().observation,rolled.observation);assert.equal(probes,3);
  tick+=299999;wall+=299999;assert.deepEqual(observe().observation,rolled.observation);assert.equal(probes,3);
  tick++;wall++;const resumed=observe();assert.equal(resumed.observation?.sequence,'4');assert.equal(resumed.collector_id,first.collector_id);assert.equal(probes,4);
});

test('macOS project identity survives upgrades and credential reset, while cache and state corruption cannot forge or rewind an observation',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),repo=join(f.directory,'repository');await f.git('init','--quiet','--template=',repo);await f.git('-C',repo,'remote','add','origin','https://old.example.invalid/app.git');
  const first=(await f.send(repo))!.project!;assert.ok(first?.observation);assert.equal(first.observation.sequence,'1');
  assert.equal((await stat(join(f.profile,'adi-native-collector','project-state','state.lock'))).mode&0o777,0o600);
  await f.git('-C',repo,'remote','set-url','origin','https://new.example.invalid/app.git');
  const cached=(await f.send(repo))!.project!;assert.equal(cached.collector_id,first.collector_id);assert.deepEqual(cached.observation,first.observation);
  await f.install();const upgraded=(await f.send(repo))!.project!;assert.equal(upgraded.collector_id,first.collector_id);assert.deepEqual(upgraded.observation,first.observation);
  await f.configure('adi_'+'b'.repeat(43));await f.install();const rotated=(await f.send(repo))!.project!;
  assert.equal(rotated.collector_id,first.collector_id);assert.equal(rotated.observation?.sequence,'2');assert.equal(rotated.observation.remotes[0]!.address,'https://new.example.invalid/app.git');
  const state=join(f.profile,'adi-native-collector','project-state');
  for(const name of await readdir(join(state,'cache'))){const path=join(state,'cache',name),entry=JSON.parse(await readFile(path,'utf8'));if(entry.observation?.id===rotated.observation.id){entry.observation.remotes[0].address='https://corrupted.example.invalid/app.git';await writeFile(path,JSON.stringify(entry));}}
  const repaired=(await f.send(repo))!.project!;assert.equal(repaired.collector_id,first.collector_id);assert.equal(repaired.observation,null,'cache corruption must not forge a result or bypass the five-minute throttle');
  await writeFile(join(state,'identity.json'),'{broken');const restarted=(await f.send(repo))!.project!;assert.notEqual(restarted.collector_id,first.collector_id);assert.equal(restarted.observation?.sequence,'1');
});


test('a stalled state-file read preserves cached evidence and still delivers the normal macOS Hook',
  {skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t,undefined,true),marker=join(f.directory,'slow-read-marker');
  const first=await f.send(f.directory);assert.ok(first?.project?.observation,'baseline must have real cached evidence');
  const identity=join(f.profile,'adi-native-collector','project-state','identity.json'),before=await readFile(identity);
  const controlCount=f.received.length;await f.send(f.directory,{}, {ADI_TEST_DISK_MODE:'fast-fail',ADI_TEST_DISK_MARKER:marker});
  assert.equal(f.received.length,controlCount+1,'an immediate filesystem failure must still deliver normally');
  const count=f.received.length;
  const slow=await f.send(f.directory,{}, {ADI_TEST_DISK_MODE:'read',ADI_TEST_DISK_MARKER:marker});
  const [mode,pidText]=(await readFile(marker,'utf8')).split(':');assert.equal(mode,'read','the filesystem delay must actually be reached');
  assert.throws(()=>process.kill(Number(pidText),0),/ESRCH/,'the stalled project child must be reaped');
  assert.equal(f.received.length,count+1,'optional slow state I/O must not discard a normal Hook');
  assert.equal(slow?.project??null,null,'an unfinished probe must not publish metadata');
  assert.deepEqual(await readFile(identity),before);
  const recovered=await f.send(f.directory);assert.deepEqual(recovered?.project,first.project,'recovery must keep original identity and cached evidence');
});


for(const mode of ['write','flush'])test('stalled macOS state '+mode+' stays bounded and preserves prior cached observation',
  {skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t,undefined,true),marker=join(f.directory,'disk-marker');
  const first=await f.send(f.directory);assert.ok(first?.project?.observation);
  const identity=join(f.profile,'adi-native-collector','project-state','identity.json'),before=JSON.parse(await readFile(identity,'utf8'));
  const next=join(f.directory,'next');await mkdir(next);const count=f.received.length;
  const slow=await f.send(next,{}, {ADI_TEST_DISK_MODE:mode,ADI_TEST_DISK_MARKER:marker});
  const [observed,pidText]=(await readFile(marker,'utf8')).split(':');assert.equal(observed,mode);
  assert.equal(f.received.length,count+1);assert.equal(slow?.project??null,null);
  assert.throws(()=>process.kill(Number(pidText),0),/ESRCH/);
  const after=JSON.parse(await readFile(identity,'utf8'));assert.equal(after.collector_id,before.collector_id);assert.ok(BigInt(after.sequence)>=BigInt(before.sequence));
  assert.deepEqual((await f.send(f.directory))?.project,first.project,'recovery must keep the successful cached observation');
});


test('interrupting the macOS sender reaps its stalled optional project process without changing cached evidence',
  {skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t,undefined,true),first=await f.send(f.directory);assert.ok(first?.project?.observation);
  const base=join(f.profile,'adi-native-collector'),manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'));
  const release=join(base,manifest.release),marker=join(f.directory,'interrupt-marker');
  const sender=spawn('/bin/bash',[join(release,'send-hook.sh'),join(release,'config.json')],{detached:true,env:{...gitEnv,HOME:f.directory,USERPROFILE:f.directory,ADI_TEST_DISK_MODE:'read',ADI_TEST_DISK_MARKER:marker}});
  t.after(()=>{sender.kill('SIGKILL');});sender.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'interrupt-project',cwd:f.directory}));
  let pid=0;
  for(let attempt=0;attempt<100&&!pid;attempt++){try{pid=Number((await readFile(marker,'utf8')).split(':')[1]);}catch{/* marker is created only after the child reaches I/O */}if(!pid)await delay(10);}
  assert.ok(pid,'interrupt must happen after the real project child reached the stalled filesystem');
  process.kill(pid,0);const exited=once(sender,'exit');sender.kill('SIGTERM');await exited;
  let alive=true;for(let attempt=0;attempt<100&&alive;attempt++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}
  assert.equal(alive,false,'an interrupted sender must not leave its optional project process running');
  assert.deepEqual((await f.send(f.directory))?.project,first.project);
});


test('macOS late Git descendants are reaped when slow state I/O exhausts the optional project window',
  {skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t,undefined,true);assert.ok((await f.send(f.directory))?.project?.observation);
  const repo=join(f.directory,'late-project'),bin=join(f.directory,'bin'),pidFile=join(f.directory,'late-git-pids');
  await f.git('init','--quiet','--template=',repo);await mkdir(bin);
  await writeFile(join(bin,'git'),'#!/bin/bash\nif [ "$1" = "--version" ]; then exec /Library/Developer/CommandLineTools/usr/bin/git "$@"; fi\n/bin/sleep 10 &\nprintf "%s %s" "$$" "$!" > "$ADI_TEST_PIDS"\nwait\n',{mode:0o700});
  await execute(join(bin,'git'),['--version']);
  const pids:number[]=[];t.after(()=>{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{/* own child already ended */}});
  const count=f.received.length;await f.send(repo,{}, {PATH:bin+':/usr/bin:/bin',ADI_TEST_DISK_MODE:'before-git',ADI_TEST_PIDS:pidFile});
  assert.equal(f.received.length,count+1);pids.push(...(await readFile(pidFile,'utf8')).split(' ').map(Number));assert.equal(pids.length,2,'Git must actually start after the delayed filesystem read');
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(let i=0;i<100&&pids.some(alive);i++)await delay(10);
  assert.deepEqual(pids.filter(alive),[],'late Git process groups must not outlive a timed-out optional probe');
});
