import {once} from 'node:events';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setInterval,clearInterval} from 'node:timers';
import {setTimeout as delay} from 'node:timers/promises';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {createBodyResponseTiming} from './lib/body-response-timing.mjs';
import {createCollector} from '../apps/collector/dist/http.js';
import {startDatabaseConsumer} from '../apps/collector/dist/database-consumer.js';

const connectionString=process.env.ADI_TEST_DATABASE_URL,target=new URL(connectionString),container=process.env.ADI_CAPACITY_CONTAINER==='true';
if(!(['127.0.0.1','localhost'].includes(target.hostname)&&target.port==='55438'||(container||process.env.CI==='true')&&target.hostname==='postgres-test'&&target.port==='5432')||target.username!=='adi_test'||target.pathname!=='/adi_test'||target.search||target.hash)throw new Error('Isolated test database required');
let consumer,intake,timer,input;let started=false,stopping=false,connections=0,peakConnections=0,active=0,peakActive=0,firstArrival=null,lastArrival=null;
const lag=monitorEventLoopDelay({resolution:10});lag.enable();const cpuStart=process.cpuUsage(),peaks={rss:0,heap_used:0,queue_items:0,queue_bytes:0,in_flight:0};
const bootId=randomUUID(),bodyTiming=createBodyResponseTiming();
function snapshot(){const memory=process.memoryUsage(),delivery=consumer.queue.snapshot();peaks.rss=Math.max(peaks.rss,memory.rss);peaks.heap_used=Math.max(peaks.heap_used,memory.heapUsed);peaks.queue_items=Math.max(peaks.queue_items,delivery.retainedItems);peaks.queue_bytes=Math.max(peaks.queue_bytes,delivery.retainedBytes);peaks.in_flight=Math.max(peaks.in_flight,delivery.inFlight);return {sampled_at_ms:Date.now(),body_response:bodyTiming.snapshot(),collector_boot_id:bootId,collector_pid:process.pid,intake:intake.snapshot(),delivery,peaks:{...peaks},memory_current:{rss:memory.rss,heap_used:memory.heapUsed},connections_current:connections,connections_peak:peakConnections,active_requests_peak:peakActive,arrival_span_ms:firstArrival===null?null:lastArrival-firstArrival,event_loop_max_ms:lag.max/1e6,cpu_us:process.cpuUsage(cpuStart),ingest_pid:consumer.child.pid};}
function send(value){if(process.send){if(process.connected)process.send(value);}else process.stdout.write(JSON.stringify(value)+'\n');}
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);intake?.server.closeAllConnections();intake?.server.close();await consumer?.close();lag.disable();if(consumer)send({kind:'stopped',value:snapshot()});input?.close();if(!process.send)process.stdin.destroy();process.disconnect?.();}
function receive(message){void(async()=>{
 if(message?.kind==='configure'&&!started){started=true;if(message.connectionString!==connectionString||!/^test_[a-f0-9]{32}$/.test(message.schema))throw new Error('Isolated test target required');consumer=startDatabaseConsumer({connectionString,schema:message.schema});intake=createCollector(consumer.queue,consumer.policy);
  intake.server.on('connection',socket=>{connections++;peakConnections=Math.max(peakConnections,connections);socket.once('close',()=>{connections--;});});
  intake.server.prependListener('request',(req,res)=>{bodyTiming.observe(req,res);const at=performance.now();firstArrival??=at;lastArrival=at;active++;peakActive=Math.max(peakActive,active);res.once('finish',()=>{active--;});});
  const deadline=Date.now()+10000;while(!consumer.queue.snapshot().ready||!consumer.policy()||consumer.policy().installations.size!==message.people){if(Date.now()>deadline)throw new Error('Policy did not become ready');await delay(20);}
  intake.server.listen(container?4186:0,container?'0.0.0.0':'127.0.0.1');await once(intake.server,'listening');timer=setInterval(()=>{send({kind:'sample',value:snapshot()});},100);send({kind:'ready',port:intake.server.address().port,ingest_pid:consumer.child.pid,runtime:{node:process.version,platform:process.platform,arch:process.arch}});
 }else if(message?.kind==='begin-burst'&&intake){if(consumer.queue.snapshot().retainedItems!==0||active!==0||connections!==2000)throw new Error('Previous burst has not drained');bodyTiming.reset();firstArrival=null;lastArrival=null;peakActive=0;peakConnections=connections;for(const key of Object.keys(peaks))peaks[key]=0;lag.reset();send({kind:'burst-ready',round:message.round,value:snapshot()});}
 else if(message?.kind==='sample'&&intake)send({kind:'sample',value:snapshot()});else if(message?.kind==='stop')await stop();
 })().catch(async()=>{send({kind:'failed',code:'capacity_collector_failed'});await stop();process.exitCode=1;});}
if(process.send)process.on('message',receive);else{input=createInterface({input:process.stdin});input.on('line',line=>{try{receive(JSON.parse(line));}catch{send({kind:'failed',code:'capacity_configuration_invalid'});void stop();}});input.once('close',()=>{void stop();});}
process.once('SIGTERM',()=>{void stop();});process.once('disconnect',()=>{void stop();});
