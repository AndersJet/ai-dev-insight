import {performance} from 'node:perf_hooks';

const bounds=[1,5,10,25,50,100,200,300,500,700,1000,2000];

// Test-harness observation only. No request contents or per-request history is retained.
export function createBodyResponseTiming(now=()=>performance.now()) {
 let samples=0,max=0,early=0,aborted=0,active=0,buckets=Array(bounds.length+1).fill(0);
 function percentile(ratio) {
  if(!samples)return null;
  const rank=Math.ceil(samples*ratio);let accumulated=0;
  for(let i=0;i<buckets.length;i++){accumulated+=buckets[i];if(accumulated>=rank)return bounds[i]??null;}
  return null;
 }
 return {
  observe(req,res) {
   active++;let bodyAt,done=false;
   const end=()=>{bodyAt=now();};
   const detach=()=>{req.off('end',end);res.off('finish',finish);res.off('close',close);};
   const finish=()=>{
    if(done)return;done=true;active--;detach();
    if(bodyAt===undefined){early++;return;}
    const elapsed=now()-bodyAt;if(!Number.isFinite(elapsed)||elapsed<0)return;
    samples++;max=Math.max(max,elapsed);const index=bounds.findIndex(bound=>elapsed<=bound);buckets[index<0?bounds.length:index]++;
   };
   const close=()=>{if(done)return;done=true;active--;aborted++;detach();};
   req.once('end',end);res.once('finish',finish);res.once('close',close);
  },
  reset(){if(active)throw new Error('Requests are still in flight');samples=0;max=0;early=0;aborted=0;buckets=Array(bounds.length+1).fill(0);},
  snapshot(){return {samples,active_requests:active,finished_before_body:early,aborted_responses:aborted,max_ms:samples?max:null,p95_upper_bound_ms:percentile(0.95),p99_upper_bound_ms:percentile(0.99),histogram_upper_bounds_ms:[...bounds,null],histogram_counts:[...buckets]};},
 };
}

export function assessBodyResponseSlo(measurement,expected) {
 const valid=Number.isSafeInteger(expected)&&expected>0&&measurement?.samples===expected&&measurement.active_requests===0&&measurement.finished_before_body===0&&measurement.aborted_responses===0;
 return {expected_samples:expected,p95_budget_ms:100,p99_budget_ms:300,
  pass:Boolean(valid&&measurement.p95_upper_bound_ms!==null&&measurement.p95_upper_bound_ms<=100&&measurement.p99_upper_bound_ms!==null&&measurement.p99_upper_bound_ms<=300),
  scope:'IncomingMessage end to ServerResponse finish; excludes upload, TCP/TLS setup and real IDE host overhead; histogram percentile upper bounds'};
}
