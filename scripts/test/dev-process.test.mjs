import {setTimeout} from 'node:timers';
import process from 'node:process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startDev,stopDev,restartDev} from '../lib/dev-process.mjs';
const posix={skip:process.platform==='win32',timeout:10000};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'adi-dev-process-')),entry=join(root,'fixture.mjs');
 await writeFile(entry,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
 if(process.env.FAIL_START==='true'){console.error('fixture_start_failed');process.exit(1);}
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{if(process.env.IGNORE_TERM!=='true')process.exit(0)});process.send({ready:true});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
 process.on('SIGTERM',()=>{if(process.env.IGNORE_TERM!=='true'){child.kill('SIGTERM');child.once('exit',()=>process.exit(0));}});
 child.on('message',()=>{writeFileSync('child.pid',String(child.pid));if(process.env.NO_READY!=='true')process.send({event:'dev_started'});});setInterval(()=>{},1000);`);
 t.after(async()=>{await stopDev({root,entry,force:true}).catch(()=>{});await rm(root,{recursive:true,force:true});});
 return {root,entry};
}
test('background startup is idempotent and stop terminates only its own process group',posix,async t=>{
 const f=await fixture(t),foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const foreignExit=once(foreign,'exit');t.after(async()=>{foreign.kill('SIGKILL');await foreignExit;});
 const first=await startDev(f);assert.equal(first.state,'started');const second=await startDev(f);assert.equal(second.state,'already_running');assert.equal(second.pid,first.pid);
 const child=Number(await readFile(join(f.root,'child.pid'),'utf8'));const stopped=await stopDev(f);assert.equal(stopped.state,'stopped');assert.equal(stopped.escalated,false);
 assert.throws(()=>process.kill(first.pid,0),{code:'ESRCH'});assert.throws(()=>process.kill(child,0),{code:'ESRCH'});assert.doesNotThrow(()=>process.kill(foreign.pid,0));assert.equal((await stopDev(f)).state,'not_running');
});
test('kill terminates an uncooperative background parent and child',posix,async t=>{
 const f=await fixture(t),started=await startDev({...f,env:{...process.env,IGNORE_TERM:'true'}}),child=Number(await readFile(join(f.root,'child.pid'),'utf8'));
 assert.equal((await stopDev({...f,force:true})).state,'killed');assert.throws(()=>process.kill(started.pid,0),{code:'ESRCH'});assert.throws(()=>process.kill(child,0),{code:'ESRCH'});
});
test('stop escalates after its grace period without leaving descendants',posix,async t=>{
 const f=await fixture(t);await startDev({...f,env:{...process.env,IGNORE_TERM:'true'}});
 const child=Number(await readFile(join(f.root,'child.pid'),'utf8'));
 assert.equal((await stopDev({...f,shutdownMs:100})).escalated,true);assert.throws(()=>process.kill(child,0),{code:'ESRCH'});
});
test('a stale or reused PID is never signalled and can be cleared safely',posix,async t=>{
 const f=await fixture(t);await assert.rejects(startDev({...f,env:{...process.env,FAIL_START:'true'}}),/dev_start_failed/);
 const file=join(f.root,'.run/dev-process.json'),state=JSON.parse(await readFile(file,'utf8'));state.pid=process.pid;await writeFile(file,JSON.stringify(state));
 assert.equal((await stopDev({...f,force:true})).state,'stale_state_removed');assert.doesNotThrow(()=>process.kill(process.pid,0));assert.match(await readFile(join(f.root,'.run/dev.log'),'utf8'),/fixture_start_failed/);
 const restarted=await startDev(f);assert.equal(restarted.state,'started');
});
test('startup timeout kills the launched process group and reports failure',posix,async t=>{
 const f=await fixture(t);await assert.rejects(startDev({...f,env:{...process.env,NO_READY:'true'},startupMs:200}),/dev_start_timeout/);
 const record=JSON.parse(await readFile(join(f.root,'.run/dev-process.json'),'utf8'));await new Promise(r=>setTimeout(r,100));assert.throws(()=>process.kill(record.pid,0),{code:'ESRCH'});
});

test('concurrent starts launch at most one background group',posix,async t=>{
 const f=await fixture(t);const results=await Promise.allSettled([startDev(f),startDev(f)]);
 const started=results.filter(r=>r.status==='fulfilled'&&r.value.state==='started');assert.equal(started.length,1);
 for(const r of results)if(r.status==='fulfilled')assert.equal(r.value.pid,started[0].value.pid);else assert.match(r.reason.message,/dev_start_in_progress|invalid_dev_state/);
});
test('a stop during startup cancels startup instead of reporting success',posix,async t=>{
 const f=await fixture(t);const pending=startDev({...f,env:{...process.env,NO_READY:'true'}});const failed=assert.rejects(pending,/dev_start_failed/);
 for(let i=0;i<100;i++){try{await readFile(join(f.root,'child.pid'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
 assert.equal((await stopDev(f)).state,'stopped');await failed;
});

test('restart waits for both old parent and child to exit before launching replacements',posix,async t=>{
 const f=await fixture(t),first=await startDev({...f,env:{...process.env,IGNORE_TERM:'true'}});
 const oldChild=Number(await readFile(join(f.root,'child.pid'),'utf8')),events=[];
 const restarted=await restartDev({...f,shutdownMs:100,onEvent:(event)=>{
  events.push(event);
  if(event==='start_started'){
   assert.throws(()=>process.kill(first.pid,0),{code:'ESRCH'});
   assert.throws(()=>process.kill(oldChild,0),{code:'ESRCH'});
  }
 }});
 assert.equal(restarted.state,'started');assert.notEqual(restarted.pid,first.pid);
 assert.deepEqual(events,['stop_started','stop_completed','start_started']);
});

test('restart refuses to signal an unverified group or start another service',posix,async t=>{
 const f=await fixture(t),first=await startDev(f),file=join(f.root,'.run/dev-process.json'),raw=await readFile(file,'utf8');
 const tampered=JSON.parse(raw);tampered.token='00000000-0000-0000-0000-000000000000';await writeFile(file,JSON.stringify(tampered));
 const events=[];
 try{
  await assert.rejects(restartDev({...f,onEvent:event=>events.push(event)}),/dev_process_group_unverified/);
  assert.deepEqual(events,['stop_started']);assert.doesNotThrow(()=>process.kill(first.pid,0));
  assert.equal(JSON.parse(await readFile(file,'utf8')).token,tampered.token);
 }finally{await writeFile(file,raw);}
});

test('restart detects a background manager even when its state file was removed',posix,async t=>{
 const f=await fixture(t),first=await startDev(f),file=join(f.root,'.run/dev-process.json'),raw=await readFile(file,'utf8');
 await rm(file);
 try{
  await assert.rejects(restartDev(f),/dev_background_process_untracked/);
  assert.doesNotThrow(()=>process.kill(first.pid,0));
 }finally{await writeFile(file,raw);}
});

test('restart preserves evidence of a live orphan group instead of clearing it',posix,async t=>{
 const f=await fixture(t),first=await startDev(f),file=join(f.root,'.run/dev-process.json'),raw=await readFile(file,'utf8');
 const child=Number(await readFile(join(f.root,'child.pid'),'utf8'));
 try{
  process.kill(first.pid,'SIGKILL');
  for(let n=0;n<100;n++){try{process.kill(first.pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.throws(()=>process.kill(first.pid,0),{code:'ESRCH'});assert.doesNotThrow(()=>process.kill(child,0));
  await assert.rejects(restartDev(f),/dev_process_group_unverified/);
  assert.equal(await readFile(file,'utf8'),raw);
 }finally{try{process.kill(-first.pid,'SIGKILL');}catch{/* already exited */}}
});
