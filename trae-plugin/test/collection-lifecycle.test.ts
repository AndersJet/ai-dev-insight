import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CollectionLifecycle,type CollectionBinding} from '../src/collection-lifecycle.js';

function fixture(){
  const binding:CollectionBinding={origin:'http://example.invalid',user_id:'synthetic-user',email:'synthetic@example.invalid',api_token:'synthetic-only'};
  let origin=binding.origin,enabled=true;
  const lifecycle=new CollectionLifecycle(()=>origin,()=>enabled);
  const generation=lifecycle.invalidate({origin,binding});lifecycle.updateEnabled();lifecycle.validate(binding,generation);
  const verify=async()=>({user_id:binding.user_id,email:binding.email,binding});
  return {binding,lifecycle,generation,verify,setOrigin:(value:string)=>{origin=value;},setEnabled:(value:boolean)=>{enabled=value;lifecycle.updateEnabled();}};
}
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return {pending,release};}

test('old authorization work cannot admit collection after identity or target changes',async()=>{
  for(const change of ['identity','target'] as const){
    const f=fixture(),started=gate(),finish=gate();
    const work=f.lifecycle.pulse(f.binding,f.generation,{verify:f.verify,pulse:async()=>{started.release();await finish.pending;return true;}});
    await started.pending;const oldSignal=f.lifecycle.signal;
    if(change==='identity')f.lifecycle.invalidate({origin:f.binding.origin,binding:{...f.binding,api_token:'replacement'}});else f.setOrigin('http://other.invalid');
    finish.release();assert.equal(await work,false);assert.equal(f.lifecycle.permits(true,true),false);
    if(change==='identity')assert.equal(oldSignal.aborted,true);
  }
});

test('pausing revokes a pending runtime result without throwing away platform identity',async()=>{
  const f=fixture(),started=gate(),finish=gate();
  const work=f.lifecycle.pulse(f.binding,f.generation,{verify:f.verify,pulse:async()=>{started.release();await finish.pending;return true;}});
  await started.pending;f.lifecycle.pause(true);finish.release();assert.equal(await work,false);
  assert.equal(f.lifecycle.validated,true);assert.equal(f.lifecycle.binding,f.binding);assert.equal(f.lifecycle.runtimeAllowed,false);
});

test('resume attempts are bounded and ordinary heartbeats do not resume an expired lease',async()=>{
  const f=fixture(),resumes:boolean[]=[];let verifications=0;
  const host={verify:async()=>{verifications++;return f.verify();},pulse:async(_owner:string,_enabled:boolean,resume:boolean)=>{resumes.push(resume);return false;}};
  for(let n=0;n<5;n++)await f.lifecycle.pulse(f.binding,f.generation,host);
  assert.deepEqual(resumes,[true,true,true,false,false]);assert.equal(verifications,3);
  f.lifecycle.requestResume();await f.lifecycle.pulse(f.binding,f.generation,host);assert.equal(resumes.at(-1),true);
});

test('runtime adapters share admission checks, including pause, trust and recovery',async()=>{
  for(const adapter of ['local','remote']){
    const f=fixture(),owners:string[]=[];
    await f.lifecycle.pulse(f.binding,f.generation,{verify:f.verify,pulse:async owner=>{owners.push(owner);return true;}});
    assert.equal(owners.length,1,adapter);assert.equal(f.lifecycle.permits(true,true),true);
    assert.equal(f.lifecycle.permits(false,true),false);assert.equal(f.lifecycle.permits(true,false),false);assert.equal(f.lifecycle.permits(true,true,true),false);
    f.setEnabled(false);assert.equal(f.lifecycle.permits(true,true),false);
    const generation=f.lifecycle.beginRecovery();assert.equal(f.lifecycle.runtimeAllowed,false);
    f.lifecycle.completeRecovery(f.binding,generation,false);assert.equal(f.lifecycle.validated,true);assert.equal(f.lifecycle.runtimeAllowed,false);
  }
});

test('resume checks current private credentials and enabled setting before contacting the runtime',async()=>{
  for(const invalid of ['credential','email','disabled']){
    const f=fixture();let pulses=0;
    const verify=async()=>{if(invalid==='disabled')f.setEnabled(false);return {...await f.verify(),...(invalid==='credential'?{binding:{...f.binding,api_token:'changed'}}:invalid==='email'?{email:'other@example.invalid'}:{})};};
    assert.equal(await f.lifecycle.pulse(f.binding,f.generation,{verify,pulse:async()=>{pulses++;return true;}}),false);
    assert.equal(pulses,0);assert.equal(f.lifecycle.runtimeAllowed,false);
  }
});

test('synchronization coalesces many heartbeats into one pending check and recovers after rejection',async()=>{
  const f=fixture(),started=gate(),finish=gate();let calls=0;
  const first=f.lifecycle.synchronize(async()=>{calls++;started.release();await finish.pending;throw new Error('synthetic');});await started.pending;
  const second=f.lifecycle.synchronize(async()=>{calls++;});
  for(let i=0;i<20;i++)assert.equal(f.lifecycle.synchronize(async()=>{calls++;}),second);
  finish.release();await assert.rejects(first,/synthetic/);await second;assert.equal(calls,2);
  f.lifecycle.dispose();await f.lifecycle.synchronize(async()=>{calls++;});assert.equal(calls,2);assert.equal(f.lifecycle.signal.aborted,true);
});
