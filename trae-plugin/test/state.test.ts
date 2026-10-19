import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PluginState} from '../src/state.js';

test('a fresh extension instance preserves its private source and advances the same persistent sequence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-state-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const config={ntEmail:'state.nt@example.org',serverUrl:'http://127.0.0.1:4184'},signal=new AbortController().signal;
  const first=new PluginState(directory,secrets),identity=await first.identity(config,signal);
  assert.equal(await first.nextSequence(signal),'1');
  const restarted=new PluginState(directory,secrets);assert.deepEqual(await restarted.identity(config,signal),identity);assert.equal(await restarted.nextSequence(signal),'2');
});

test('concurrent local windows reserve different increasing observation sequences without resetting the source',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-concurrent-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const states=[new PluginState(directory,secrets),new PluginState(directory,secrets)],signal=new AbortController().signal,config={ntEmail:'windows.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  const identities=await Promise.all(states.map(state=>state.identity(config,signal)));assert.deepEqual(identities[0],identities[1]);
  const sequence=await Promise.all(Array.from({length:20},(_,n)=>states[n%2]!.nextSequence(signal)));
  assert.deepEqual(sequence.map(Number).sort((a,b)=>a-b),Array.from({length:20},(_,n)=>n+1));
});

test('separate local app profiles do not borrow a source secret from the shared extension secret store',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-plugin-profiles-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const config={ntEmail:'profiles.nt@example.org',serverUrl:'http://127.0.0.1:4184'},signal=new AbortController().signal;
  const one=await new PluginState(join(root,'one'),secrets).identity(config,signal);
  const two=await new PluginState(join(root,'two'),secrets).identity(config,signal);
  assert.notEqual(two.source_secret,one.source_secret);
});

test('a waiting state reservation is cancelled promptly while another window still holds it',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-cancel-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let reserved!:()=>void,release!:()=>void;
  const acquired=new Promise<void>(resolve=>{reserved=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const secrets={get:async()=>{reserved();await held;return undefined;},store:async()=>{}};
  const config={ntEmail:'cancel.nt@example.org',serverUrl:'http://127.0.0.1:4184'},owner=new AbortController();
  const active=new PluginState(directory,secrets).identity(config,owner.signal);
  const finished=assert.rejects(active,/state_aborted/);
  try{
    await acquired;const waiting=new AbortController(),started=performance.now();
    const cancelled=assert.rejects(new PluginState(directory,secrets).identity(config,waiting.signal),/state_aborted/);
    setTimeout(()=>waiting.abort(),60);await cancelled;
    assert.ok(performance.now()-started<1000,'cancellation must not wait for the five-second contention budget');
  }finally{owner.abort();release();await finished;}
});

test('windows recovering an interrupted state reservation never allocate duplicate observation sequences',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-interrupted-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const signal=new AbortController().signal,config={ntEmail:'interrupted.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  const state=new PluginState(directory,secrets);await state.identity(config,signal);
  const source=new URL('../src/state.ts',import.meta.url).href;
  for(let attempt=0;attempt<10;attempt++){
    // The SecretStorage boundary holds a real subprocess inside a reservation.
    // Killing this owned process leaves the same interrupted state as an IDE crash.
    const script=`import {PluginState} from ${JSON.stringify(source)};setInterval(()=>{},1000);await new PluginState(process.argv[1],{get:async()=>{process.send('reserved');return new Promise(()=>{});},store:async()=>{}}).identity(${JSON.stringify(config)},new AbortController().signal);`;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,directory],{stdio:['ignore','ignore','ignore','ipc']});
    try{assert.deepEqual(await once(child,'message',{signal:AbortSignal.timeout(5000)}),['reserved',undefined]);}
    finally{const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    // state_busy is a bounded contention result, not a consumed reservation.
    // Slow CI filesystems may exhaust one 5s attempt while 20 peers fsync;
    // retry the caller within an overall deadline, preserving the exclusivity assertion.
    const recoverySignal=AbortSignal.timeout(30000);
    const reserve=async()=>{while(true){try{return await new PluginState(directory,secrets).nextSequence(recoverySignal);}catch(error){if(!(error instanceof Error)||error.message!=='state_busy')throw error;}}};
    const sequences=await Promise.all(Array.from({length:20},reserve));
    assert.equal(new Set(sequences).size,20,'recovery must preserve exclusive sequence reservation');
    assert.deepEqual(sequences.map(Number).sort((a,b)=>a-b),Array.from({length:20},(_,index)=>attempt*20+index+1));
  }
});

test('reinstalling without the local counter starts a new source and cannot reserve under the previous source configuration',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-reinstall-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const signal=new AbortController().signal,config={ntEmail:'reinstall.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  const before=new PluginState(directory,secrets),old=await before.identity(config,signal);assert.equal(await before.nextSequence(signal),'1');
  await rm(join(directory,'state.json'));
  const after=new PluginState(directory,secrets),fresh=await after.identity(config,signal);
  assert.notEqual(fresh.source_secret,old.source_secret);assert.notEqual(fresh.source_config_id,old.source_config_id);
  await assert.rejects(()=>before.nextSequence(signal,old.source_config_id),/source_identity_changed/);
  assert.equal(await after.nextSequence(signal,fresh.source_config_id),'1');
});

test('upload credentials stay in the secret store and a late old-server credential cannot replace the current one',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-credential-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const state=new PluginState(directory,secrets),signal=new AbortController().signal,config={ntEmail:'credential.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  const first=await state.identity(config,signal),token='adi_plugin_v1.synthetic-first-credential';
  await state.storeCredential(config,first.source_config_id,token,signal);
  assert.ok([...values.values()].includes(token));assert.ok(!(await readFile(join(directory,'state.json'),'utf8')).includes(token));
  const changed={...config,serverUrl:'http://127.0.0.1:4195'},second=await state.identity(changed,signal),next='adi_plugin_v1.synthetic-current-credential';
  await state.storeCredential(changed,second.source_config_id,next,signal);
  await assert.rejects(()=>state.storeCredential(config,first.source_config_id,token,signal),/source_identity_changed/);
  assert.deepEqual([...values.values()].filter(value=>value.startsWith('adi_plugin_v1.')),[next],'only one bounded protected credential slot is retained');
});

test('a credential vault write failure propagates without writing the token into local state or resetting source identity',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-vault-failure-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{if(v.startsWith('adi_plugin_v1.'))throw new Error('synthetic_vault_unavailable');values.set(k,v);}};
  const state=new PluginState(directory,secrets),signal=new AbortController().signal,config={ntEmail:'vault.nt@example.org',serverUrl:'http://127.0.0.1:4184'},identity=await state.identity(config,signal),token='adi_plugin_v1.synthetic-unpersisted-credential';
  await assert.rejects(()=>state.storeCredential(config,identity.source_config_id,token,signal),/synthetic_vault_unavailable/);
  assert.ok(![...values.values()].includes(token));assert.ok(!(await readFile(join(directory,'state.json'),'utf8')).includes(token));
  assert.deepEqual(await state.identity(config,signal),identity);assert.equal(await state.nextSequence(signal,identity.source_config_id),'1');
});

test('changing account or platform origin rotates source proof instead of borrowing the previous owner collector',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-source-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));const values=new Map<string,string>(),secrets={get:async(key:string)=>values.get(key),store:async(key:string,value:string)=>{values.set(key,value);}},state=new PluginState(directory,secrets),signal=new AbortController().signal;
 const one=await state.identity({ntEmail:'first@example.org',serverUrl:'http://127.0.0.1:4184'},signal);await state.nextSequence(signal,one.source_config_id);
 const two=await state.identity({ntEmail:'second@example.org',serverUrl:'http://127.0.0.1:4184'},signal);assert.notEqual(one.source_secret,two.source_secret);assert.notEqual(one.source_config_id,two.source_config_id);await assert.rejects(state.nextSequence(signal,one.source_config_id),/source_identity_changed/);assert.equal(await state.nextSequence(signal,two.source_config_id),'2');
});


test('cancellation after storing a rotated proof preserves the previous owner and permits a clean retry',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-source-cancel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const values=new Map<string,string>();let cancelling:AbortController|undefined;
 const secrets={get:async(key:string)=>values.get(key),store:async(key:string,value:string)=>{values.set(key,value);cancelling?.abort();}};
 const state=new PluginState(directory,secrets),signal=new AbortController().signal,config={ntEmail:'first@example.org',serverUrl:'http://127.0.0.1:4184'},changed={...config,ntEmail:'second@example.org'};
 const first=await state.identity(config,signal);assert.equal(await state.nextSequence(signal,first.source_config_id),'1');
 cancelling=new AbortController();await assert.rejects(state.identity(changed,cancelling.signal),/state_aborted/);cancelling=undefined;
 assert.deepEqual(await state.identity(config,signal),first);
 const second=await state.identity(changed,signal);assert.notEqual(second.source_secret,first.source_secret);assert.equal(await state.nextSequence(signal,second.source_config_id),'2');
 const returned=await state.identity(config,signal);assert.notEqual(returned.source_secret,first.source_secret);assert.notEqual(returned.source_secret,second.source_secret);assert.equal(await state.nextSequence(signal,returned.source_config_id),'3');
});


test('a timed out contender does not consume a sequence and can retry after the live owner releases',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-plugin-busy-retry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;}),values=new Map<string,string>();let block=true;
 const secrets={get:async(k:string)=>{if(block){entered();await held;}return values.get(k);},store:async(k:string,v:string)=>{values.set(k,v);}};
 const signal=new AbortController().signal,owner=new PluginState(directory,secrets),peer=new PluginState(directory,secrets),active=owner.identity({ntEmail:'busy-retry@example.org',serverUrl:'http://127.0.0.1:4184'},signal);
 try{await ready;await assert.rejects(peer.nextSequence(signal),/state_busy/);}finally{block=false;release();await active;}
 assert.equal(await peer.nextSequence(signal),'1');assert.equal(await owner.nextSequence(signal),'2');
});
