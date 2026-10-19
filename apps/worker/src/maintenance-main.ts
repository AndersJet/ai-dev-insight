import {openDatabase,createRuntimeReporter} from '@adi/storage';
import {createRetentionService,createDatabaseMonitor,createMonitorDelivery} from '@adi/domain';
import {setTimeout as delay} from 'node:timers/promises';
async function main(){
 const enabled=process.env.ADI_MAINTENANCE_ENABLED??'false';if(!['true','false'].includes(enabled))throw new Error('Invalid maintenance configuration');if(enabled==='false'){process.stdout.write('{"event":"maintenance_disabled"}\n');return;}
 const url=process.env.ADI_DATABASE_URL;if(!url)throw new Error('Maintenance database required');const db=openDatabase({connectionString:url,schema:process.env.ADI_DATABASE_SCHEMA??'adi',maxConnections:2}),service=createRetentionService(db),reporter=createRuntimeReporter(db,'maintenance_worker');const delivery=process.env.ADI_ALERT_WEBHOOK_URL?createMonitorDelivery(db,{url:process.env.ADI_ALERT_WEBHOOK_URL,...(process.env.ADI_ALERT_WEBHOOK_TOKEN?{bearerToken:process.env.ADI_ALERT_WEBHOOK_TOKEN}:{})}):null,monitor=createDatabaseMonitor(db,{...(process.env.ADI_STORAGE_BUDGET_BYTES?{storageBudgetBytes:process.env.ADI_STORAGE_BUDGET_BYTES}:{}),...(delivery?{deliveryTarget:delivery.target}:{})});let nextMonitor=0,nextDelivery=0;let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
 try{await db.assertNotRecovering();await reporter.flush();process.stdout.write('{"event":"maintenance_ready"}\n');while(!stopping){
 if(Date.now()>=nextMonitor){nextMonitor=Date.now()+60000;try{await monitor.runOne();}catch{reporter.failure();process.stderr.write('{"code":"database_monitor_failed"}\n');}}
 if(delivery&&Date.now()>=nextDelivery){nextDelivery=Date.now()+1000;try{await delivery.runOne();}catch{reporter.failure();process.stderr.write('{"code":"alert_delivery_failed"}\n');}}
 try{const worked=await service.runOne();if(worked)reporter.success(1);await reporter.flush();await delay(worked?50:1000);}catch{reporter.failure();await reporter.flush();process.stderr.write('{"code":"maintenance_cycle_failed"}\n');await delay(1000);}}}finally{await reporter.flush(true);await db.close();}
}
try{await main();}catch{process.stderr.write('{"code":"maintenance_start_failed"}\n');process.exitCode=1;}
