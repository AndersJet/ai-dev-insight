import {createInterface} from 'node:readline';
import {setInterval,clearInterval} from 'node:timers';
import {setTimeout as delay} from 'node:timers/promises';
import {createQueryWorkload} from './lib/query-workload.mjs';
import {openDatabase} from '../packages/storage/dist/index.js';
import {createIdentityService,createAnalyticsService,createSessionDerivationService,createSessionTokenChecks} from '../packages/domain/dist/index.js';
import {analyticsRoutes} from '../packages/contracts/dist/index.js';
import {createApi} from '../apps/api/dist/app.js';

let db,app,timer,queries,poolLimit,activeQueryBurst,configured=false,stopping=false,tasks=[];const stats={job_batches:0,job_errors:0,token_checks:0,token_check_errors:0,token_check_windows:[],token_check_window_overflow:false},queryServer={requests:0,active:0,peak:0},queryBursts=[];
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function snapshot(){return {...stats,cpu_us:process.cpuUsage(),...queries?.snapshot(),query_server:{...queryServer},query_bursts:queryBursts.map(value=>({...value})),database_pool_limit:poolLimit,database_pool:db?.health(),rss:process.memoryUsage().rss};}
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await queries?.stop();await Promise.allSettled(tasks);await app?.close();await db?.close();send({kind:'stopped',value:snapshot()});input.close();process.stdin.destroy();}
async function configure(message){if(configured)return;configured=true;const url=new URL(message.connectionString);if(url.hostname!=='postgres-test'||url.port!=='5432'||url.username!=='adi_test'||url.pathname!=='/adi_test'||url.search||url.hash||!/^test_[a-f0-9]{32}$/.test(message.schema)||!['api','jobs'].includes(message.mode))throw new Error('Isolated workload target required');
 poolLimit=message.mode==='api'?6:2;db=openDatabase({connectionString:message.connectionString,schema:message.schema,maxConnections:poolLimit});
 if(message.mode==='api'){
  if(typeof message.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(message.token))throw new Error('Synthetic session required');const identity=createIdentityService(db,{emailDomains:['example.invalid']});app=createApi(undefined,{identity,analytics:createAnalyticsService(db,identity),secureCookies:false,allowedOrigin:'http://127.0.0.1:4180'});await app.listen({host:'127.0.0.1',port:4180});
  if(!/^[a-f0-9-]{36}$/.test(message.department_id))throw new Error('Synthetic department required');
  app.server.prependListener('request',(_req,res)=>{queryServer.requests++;queryServer.active++;queryServer.peak=Math.max(queryServer.peak,queryServer.active);const burst=activeQueryBurst;if(burst){burst.received++;burst.first_request_at_ms??=Date.now();burst.peak=Math.max(burst.peak,queryServer.active);}let finished=false;const done=()=>{if(finished)return;finished=true;queryServer.active--;if(burst){burst.completed++;burst.last_response_at_ms=Date.now();}res.off('finish',done);res.off('close',done);};res.once('finish',done);res.once('close',done);});
  const period=message.query_period;if(!period||!Number.isFinite(Date.parse(period.from))||!Number.isFinite(Date.parse(period.to))||Date.parse(period.to)<=Date.parse(period.from)||Date.parse(period.to)-Date.parse(period.from)>45*86400000)throw new Error('Fixed query period required');
  const targets=['overview','members'].map(name=>{const url=new URL('http://127.0.0.1:4180'+analyticsRoutes[name].path);url.searchParams.set('scope','organization');url.searchParams.set('from',period.from);url.searchParams.set('to',period.to);if(name==='members')url.searchParams.set('department_id',message.department_id);return{name,url:url.href};});
  queries=createQueryWorkload({clients:20,targets,headers:{cookie:`adi_session=${message.token}`},mode:message.query_mode??'continuous'});
  if(message.query_mode==='burst')await queries.runBurst();
 }else{if(message.token_checks!==undefined&&typeof message.token_checks!=='boolean')throw new Error('Explicit token-check workload flag required');const worker=createSessionDerivationService(db),checks=message.token_checks?createSessionTokenChecks(db,{providerAccount:'capacity-source',stopping:()=>stopping}):null;let turns=0;
  tasks=[(async()=>{while(!stopping){try{const derived=await worker.runOne();if(derived)stats.job_batches++;let checked=false;
   if(checks&&(++turns%64===0||!derived)){const started_at_ms=Date.now();try{checked=await checks.runOne();if(checked){stats.token_checks++;if(stats.token_check_windows.length<512)stats.token_check_windows.push({started_at_ms,finished_at_ms:Date.now()});else stats.token_check_window_overflow=true;}}catch{stats.token_check_errors++;}}
   if(!derived&&!checked)await delay(100);
  }catch{stats.job_errors++;await delay(100);}}})()];}
 timer=setInterval(()=>send({kind:'sample',value:snapshot()}),500);send({kind:'ready',mode:message.mode});
}
async function queryBurst(round){
 if(!queries||activeQueryBurst||!Number.isInteger(round)||round<1||round>3||queryBursts.some(value=>value.round===round))throw new Error('Invalid query burst');
 activeQueryBurst={round,received:0,completed:0,peak:0,first_request_at_ms:null,last_response_at_ms:null};queryBursts.push(activeQueryBurst);
 try{await queries.runBurst();}finally{activeQueryBurst=undefined;}
 send({kind:'query-burst-finished',round,value:snapshot()});
}
const input=createInterface({input:process.stdin});input.on('line',line=>{void(async()=>{const message=JSON.parse(line);if(message.kind==='configure')await configure(message);else if(message.kind==='query-burst')await queryBurst(message.round);else if(message.kind==='finish-queries'){if(!queries)throw new Error('Query workload required');await queries.stop();send({kind:'queries-finished',value:snapshot()});}else if(message.kind==='stop')await stop();})().catch(async()=>{send({kind:'failed',code:'capacity_background_failed'});await stop();process.exitCode=1;});});
process.once('SIGTERM',()=>{void stop();});
