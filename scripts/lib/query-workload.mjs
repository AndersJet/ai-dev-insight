import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

const bounds=[5,10,25,50,100,200,300,500,750,1000,1500,2000,3000,5000,10000];
const percentile=(histogram,samples,fraction)=>{
 if(!samples)return null;let sum=0;const rank=Math.ceil(samples*fraction);
 for(let i=0;i<histogram.length;i++){sum+=histogram[i];if(sum>=rank)return bounds[i]??null;}
 return null;
};

/** Synthetic loopback HTTP clients. Each client has at most one request in flight. */
export function createQueryWorkload({targets,clients=20,headers={},intervalMs=250,requestTimeoutMs=5000,mode='continuous'}){
 if(!['continuous','burst'].includes(mode))throw new Error('Invalid query workload mode');
 if(!Number.isInteger(clients)||clients<1||clients>20||!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>1000||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<20||requestTimeoutMs>10000)throw new Error('Invalid synthetic query limits');
 if(!Array.isArray(targets)||targets.length<1||targets.length>4||new Set(targets.map(x=>x.name)).size!==targets.length)throw new Error('Invalid synthetic query targets');
 const routes=targets.map(target=>{
  const url=new globalThis.URL(target.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||!/^[a-z_]{1,32}$/.test(target.name))throw new Error('Loopback query target required');
  return {name:target.name,url:url.href,samples:0,errors:0,max_ms:0,histogram:Array(bounds.length+1).fill(0)};
 });
 const clientStats=Array.from({length:clients},(_,id)=>({id,target:routes[id%routes.length].name,completed:0}));
 const startedAt=performance.now();let finishedAt;
 let requests=0,ok=0,errors=0,active=0,peak=0,stopping=false,stopped=false,burstRunning=false,stopPromise;
 const errorCodes={},sleeper=new globalThis.AbortController();
 async function runClient(client){
  const route=routes[client.id%routes.length];
  do{
   const start=performance.now();requests++;active++;peak=Math.max(peak,active);let code=null;
   try{
    const response=await globalThis.fetch(route.url,{headers,signal:globalThis.AbortSignal.timeout(requestTimeoutMs)});
    if(!response.ok){await response.body?.cancel();code='http_'+response.status;}
    else{const body=await response.json();if(!body?.data||typeof body.data!=='object')code='invalid_response';}
   }catch{code='request_failed';}
   const elapsed=performance.now()-start,index=bounds.findIndex(limit=>elapsed<=limit);
   route.histogram[index===-1?bounds.length:index]++;route.samples++;route.max_ms=Math.max(route.max_ms,elapsed);client.completed++;active--;
   if(code){errors++;route.errors++;errorCodes[code]=(errorCodes[code]??0)+1;}else ok++;
   if(!stopping&&mode==='continuous')await delay(intervalMs,undefined,{signal:sleeper.signal}).catch(()=>{});
  }while(!stopping&&mode==='continuous');
 }
 let tasks=mode==='continuous'?clientStats.map(runClient):[];
 return {
  async runBurst(){if(mode!=='burst')throw new Error('Explicit burst mode required');if(stopping)throw new Error('Query workload stopped');if(burstRunning)throw new Error('Query burst already running');burstRunning=true;tasks=clientStats.map(runClient);try{await Promise.all(tasks);}finally{burstRunning=false;}},
  async stop(){if(!stopPromise){stopping=true;sleeper.abort();stopPromise=Promise.all(tasks).then(()=>{stopped=true;finishedAt=performance.now();});}await stopPromise;},
  snapshot(){return {requests,query_ok:ok,query_errors:errors,query_error_codes:{...errorCodes},active_requests:active,peak_active_requests:peak,stopped,mode,interval_ms:mode==='continuous'?intervalMs:null,request_timeout_ms:requestTimeoutMs,elapsed_ms:(finishedAt??performance.now())-startedAt,clients:clientStats.map(x=>({...x})),histogram_bounds_ms:[...bounds],targets:routes.map(({name,samples,errors,max_ms,histogram})=>({name,samples,errors,max_ms,histogram:[...histogram],p95_upper_bound_ms:percentile(histogram,samples,.95),p99_upper_bound_ms:percentile(histogram,samples,.99)}))};}
 };
}

export function assessQuerySlo(measurement){
 const pass=!!measurement&&measurement.stopped===true&&measurement.active_requests===0&&measurement.clients?.length===20&&measurement.peak_active_requests===20&&measurement.clients.every(row=>row.completed>0)&&measurement.query_errors===0&&measurement.requests===measurement.query_ok&&measurement.targets?.length>0&&measurement.targets.every(row=>row.samples>=20&&row.errors===0&&row.p95_upper_bound_ms!==null&&row.p95_upper_bound_ms<=1500);
 return {pass,budget_ms:1500,minimum_samples_per_target:20,scope:'all completed requests over the whole mixed run, including startup; each target assessed separately after clients stop'};
}
