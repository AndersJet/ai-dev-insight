import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProjectCollector,type ProbeResult,type RuntimeHost} from '../src/collector.js';
import type {PluginObservation} from '../../packages/contracts/src/plugin-tracking.js';

const PERIOD=1800000;
const config={ntEmail:'policy.nt@example.org',serverUrl:'http://127.0.0.1:4184'};
const root='/synthetic/project';
const repository=(address='https://git.example.invalid/team/project.git',git_root=root):ProbeResult=>({state:'repository',reason:null,git_root,remotes:[{address}]});
const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(overrides:Partial<RuntimeHost>={}){
  let now=Date.now(),sequence=0,probes=0;
  const jobs=new Set<{at:number;fn:()=>void}>(),sent:PluginObservation[]=[];
  let result:ProbeResult=repository();
  const collector=new ProjectCollector({
    clock:{now:()=>now,schedule:(fn,ms)=>{const job={at:now+ms,fn};jobs.add(job);return ()=>{jobs.delete(job);};}},random:()=>0,
    identity:async()=>({source_secret:'s'.repeat(43),source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01'}),
    nextSequence:async()=>String(++sequence),
    register:async input=>({collector_id:'790a9543-b4f2-4c99-97dc-7ac6688b5c9d',nt_email:input.nt_email,token:'synthetic-only'}),
    probe:async()=>{probes++;return result;},
    submit:async event=>{sent.push(event);return {outcome:'saved',observation_id:event.observation_id,received_at:new Date(now).toISOString()};},
    ...overrides,
  });
  return {collector,sent,setResult:(value:ProbeResult)=>{result=value;},probes:()=>probes,sequences:()=>sequence,
    advance:async(ms:number)=>{now+=ms;for(const job of [...jobs])if(job.at<=now){jobs.delete(job);job.fn();}await wait();},
    open:async(roots=[root])=>{collector.configure(config,roots,true);await wait();},
  };
}

test('each real thirty-minute probe carries a fresh sequence so a cleared baseline can be restored',async t=>{
  const f=fixture();t.after(()=>f.collector.dispose());await f.open();
  assert.equal(f.sent.length,1);await f.advance(PERIOD-1);assert.equal(f.probes(),1);
  await f.advance(1);assert.equal(f.probes(),2);assert.equal(f.sent.length,2);
  await f.advance(PERIOD);assert.equal(f.probes(),3);assert.equal(f.sent.length,3);assert.equal(f.sequences(),3);assert.equal(new Set(f.sent.map(item=>item.observation_id)).size,3);
});

test('a fresh probe sends its independently timed fact for server-side normalized change compression',async t=>{
  const f=fixture();t.after(()=>f.collector.dispose());
  f.setResult({...repository(),remotes:[{address:'https://git.example.invalid/team/a.git'},{address:'https://git.example.invalid/team/b.git'}]});await f.open();
  f.setResult({...repository(),remotes:[{address:'https://user:synthetic@git.example.invalid/team/b.git?token=synthetic'},{address:'https://git.example.invalid/team/a.git'},{address:'https://git.example.invalid/team/a.git'}]});
  await f.advance(PERIOD);assert.equal(f.sent.length,2);assert.notEqual(f.sent[0]!.observation_id,f.sent[1]!.observation_id);
});

test('address, Git root, remote removal and Git association changes are reported once each',async t=>{
  const f=fixture();t.after(()=>f.collector.dispose());await f.open();
  for(const result of [repository('https://git.example.invalid/team/new.git'),repository('https://git.example.invalid/team/new.git','/synthetic/other-root'),{state:'no_remote',reason:null,git_root:root,remotes:[]} as ProbeResult,{state:'not_git',reason:null,git_root:null,remotes:[]} as ProbeResult,repository()]){
    f.setResult(result);await f.advance(PERIOD);assert.deepEqual(f.sent.at(-1)?.remotes,result.remotes);assert.equal(f.sent.at(-1)?.state,result.state);
  }
  assert.equal(f.sent.length,6);await f.advance(PERIOD);assert.equal(f.sent.length,7);
});

test('failed facts and recovery facts are submitted independently while history compression remains server-owned',async t=>{
  const f=fixture();t.after(()=>f.collector.dispose());
  f.setResult({state:'failed',reason:'git_missing',git_root:null,remotes:[]});await f.open();
  assert.equal(f.sent.length,1);assert.equal(f.collector.status().queued,0);
  await f.advance(PERIOD);assert.equal(f.sent.length,2);
  f.setResult(repository());await f.advance(PERIOD);
  f.setResult({state:'failed',reason:'timeout',git_root:null,remotes:[]});await f.advance(PERIOD);
  f.setResult(repository());await f.advance(PERIOD);assert.deepEqual(f.sent.map(item=>item.state),['failed','failed','repository','failed','repository']);
});

test('a throwing probe does not stop the other opened projects or retry before the next period',async t=>{
  let probes=0;const f=fixture({probe:async workspace=>{probes++;if(workspace===root)throw new Error('synthetic probe failure');return repository();}});t.after(()=>f.collector.dispose());
  await f.open([root,'/synthetic/second']);assert.equal(probes,2);assert.equal(f.sent.length,2);assert.deepEqual(f.sent.map(item=>item.state),['failed','repository']);
  await f.advance(30000);assert.equal(probes,2);await f.advance(PERIOD-30000);assert.equal(probes,4);assert.equal(f.sent.length,4);
});

test('exhausted transport retries are followed by a fresh probe and observation, never the old event',async t=>{
  const attempts:PluginObservation[]=[];let available=false;
  const f=fixture({submit:async event=>{attempts.push(event);if(!available)throw new Error('offline');return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});t.after(()=>f.collector.dispose());
  await f.open();await f.advance(30000);await f.advance(60000);
  assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(event=>event.observation_id)).size,1);assert.equal(f.collector.status().queued,0);
  available=true;await f.advance(PERIOD-90000);assert.equal(attempts.length,4);
  assert.notEqual(attempts[3]!.observation_id,attempts[0]!.observation_id);assert.notEqual(attempts[3]!.observed_at,attempts[0]!.observed_at);
  await f.advance(PERIOD);assert.equal(attempts.length,5);
});

test('a return to the confirmed repository cancels an obsolete pending change across a long server wait',async t=>{
  const attempts:PluginObservation[]=[];let limited=false;
  const f=fixture({submit:async event=>{attempts.push(event);if(limited)throw Object.assign(new Error('limited'),{status:429,retryAfterMs:2*PERIOD});return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});t.after(()=>f.collector.dispose());
  await f.open();limited=true;f.setResult(repository('https://git.example.invalid/team/b.git'));await f.advance(PERIOD);assert.equal(f.collector.status().queued,1);
  limited=false;f.setResult(repository());await f.advance(PERIOD);assert.equal(f.collector.status().queued,1);
  await f.advance(PERIOD);assert.equal(attempts.length,3);assert.equal(attempts[2]!.remotes[0]!.address,'https://git.example.invalid/team/project.git');assert.notEqual(attempts[2]!.observation_id,attempts[1]!.observation_id);
});

test('a failed new probe retires a previous cycle pending result during a long retry wait',async t=>{
  const attempts:PluginObservation[]=[];
  const f=fixture({submit:async event=>{attempts.push(event);throw Object.assign(new Error('limited'),{status:429,retryAfterMs:2*PERIOD});}});t.after(()=>f.collector.dispose());
  await f.open();f.setResult({state:'failed',reason:'timeout',git_root:null,remotes:[]});await f.advance(PERIOD);
  assert.equal(f.collector.status().queued,1);await f.advance(PERIOD);assert.equal(attempts.length,2);assert.equal(attempts[1]!.state,'failed');assert.notEqual(attempts[1]!.observation_id,attempts[0]!.observation_id);
});

test('starting a cycle retires all due roots before flushing, including roots probed later in the cycle',async t=>{
  const attempts:PluginObservation[]=[];let available=false;
  const f=fixture({probe:async workspace=>{if(available&&workspace!==root)return {state:'failed',reason:'timeout',git_root:null,remotes:[]};return repository();},submit:async event=>{attempts.push(event);if(!available)throw Object.assign(new Error('limited'),{status:429,retryAfterMs:PERIOD});return {outcome:'saved',observation_id:event.observation_id,received_at:new Date().toISOString()};}});t.after(()=>f.collector.dispose());
  await f.open([root,'/synthetic/later']);assert.equal(f.collector.status().queued,2);
  available=true;await f.advance(PERIOD);
  assert.equal(attempts.length,3);assert.equal(attempts[2]!.workspace_path,'/synthetic/later');assert.equal(attempts[2]!.state,'failed');assert.notEqual(attempts[2]!.observed_at,attempts[0]!.observed_at);assert.equal(f.collector.status().queued,0);
});

test('reopening roots, restoring trust or configuration, and a new window each permit an initial observation',async t=>{
  const f=fixture();t.after(()=>f.collector.dispose());await f.open();
  await f.open([]);await f.open();assert.equal(f.sent.length,2);
  f.collector.configure(config,[root],false);await f.open();assert.equal(f.sent.length,3);
  f.collector.configure({...config,ntEmail:''},[root],true);await f.open();assert.equal(f.sent.length,4);
  await f.open([root,'/synthetic/new']);assert.equal(f.sent.length,5);
  const other=fixture();t.after(()=>other.collector.dispose());await other.open();assert.equal(other.sent.length,1);
});
