import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,basename} from 'node:path';
import {RuntimeControl,isRuntimeActive} from '../src/runtime-control.js';
test('busy windows can finish a slow owner-protection step without failing a peer heartbeat',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-runtime-contention-'));t.after(()=>rm(directory,{recursive:true,force:true}));const owner='a'.repeat(64);
 const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000});let slow=false,entered!:()=>void;
 const holding=new Promise<void>(r=>{entered=r;}),first=new RuntimeControl(directory,()=>100000,clock,async()=>{if(slow){entered();await new Promise(r=>setTimeout(r,1800));}}),peer=new RuntimeControl(directory,()=>100000,clock,async()=>{});
 assert.equal(await first.pulse(owner,true,{resume:true}),true);assert.equal(await peer.pulse(owner,true,{resume:true}),true);slow=true;
 const heartbeat=first.pulse(owner,true);await holding;assert.equal(await peer.pulse(owner,true),true);assert.equal(await heartbeat,true);
 assert.equal(JSON.parse(await readFile(join(directory,'control.json'),'utf8')).leases.length,2);
});
test('every runtime replacement is protected before publication, including heartbeats and stopping',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-owner-')),owner='a'.repeat(64),published=join(directory,'control.json');
  let now=100000;const protectedValues:string[]=[];
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:now});
  const protect=async(path:string)=>{
    assert.match(basename(path),/^[a-f0-9-]{36}\.tmp$/);
    assert.equal(await readFile(published,'utf8').catch(error=>{if(error.code==='ENOENT')return;throw error;}),protectedValues.at(-1),'the previous protected file stays visible until its replacement is protected');
    protectedValues.push(await readFile(path,'utf8'));
  };
  const control=new RuntimeControl(directory,()=>now,clock,protect);
  try{
    await control.pulse(owner,true,{resume:true});now+=5000;await control.pulse(owner,true);
    await control.stop(owner);await control.pulse(owner,true,{resume:true});await control.close(owner);
    assert.equal(protectedValues.length,5,'each newly created file needs its own owner protection');
    assert.equal(await readFile(published,'utf8'),protectedValues.at(-1));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('failed runtime file protection leaves the previous lease untouched and removes the temporary file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-owner-')),owner='a'.repeat(64),published=join(directory,'control.json');let fail=false;
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000});
  const control=new RuntimeControl(directory,()=>100000,clock,async()=>{if(fail)throw new Error('unsafe_runtime_file');});
  try{
    await control.pulse(owner,true,{resume:true});const previous=await readFile(published,'utf8');fail=true;
    await assert.rejects(control.pulse(owner,true),/unsafe_runtime_file/);
    assert.equal(await readFile(published,'utf8'),previous);
    assert.deepEqual((await readdir(directory)).sort(),['control.json','coordination']);
    fail=false;assert.equal(await control.pulse(owner,true),true,'a protection failure must release the publication lock');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('the last window stops Hooks, a surviving window keeps its lease, and stale windows cannot revive a new owner',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-'));let now=100000;const owner='a'.repeat(64),other='b'.repeat(64);
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:now});
  const one=new RuntimeControl(directory,()=>now,clock),two=new RuntimeControl(directory,()=>now,clock);
  const current=async()=>JSON.parse(await readFile(join(directory,'control.json'),'utf8'));
  try{
    await one.pulse(owner,true,{resume:true});await two.pulse(owner,true,{resume:true});await one.close(owner);
    assert.equal(isRuntimeActive(await current(),owner,now,await clock()),true);
    now+=30001;assert.equal(isRuntimeActive(await current(),owner,now,await clock()),false);
    await two.pulse(other,true,{resume:true});await one.close(owner);assert.equal(isRuntimeActive(await current(),other,now,await clock()),true);
    await two.stop(other);assert.equal(isRuntimeActive(await current(),other,now,await clock()),false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('wall-clock rollback cannot revive an expired lease and a new boot cannot inherit it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-'));let wall=100000,monotonic=1000,scope='macos:11111111-1111-4111-8111-111111111111';
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope,monotonic_ms:monotonic});
  const one=new RuntimeControl(directory,()=>wall,clock),two=new RuntimeControl(directory,()=>wall,clock),owner='a'.repeat(64);
  const current=async()=>JSON.parse(await readFile(join(directory,'control.json'),'utf8'));
  try{
    await one.pulse(owner,true,{resume:true});const issued=await current();
    wall+=40000;monotonic+=40000;assert.equal(isRuntimeActive(issued,owner,wall,await clock()),false);
    wall=110000;assert.equal(isRuntimeActive(issued,owner,wall,await clock()),false);
    assert.equal(issued.version,2);
    await two.pulse(owner,true,{resume:true});const reserved=(await current()).leases.find((lease:{id:string})=>lease.id===issued.leases[0].id);
    assert.deepEqual(reserved,issued.leases[0],'retaining a reservation must not rewrite its expired deadlines');
    assert.equal(isRuntimeActive({...await current(),leases:[reserved]},owner,wall,await clock()),false);
    const fresh=await current();scope='macos:22222222-2222-4222-8222-222222222222';assert.equal(isRuntimeActive(fresh,owner,wall,await clock()),false);
    assert.equal(isRuntimeActive({...fresh,version:1},owner,wall,await clock()),false);
    assert.equal(isRuntimeActive(fresh,owner,wall),false,'absence of a trusted monotonic clock fails closed');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('ordinary heartbeats cannot resume a stop and an explicit stop never depends on the system clock',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-')),owner='a'.repeat(64);let unavailable=false;
  const clock=async()=>{if(unavailable)throw new Error('synthetic_clock_unavailable');return {kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000};};
  const control=new RuntimeControl(directory,()=>100000,clock),current=async()=>JSON.parse(await readFile(join(directory,'control.json'),'utf8'));
  try{
    assert.equal(await control.pulse(owner,true),false);
    assert.equal(await control.pulse(owner,true,{resume:true}),true);
    unavailable=true;assert.equal(await control.pulse(owner,false),false);assert.equal((await current()).enabled,false);
    assert.equal(await control.pulse(owner,true),false);
    unavailable=false;assert.equal(await control.pulse(owner,true,{resume:true}),true);
    unavailable=true;await control.close(owner);assert.equal((await current()).leases.length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a still-open window can write a fresh heartbeat after sleep without reviving its old expired lease',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-'));let wall=100000,monotonic=1000;const owner='a'.repeat(64);
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:monotonic});
  const control=new RuntimeControl(directory,()=>wall,clock),current=async()=>JSON.parse(await readFile(join(directory,'control.json'),'utf8'));
  try{
    assert.equal(await control.pulse(owner,true,{resume:true}),true);const expired=await current();
    wall+=40000;monotonic+=40000;assert.equal(isRuntimeActive(expired,owner,wall,await clock()),false);
    assert.equal(await control.pulse(owner,true),true);const renewed=await current();
    assert.equal(isRuntimeActive(renewed,owner,wall,await clock()),true);assert.equal(renewed.generation,expired.generation);
    assert.equal(isRuntimeActive(expired,owner,wall,await clock()),false,'the original lease remains expired');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('two sleeping windows retain non-running reservations so each can independently wake and stop',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-'));let wall=100000,monotonic=1000;const owner='a'.repeat(64);
  const clock=async()=>({kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:monotonic});
  const one=new RuntimeControl(directory,()=>wall,clock),two=new RuntimeControl(directory,()=>wall,clock),current=async()=>JSON.parse(await readFile(join(directory,'control.json'),'utf8'));
  try{
    await one.pulse(owner,true,{resume:true});await two.pulse(owner,true,{resume:true});const initial=await current();
    wall+=40000;monotonic+=40000;assert.equal(isRuntimeActive(await current(),owner,wall,await clock()),false);
    assert.equal(await one.pulse(owner,true),true);const firstWake=await current();
    assert.equal(await two.pulse(owner,true),true,'the first waking window must not remove the other live window reservation');
    assert.equal(firstWake.leases.length,2);assert.equal(firstWake.leases.filter((lease:{expires_at:number})=>lease.expires_at===initial.leases[0].expires_at).length,1,'peer expiry must remain untouched until its own heartbeat');
    assert.equal(isRuntimeActive(await current(),owner,wall,await clock()),true);
    await one.close(owner);assert.equal((await current()).leases.length,1);assert.equal(await one.pulse(owner,true,{resume:true}),false);
    await two.stop(owner);assert.equal(await two.pulse(owner,true),false);assert.equal(isRuntimeActive(await current(),owner,wall,await clock()),false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a clock reply arriving after this window or another window stopped cannot restore a lease',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-test-')),owner='a'.repeat(64);
  const sample={kind:'macos-continuous-v1' as const,scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000};
  try{
    for(const otherWindow of [false,true]){
      const stopper=new RuntimeControl(directory,()=>100000,async()=>sample);assert.equal(await stopper.pulse(owner,true,{resume:true}),true);
      let release:(()=>void)|undefined,entered:(()=>void)|undefined;const ready=new Promise<void>(resolve=>{entered=resolve;});
      const pending=new RuntimeControl(directory,()=>100000,()=>new Promise(resolve=>{release=()=>resolve(sample);entered?.();}));
      const pulse=pending.pulse(owner,true,{resume:true});await ready;
      await (otherWindow?stopper:pending).stop(owner);release?.();assert.equal(await pulse,false);
      const closed=JSON.parse(await readFile(join(directory,'control.json'),'utf8'));assert.equal(closed.enabled,false);assert.deepEqual(closed.leases,[]);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
