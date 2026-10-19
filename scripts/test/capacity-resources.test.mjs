import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backgroundCpuLimits} from '../lib/capacity-resources.mjs';

test('unspecified workload quotas retain the existing API and jobs allocation',()=>{
 assert.deepEqual(backgroundCpuLimits({}),{api:0.5,jobs:0.25});
});
test('explicit API and jobs quotas allow the measured resource split without changing either default implicitly',()=>{
 assert.deepEqual(backgroundCpuLimits({ADI_CAPACITY_API_CPUS:'0.25',ADI_CAPACITY_JOBS_CPUS:'0.1'}),{api:0.25,jobs:0.1});
 assert.deepEqual(backgroundCpuLimits({ADI_CAPACITY_API_CPUS:'0.1'}),{api:0.1,jobs:0.25});
 assert.deepEqual(backgroundCpuLimits({ADI_CAPACITY_JOBS_CPUS:'1'}),{api:0.5,jobs:1});
});
test('unbounded, nonfinite and malformed background quotas fail before starting a container',()=>{
 for(const key of ['ADI_CAPACITY_API_CPUS','ADI_CAPACITY_JOBS_CPUS']){
  for(const value of ['', '0','-1','0.09','1.01','Infinity','NaN','not-a-number'])assert.throws(()=>backgroundCpuLimits({[key]:value}),/CPU quota/);
 }
});

test('daily checks count as mixed load only when a successful check overlaps a fully admitted pending collector queue',async()=>{
 const {assessTokenCheckOverlap}=await import('../lib/capacity-resources.mjs');
 const samples=[{sampled_at_ms:100,delivery:{admitted:2000,retainedItems:10}},{sampled_at_ms:200,delivery:{admitted:2000,retainedItems:2}}];
 const checked={token_check_errors:0,token_check_window_overflow:false,token_check_windows:[{started_at_ms:120,finished_at_ms:160}]};
 assert.equal(assessTokenCheckOverlap(samples,checked,2000).pass,true);
 assert.equal(assessTokenCheckOverlap(samples,{...checked,token_check_windows:[{started_at_ms:20,finished_at_ms:80}]},2000).pass,false);
 assert.equal(assessTokenCheckOverlap(samples,{...checked,token_check_windows:[{started_at_ms:220,finished_at_ms:250}]},2000).pass,false);
 assert.equal(assessTokenCheckOverlap(samples,{...checked,token_check_errors:1},2000).pass,false);
 assert.equal(assessTokenCheckOverlap(samples,{...checked,token_check_window_overflow:true},2000).pass,false);
 assert.equal(assessTokenCheckOverlap(samples.map(s=>({...s,delivery:{...s.delivery,admitted:1999}})),checked,2000).pass,false);
 assert.equal(assessTokenCheckOverlap(samples,{...checked,token_check_windows:[]},2000).pass,false);
});

test('catch-up requires the complete expected task population, not just an empty runnable queue',async()=>{
 const {assessBackgroundCatchup}=await import('../lib/capacity-resources.mjs');
 const done=[{kind:'derive_session',status:'succeeded',jobs:1000},{kind:'session_token_check',status:'succeeded',jobs:500}],options={checksEnabled:true,derivations:1000,checks:500};
 assert.equal(assessBackgroundCatchup(done,options).pass,true);
 assert.equal(assessBackgroundCatchup([],options).pass,false);
 assert.equal(assessBackgroundCatchup([done[0],{...done[1],status:'queued'}],options).pass,false);
 assert.equal(assessBackgroundCatchup([done[0],{...done[1],status:'failed'}],options).pass,false);
 assert.equal(assessBackgroundCatchup([{...done[0],status:'cancelled'},done[1]],options).pass,false);
 assert.equal(assessBackgroundCatchup([done[0],{...done[1],status:'queued'}],{...options,checksEnabled:false}).pass,true);
});
