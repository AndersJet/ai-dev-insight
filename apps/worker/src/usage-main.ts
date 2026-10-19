import {openDatabase,createRuntimeReporter} from '@adi/storage';
import {createTraeUsageProvider,createUsageRequestGate,createUsageSyncService,createUsageAttributionJobs,createUsageModelChecks} from '@adi/domain';
import {setTimeout as delay} from 'node:timers/promises';
async function main(){
 const flag=process.env.ADI_USAGE_ENABLED??'false';if(!['true','false'].includes(flag))throw new Error('Invalid usage configuration');
 if(flag==='false'){process.stdout.write(JSON.stringify({event:'usage_worker_disabled'})+'\n');return;}
 const url=process.env.ADI_DATABASE_URL;const account=process.env.ADI_USAGE_PROVIDER_ACCOUNT;const appId=process.env.TRAE_OPENAPI_APP_ID;const appSecret=process.env.TRAE_OPENAPI_APP_SECRET;
 const stopWindow=process.env.ADI_USAGE_STOP_WINDOW_ENABLED??'false';if(!['true','false'].includes(stopWindow))throw new Error('Invalid usage configuration');
 const interval=Number(process.env.ADI_USAGE_MIN_INTERVAL_MS??500);const discovery=process.env.ADI_USAGE_DISCOVERY??'true';
 if(!url||!account||!appId||!appSecret||!['true','false'].includes(discovery)||!Number.isInteger(interval)||interval<(process.env.NODE_ENV==='test'?20:250)||interval>5000)throw new Error('Invalid usage configuration');
 const db=openDatabase({connectionString:url,schema:process.env.ADI_DATABASE_SCHEMA??'adi',maxConnections:2});const reporter=createRuntimeReporter(db,'usage_worker');let stopping=false;
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;});
 try{
  await db.assertNotRecovering();
  const gate=createUsageRequestGate(db,{providerAccount:account,intervalMs:interval});
  await gate.initialize();
  const provider=createTraeUsageProvider({baseUrl:process.env.TRAE_OPENAPI_BASE_URL??'https://console.enterprise.trae.cn',appId,appSecret,timeoutMs:Math.min(30000,Math.max(10000,interval*4+2000)),beforeRequest:async signal=>{await gate.acquire(signal);await db.assertNotRecovering();}});
  const sync=createUsageSyncService(db,{providerAccount:account,provider,leaseMs:60000,stopping:()=>stopping,onRateLimit:gate.pause});
  const attribution=createUsageAttributionJobs(db,{providerAccount:account,provider:stopWindow==='true'?provider:{getSessionUsage:provider.getSessionUsage},stopping:()=>stopping,onRateLimit:gate.pause});
  const modelChecks=createUsageModelChecks(db,{providerAccount:account,provider,stopping:()=>stopping,onRateLimit:gate.pause});let modelTurn=0;
  await reporter.flush();process.stdout.write(JSON.stringify({event:'usage_worker_ready'})+'\n');
  while(!stopping){
   try{
    await db.assertNotRecovering();const found=discovery==='true'?await sync.discoverRecent()+await attribution.discoverRecent()+await modelChecks.discoverRecent():0;
    const worked=await sync.runOne(),linked=await attribution.runOne();
    // Model summaries have an independent daily cadence and a bounded share of
    // a busy queue; all three sources still pass through the same HTTP gate.
    const checked=(++modelTurn%16===0||(!worked&&!linked))?await modelChecks.runOne():false;
    const pruned=await sync.pruneTransient();reporter.success(Number(worked)+Number(linked)+Number(checked)+Number(pruned));await reporter.flush();if(!found&&!worked&&!linked&&!checked&&!pruned)await delay(300);
   }
   catch{reporter.failure();await reporter.flush();process.stderr.write(JSON.stringify({level:'error',code:'usage_poll_failed'})+'\n');await delay(1000);}
  }
 }finally{await reporter.flush(true);await db.close();}
}
try{await main();}catch{process.stderr.write(JSON.stringify({level:'error',code:'usage_worker_start_failed'})+'\n');process.exitCode=1;}
