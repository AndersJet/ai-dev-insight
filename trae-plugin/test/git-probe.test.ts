import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {probeProject} from '../src/git-probe.js';

test('the Git probe relates an opened subdirectory to its real Git root and records each sanitized address once',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);await exec('git',['init','--quiet',root]);const nested=join(root,'src');await mkdir(nested);
  await exec('git',['-C',root,'remote','add','origin','https://fake:synthetic-secret@git.example.invalid/team/example.git?token=synthetic-secret']);
  const result=await probeProject(nested,new AbortController().signal);
  assert.equal(result.state,'repository');assert.ok(result.git_root);assert.equal(await realpath(result.git_root),await realpath(root));
  assert.deepEqual(result.remotes,[{address:'https://git.example.invalid/team/example.git'}]);
});

test('different Git addresses remain in one observation while duplicate remotes and unknown addresses collapse',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-addresses-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);await exec('git',['init','--quiet',root]);
  await exec('git',['-C',root,'remote','add','origin','https://git.example.invalid/team/example.git']);
  await exec('git',['-C',root,'remote','set-url','--push','origin','ssh://push.example.invalid/team/example.git']);
  await exec('git',['-C',root,'remote','add','mirror','https://git.example.invalid/team/example.git']);
  await exec('git',['-C',root,'remote','add','local','/local/repository']);
  await exec('git',['-C',root,'remote','add','local-copy','/another/local/repository']);
  const result=await probeProject(root,new AbortController().signal);
  assert.equal(result.state,'repository');
  assert.deepEqual(result.remotes,[{address:null},{address:'https://git.example.invalid/team/example.git'},{address:'ssh://push.example.invalid/team/example.git'}]);
});

test('all configured repository addresses remain visible when a remote has multiple URLs and a separate push URL',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-multiple-urls-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);await exec('git',['init','--quiet',root]);
  await exec('git',['-C',root,'remote','add','origin','short:team/example.git']);
  await exec('git',['-C',root,'config','url.https://git.example.invalid/.insteadOf','short:']);
  await exec('git',['-C',root,'config','--add','remote.origin.url','https://mirror.example.invalid/team/example.git']);
  await exec('git',['-C',root,'remote','set-url','--push','origin','ssh://push.example.invalid/team/example.git']);
  const result=await probeProject(root,new AbortController().signal);
  assert.equal(result.state,'repository');
  assert.deepEqual(result.remotes,[{address:'https://git.example.invalid/team/example.git'},{address:'https://mirror.example.invalid/team/example.git'},{address:'ssh://push.example.invalid/team/example.git'}]);
});

test('a non-Git folder and missing Git are distinct from a Git repository with no remotes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-states-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal((await probeProject(root,new AbortController().signal)).state,'not_git');
  assert.equal((await probeProject(root,new AbortController().signal,join(root,'missing-executable'))).reason,'git_missing');
  await promisify(execFile)('git',['init','--quiet',root]);const noRemote=await probeProject(root,new AbortController().signal);assert.equal(noRemote.state,'no_remote');assert.equal(noRemote.reason,null);
});

test('a stalled Git executable exits within the total probe budget',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-timeout-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const program=join(root,'hang.cjs'),binary=join(root,'hanging-git');await writeFile(program,'setTimeout(()=>{},30000);');
  const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";await writeFile(binary,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,{mode:0o700});
  const started=performance.now(),result=await probeProject(root,new AbortController().signal,binary);assert.equal(result.reason,'timeout');assert.ok(performance.now()-started<5500);assert.deepEqual(result.remotes,[]);
});

test('slow background Git completes while the event loop stays responsive and cancellation remains prompt',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-plugin-slow-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const program=join(root,'slow.cjs'),binary=join(root,'slow-git');
 await writeFile(program,`setTimeout(()=>{if(process.argv.includes('rev-parse'))console.log(${JSON.stringify(root)});},2100);`);
 const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";await writeFile(binary,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,{mode:0o700});
 let ticks=0;const timer=setInterval(()=>{ticks++;},20);
 try{assert.equal((await probeProject(root,new AbortController().signal,binary)).state,'no_remote');assert.ok(ticks>50,'background probing must not block normal extension work');}finally{clearInterval(timer);}
 const controller=new AbortController(),started=performance.now();setTimeout(()=>controller.abort(),50);
 assert.equal((await probeProject(root,controller.signal,binary)).reason,'timeout');assert.ok(performance.now()-started<1000);
});

test('a Git wrapper with an inherited-output descendant cannot hold the probe past its deadline',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-git-descendant-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const program=join(root,'wrapper.cjs'),binary=join(root,'wrapped-git'),pidFile=join(root,'owned-pids.json');
  await writeFile(program,`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";await writeFile(binary,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,{mode:0o700});
  let timer:ReturnType<typeof setTimeout>|undefined;const pending=probeProject(root,new AbortController().signal,binary);
  try{
    const result=await Promise.race([pending,new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),5500);})]);
    assert.ok(result,'the direct process timeout must also close inherited descendant output');assert.equal(result.reason,'timeout');
    const pids=JSON.parse(await readFile(pidFile,'utf8')) as number[];
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}}),[],'no owned Git descendants may remain alive');
  }finally{
    if(timer)clearTimeout(timer);
    const pids=JSON.parse(await readFile(pidFile,'utf8')) as number[];for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{/* own process already exited */}
    await pending;
  }
});

test('oversized Git output is reported as a budget failure rather than a timeout or empty repository',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-output-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const program=join(root,'fake.cjs'),binary=join(root,'fake-git');
  await writeFile(program,`if(process.argv.includes('rev-parse'))console.log(${JSON.stringify(root)});else process.stdout.write('x'.repeat(300000));`);
  const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
  await writeFile(binary,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,{mode:0o700});
  const result=await probeProject(root,new AbortController().signal,binary);assert.equal(result.state,'failed');assert.equal(result.reason,'output_limit');assert.deepEqual(result.remotes,[]);
});

test('workspace Git metadata cannot be redirected to an unopened repository by inherited process variables',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-git-env-'));t.after(()=>rm(root,{recursive:true,force:true}));const opened=join(root,'opened'),other=join(root,'unopened'),exec=promisify(execFile);
 for(const path of [opened,other])await exec('git',['init','--quiet',path]);await exec('git',['-C',opened,'remote','add','origin','https://opened.example.invalid/team.git']);await exec('git',['-C',other,'remote','add','origin','https://unopened.example.invalid/team.git']);
 const old={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE,GIT_CONFIG:process.env.GIT_CONFIG};process.env.GIT_DIR=join(other,'.git');process.env.GIT_WORK_TREE=other;process.env.GIT_CONFIG=join(other,'.git','config');
 try{const result=await probeProject(opened,new AbortController().signal);assert.equal(result.state,'repository');assert.equal(result.git_root,await realpath(opened));assert.deepEqual(result.remotes,[{address:'https://opened.example.invalid/team.git'}]);}finally{for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
