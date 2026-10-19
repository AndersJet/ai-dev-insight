import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProjectCollector} from '../src/collector.js';
import {PluginState} from '../src/state.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

class ManualClock {
  time=Date.now();private jobs=new Map<number,{at:number;fn:()=>void}>();private id=0;
  now=()=>this.time;
  schedule=(fn:()=>void,ms:number)=>{const id=++this.id;this.jobs.set(id,{at:this.time+ms,fn});return ()=>{this.jobs.delete(id);};};
  advance(ms:number){this.time+=ms;for(const [id,job] of [...this.jobs])if(job.at<=this.time){this.jobs.delete(id);job.fn();}}
}

test('an active host re-registers after counter recovery and never submits new observations under its cached old source',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-plugin-source-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map<string,string>(),secrets={get:async(k:string)=>values.get(k),store:async(k:string,v:string)=>{values.set(k,v);}};
  const state=new PluginState(directory,secrets),signal=new AbortController().signal,config={ntEmail:'recovery.nt@example.org',serverUrl:'http://127.0.0.1:4184'},old=await state.identity(config,signal),clock=new ManualClock();
  const sent:{collector_id:string;sequence:string;source_config_id:string}[]=[];
  const collector=new ProjectCollector({clock,random:()=>0,identity:(settings,active)=>state.identity(settings,active),nextSequence:(active,sourceConfigId?:string)=>state.nextSequence(active,sourceConfigId),register:async input=>({collector_id:input.source_secret===old.source_secret?'790a9543-b4f2-4c99-97dc-7ac6688b5c9d':'380a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:input.nt_email,token:'synthetic-only'}),probe:async()=>({state:sent.length?'no_remote':'not_git',reason:null,git_root:sent.length?'/synthetic/recovery':null,remotes:[]}),submit:async event=>{sent.push(event);return {outcome:'saved',observation_id:event.observation_id,received_at:new Date(clock.now()).toISOString()};}});
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+1000;while(!predicate()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),'recovery must complete through the public collector boundary');};
  try{
    collector.configure(config,['/synthetic/recovery'],true);await wait(()=>collector.status().state==='active');assert.equal(sent.length,1);
    await rm(join(directory,'state.json'));const recovered=await new PluginState(directory,secrets).identity(config,signal);
    clock.advance(1800000);await wait(()=>collector.status().state==='unavailable');assert.equal(sent.length,1);
    clock.advance(30000);await wait(()=>collector.status().state==='active'&&sent.length===2);
    assert.equal(sent[1]!.collector_id,'380a9543-b4f2-4c99-97dc-7ac6688b5c9d');assert.equal(sent[1]!.source_config_id,recovered.source_config_id);assert.equal(sent[1]!.sequence,'1');
  }finally{collector.dispose();}
});

test('a missing or malformed email leaves collection unconfigured without blocking the caller',()=>{
  const collector=new ProjectCollector();
  for(const ntEmail of ['', 'wrong@@example.org', 'wrong@example', 'wrong name@example.org']){
    collector.configure({ntEmail,serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    assert.equal(collector.status().state,'needs_configuration');
  }
  collector.dispose();
});

test('workspace events cannot bypass registration backoff while the backend is unavailable',async()=>{
  const clock=new ManualClock();let registrations=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>{registrations++;throw new Error('unavailable');},probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async event=>({outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()})});
  const config={ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  try{
    collector.configure(config,['/synthetic/one'],true);await new Promise(r=>setTimeout(r,10));assert.equal(registrations,1);
    collector.configure(config,['/synthetic/one','/synthetic/two'],true);await new Promise(r=>setTimeout(r,10));assert.equal(registrations,1);
    clock.advance(30000);await new Promise(r=>setTimeout(r,10));assert.equal(registrations,2);
  }finally{collector.dispose();}
});

test('transient retry delays include bounded jitter instead of synchronizing all clients',async()=>{
  const clock=new ManualClock();let registrations=0;
  const collector=new ProjectCollector({clock,random:()=>1,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>{registrations++;throw new Error('unavailable');},probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async event=>({outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()})});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));clock.advance(30000);await new Promise(r=>setTimeout(r,10));assert.equal(registrations,1);clock.advance(3000);await new Promise(r=>setTimeout(r,10));assert.equal(registrations,2);}finally{collector.dispose();}
});

test('a permanently invalid observation is dropped without repeatedly uploading it',async()=>{
  const clock=new ManualClock();let submitted=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{submitted++;throw Object.assign(new Error('invalid observation'),{status:400});}});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));assert.equal(collector.status().queued,0);assert.equal(collector.status().dropped,1);clock.advance(30000);await new Promise(r=>setTimeout(r,10));assert.equal(submitted,1);}finally{collector.dispose();}
});

test('a failed observation is abandoned after exactly three attempts rather than retained forever',async()=>{
  const clock=new ManualClock();let submitted=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{submitted++;throw new Error('offline');}});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));clock.advance(30000);await new Promise(r=>setTimeout(r,10));clock.advance(60000);await new Promise(r=>setTimeout(r,10));assert.equal(submitted,3);assert.equal(collector.status().queued,0);assert.equal(collector.status().dropped,1);clock.advance(120000);await new Promise(r=>setTimeout(r,10));assert.equal(submitted,3);}finally{collector.dispose();}
});

test('offline cache also enforces its byte budget before the project count limit',async()=>{
  let sequence=0;
  const remotes=Array.from({length:64},(_,n)=>({name:`remote${n}`,direction:'fetch' as const,address:'https://git.example.invalid/'+ 'x'.repeat(4000)}));
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'repository',reason:null,git_root:'/synthetic',remotes}),submit:async()=>{throw new Error('offline');}});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},Array.from({length:10},(_,n)=>`/synthetic/big-${n}`),true);const until=Date.now()+500;while(sequence<10&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.equal(sequence,10);assert.ok(collector.status().queuedBytes<=1048576);assert.ok(collector.status().queued<10);assert.ok(collector.status().dropped>0);}finally{collector.dispose();}
});

test('an NT mailbox change aborts old work and never relabels its pending observation',async()=>{
  const sent:string[]=[];let release:(()=>void)|undefined,oldSignal:AbortSignal|undefined,sequence=0;
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async input=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:input.nt_email,token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async(event,_token,_url,signal)=>{sent.push(event.nt_email);if(event.nt_email==='old.nt@example.org'){oldSignal=signal;await new Promise<void>(resolve=>{release=resolve;});}return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});
  try{collector.configure({ntEmail:'old.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));collector.configure({ntEmail:'new.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);assert.equal(oldSignal?.aborted,true);assert.equal(collector.status().queued,0);release?.();await new Promise(r=>setTimeout(r,15));assert.deepEqual(sent,['old.nt@example.org','new.nt@example.org']);}finally{collector.dispose();release?.();}
});

test('closing a workspace cancels its active Git probe immediately without reporting a closed project',async()=>{
  let signal:AbortSignal|undefined,release:(()=>void)|undefined,submitted=0;
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async(_root,activeSignal)=>{signal=activeSignal;await new Promise<void>(resolve=>{release=resolve;});return {state:'not_git',reason:null,git_root:null,remotes:[]};},submit:async event=>{submitted++;return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});
  const config={ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  try{collector.configure(config,['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));collector.configure(config,[],true);assert.equal(signal?.aborted,true);release?.();await new Promise(r=>setTimeout(r,10));assert.equal(submitted,0);}finally{collector.dispose();release?.();}
});

test('offline project observations remain bounded to one hundred latest in-memory items',async()=>{
  let sequence=0;const roots=Array.from({length:130},(_,n)=>`/synthetic/offline-${n}`);
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{throw new Error('offline');}});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},roots,true);const until=Date.now()+500;while(sequence<130&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.equal(sequence,130);assert.equal(collector.status().queued,100);assert.ok(collector.status().queuedBytes<=1048576);assert.equal(collector.status().dropped,30);collector.dispose();assert.equal(collector.status().queued,0);}finally{collector.dispose();}
});

test('workspace updates coalesce while a slow probe is still running and never start a second concurrent probe',async()=>{
  let active=0,maximum=0,sequence=0;const releases:(()=>void)[]=[];
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>{active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>releases.push(resolve));active--;return {state:'not_git',reason:null,git_root:null,remotes:[]};},submit:async(event)=>({outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()})});
  const config={ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  try{collector.configure(config,['/synthetic/one'],true);await new Promise(r=>setTimeout(r,10));collector.configure(config,['/synthetic/one','/synthetic/two'],true);await new Promise(r=>setTimeout(r,10));assert.equal(maximum,1);}
  finally{collector.dispose();for(const release of releases)release();}
});

test('rate limiting honors the server retry delay rather than hammering it at the shorter local delay',async()=>{
  const clock=new ManualClock();let submissions=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{submissions++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:60000});}});
  try{collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));clock.advance(30000);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,1);clock.advance(30000);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,2);}finally{collector.dispose();}
});

test('an explicit authorization rejection pauses collection instead of re-registering or retrying the same source',async()=>{
  const clock=new ManualClock();let submissions=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{submissions++;throw Object.assign(new Error('authorization rejected'),{status:401});}});
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));
    assert.equal(collector.status().state,'paused');clock.advance(1800000);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,1);
  }finally{collector.dispose();}
});

test('periodic collection waits thirty minutes and stopping the collector cancels future work',async()=>{
  const clock=new ManualClock(),paths:string[]=[];let sequence=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async workspace=>{paths.push(workspace);return {state:'not_git',reason:null,git_root:null,remotes:[]};},submit:async(event)=>{return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    await new Promise(r=>setTimeout(r,10));assert.equal(paths.length,1);
    clock.advance(1799999);await new Promise(r=>setTimeout(r,5));assert.equal(paths.length,1);
    clock.advance(1);await new Promise(r=>setTimeout(r,10));assert.equal(paths.length,2);
    collector.dispose();clock.advance(1800000);await new Promise(r=>setTimeout(r,5));assert.equal(paths.length,2);
  }finally{collector.dispose();}
});

test('a temporary backend failure retains the original observation and retries it after a bounded delay',async()=>{
  const clock=new ManualClock();let sequence=0,available=false;const attempts:{observation_id:string;observed_at:string}[]=[];
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async(event)=>{attempts.push({observation_id:event.observation_id,observed_at:event.observed_at});if(!available)throw new Error('network unavailable');return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    await new Promise(r=>setTimeout(r,10));assert.equal(attempts.length,1);assert.equal(collector.status().queued,1);
    available=true;clock.advance(29999);await new Promise(r=>setTimeout(r,5));assert.equal(attempts.length,1);
    clock.advance(1);await new Promise(r=>setTimeout(r,10));assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);assert.equal(collector.status().queued,0);
  }finally{collector.dispose();}
});

test('adding a workspace reports the new root without immediately re-probing the existing root',async()=>{
  const paths:string[]=[];let sequence=0;
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async(event)=>{paths.push(event.workspace_path);return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});
  const config={ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
  try{
    collector.configure(config,['/synthetic/one'],true);
    const wait=async(n:number)=>{const until=Date.now()+500;while(paths.length<n&&Date.now()<until)await new Promise(r=>setTimeout(r,5));};
    await wait(1);collector.configure(config,['/synthetic/one','/synthetic/two'],true);await wait(2);
    assert.deepEqual(paths,['/synthetic/one','/synthetic/two']);
  }finally{collector.dispose();}
});

test('valid NT configuration registers and asynchronously reports an opened project while preserving its observation time',async()=>{
  const sent:unknown[]=[];
  const collector=new ProjectCollector({
    identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),
    nextSequence:async()=> '1',
    register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),
    probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),
    submit:async(event)=>{sent.push(event);return {outcome:'saved',observation_id:event.observation_id,received_at:'2026-10-04T01:00:00.000Z'};},
  });
  try{
    collector.configure({ntEmail:'Test.NT@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    const limit=Date.now()+500;while(!sent.length&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(sent.length,1,'opened project should reach the remote reporting boundary');
    const event=sent[0] as {workspace_path:string;nt_email:string;sequence:string;observed_at:string;state:string};
    assert.equal(event.workspace_path,'/synthetic/project');assert.equal(event.nt_email,'test.nt@example.org');assert.equal(event.sequence,'1');assert.equal(event.state,'not_git');assert.ok(Number.isFinite(Date.parse(event.observed_at)));
  }finally{collector.dispose();}
});

test('time spent registering or sending cannot skip the next thirty-minute project observation',async()=>{
  const clock=new ManualClock();let sequence=0;const observed:string[]=[];
  const collector=new ProjectCollector({clock,
    identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),
    nextSequence:async()=>String(++sequence),
    register:async()=>{clock.advance(150);return {collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'};},
    probe:async()=>{observed.push(new Date(clock.now()).toISOString());return {state:'not_git',reason:null,git_root:null,remotes:[]};},
    submit:async event=>{clock.advance(100);return {outcome:'saved',observation_id:event.observation_id,received_at:new Date(clock.now()).toISOString()};},
  });
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    await new Promise(r=>setTimeout(r,10));assert.equal(observed.length,1);
    clock.advance(1799750);await new Promise(r=>setTimeout(r,10));assert.equal(observed.length,1);
    clock.advance(150);await new Promise(r=>setTimeout(r,10));assert.equal(observed.length,2,'a nonzero registration delay must not turn thirty-minute sampling into sixty-minute sampling');
    assert.equal(Date.parse(observed[1]!)-Date.parse(observed[0]!),1800000);
  }finally{collector.dispose();}
});

test('a local state failure at a periodic deadline respects backoff without a zero-delay retry loop',async()=>{
  const clock=new ManualClock();let allocations=0;
  const collector=new ProjectCollector({clock,random:()=>0,
    identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),
    nextSequence:async()=>{allocations++;if(allocations>1)throw new Error('synthetic local state unavailable');return '1';},
    register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),
    probe:async()=>({state:allocations?'no_remote':'not_git',reason:null,git_root:allocations?'/synthetic/project':null,remotes:[]}),
    submit:async event=>({outcome:'saved',observation_id:event.observation_id,received_at:new Date(clock.now()).toISOString()}),
  });
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);
    await new Promise(r=>setTimeout(r,10));clock.advance(1800000);await new Promise(r=>setTimeout(r,10));
    assert.equal(allocations,2);assert.equal(collector.status().state,'unavailable');
    clock.advance(0);await new Promise(r=>setTimeout(r,10));assert.equal(allocations,2,'an overdue observation must not override local-state failure backoff');
    clock.advance(29999);await new Promise(r=>setTimeout(r,10));assert.equal(allocations,2);
    clock.advance(1);await new Promise(r=>setTimeout(r,10));assert.equal(allocations,3);
  }finally{collector.dispose();}
});

test('a one-hour server retry hint is not shortened and periodic collection keeps its waiting status',async()=>{
  const clock=new ManualClock();let sequence=0,submissions=0;
  const collector=new ProjectCollector({clock,random:()=>0,identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=>String(++sequence),register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{submissions++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:3600000});}});
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,10));
    clock.advance(1800000);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,1,'the backend must not be contacted before its one-hour deadline');assert.equal(collector.status().state,'retrying');
    clock.advance(1799999);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,1);
    clock.advance(1);await new Promise(r=>setTimeout(r,10));assert.equal(submissions,2);
  }finally{collector.dispose();}
});

test('a long server wait does not overflow the actual Node timer into a busy retry loop',async()=>{
  const warnings:Error[]=[];const capture=(warning:Error)=>{if(warning.name==='TimeoutOverflowWarning')warnings.push(warning);};process.on('warning',capture);
  const collector=new ProjectCollector({identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),nextSequence:async()=> '1',register:async()=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:'test.nt@example.org',token:'synthetic-only'}),probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),submit:async()=>{throw Object.assign(new Error('limited'),{status:429,retryAfterMs:2592000000});}});
  try{
    collector.configure({ntEmail:'test.nt@example.org',serverUrl:'http://127.0.0.1:4184'},['/synthetic/project'],true);await new Promise(r=>setTimeout(r,20));
    assert.equal(warnings.length,0,'a thirty-day server hint must not become a one-millisecond Node timer');assert.equal(collector.status().state,'retrying');
  }finally{collector.dispose();process.removeListener('warning',capture);}
});
