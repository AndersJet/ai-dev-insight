import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {setTimeout,clearTimeout} from 'node:timers';
import {randomUUID,createHash} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {getHeapStatistics} from 'node:v8';
import {capacityDatabase} from './session-list-capacity-fixture.mjs';
import {createSyntheticStopProvider} from './session-list-capacity-events.mjs';
import {createApi} from '../apps/api/dist/app.js';
import {createCollector} from '../apps/collector/dist/http.js';
import {startDatabaseConsumer} from '../apps/collector/dist/database-consumer.js';
import {createIdentityService,createSessionReadService,createSessionDerivationService,createUsageAttributionJobs,createSessionListSnapshotReader,createSessionListSnapshotPublisher} from '../packages/domain/dist/index.js';

assert.equal(process.env.ADI_SESSION_CAPACITY_CONTAINER,'true');
const mode=process.argv[2];
async function serviceConfiguration(){
 const bytes=await readFile(process.env.ADI_SESSION_CAPACITY_CONFIG),raw=JSON.parse(bytes.toString('utf8')),sha256=createHash('sha256').update(bytes).digest('hex');
 assert.equal(raw.synthetic,true);assert.ok(['full','smoke'].includes(raw.scale));
 const selected={schema:raw.schema,scale:raw.scale,synthetic:raw.synthetic,provider_account:raw.provider_account};
 // The request oracle belongs to the load driver, not the production API or
 // Collector. Keep only the synthetic provider's actual inputs in the Worker.
 if(mode==='worker'){selected.history_records=Object.fromEntries(Object.entries(raw.item_oracle).filter(([,row])=>row.official_records>0).map(([id,row])=>[id,row.official_records]));selected.emails=Object.fromEntries(raw.people.map(person=>[person.user_id,person.email]));}
 return {config:selected,sha256};
}
const loadedConfiguration=await serviceConfiguration(),config=loadedConfiguration.config,configSha256=loadedConfiguration.sha256;
const loadedSource={};for(const path of ['packages/domain/dist/session-official-usage.js','packages/domain/dist/session-usage-query.js','packages/domain/dist/session-reading.js','packages/domain/dist/session-list-snapshot-reading.js','packages/domain/dist/session-list-snapshot-publisher.js','packages/domain/dist/session-list-snapshot-loader.js'])loadedSource[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
const productionReference={};if(mode==='api')for(const path of ['apps/api/src/main.ts','apps/api/dist/main.js'])productionReference[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
// Capture the real consumer's referenced files before fork. These are parent
// boot references; the child does not self-report imported-module hashes.
const parentBootReferenceHashes={};if(mode==='collector')for(const path of ['packages/storage/dist/index.js','packages/storage/dist/ingest.js','apps/collector/dist/ingest-worker.js','apps/collector/dist/postgres-worker.js','apps/collector/dist/database-consumer.js','apps/collector/dist/delivery.js'])parentBootReferenceHashes[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
let diagnosticAdapter=null;
if(process.env.ADI_SESSION_CAPACITY_BIGINT_DIAGNOSTIC==='true'){
 assert.equal(mode,'api');
 const path='.run/session-list-capacity/bigint-api-sql-adapter.mjs';loadedSource[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
 diagnosticAdapter=(await import('../'+path)).createBigintDiagnosticAdapter(config.schema);
}
const rawDatabase=capacityDatabase(config.schema,true,mode==='api'?6:2);
const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
let stopping=false,api,collector,consumer,control,work,metadataTimer,metadataPreparing;
const stats={started_at:new Date().toISOString(),reader_mode:'published_snapshot',snapshot_ready:mode==='collector',snapshot_runs:0,snapshot_errors:[],snapshot_warm_pending:0,snapshot_warm_errors:[],derivations:0,attribution_steps:0,worker_errors:[],sql_errors:[],search_sql_timings:[],provider_requests:0,provider_routes:{session_usage_detail:0,user_usage_detail:0}};
const trace=sql=>{let deadline=null;return({...sql,query:async(statement,values)=>{if(diagnosticAdapter&&statement==="SELECT set_config('statement_timeout',$1,true)"){const remaining=Number(values[0]);assert.ok(Number.isInteger(remaining)&&remaining>0&&remaining<=5000);deadline=performance.now()+remaining;}let actual=statement;const metadata=statement.includes('ILIKE')&&statement.includes('jsonb_to_recordset'),search=statement.includes('ILIKE')&&statement.includes('payload')||statement.includes('prompt_search')&&statement.includes('LIKE')||metadata,started=performance.now(),startedAt=new Date().toISOString();try{const result=diagnosticAdapter?.matches(statement)?await diagnosticAdapter.execute(sql,statement,values,value=>{actual=value;},deadline):await sql.query(statement,values);diagnosticAdapter?.observeQuery(statement,values,result,startedAt,performance.now()-started);return result;}catch(error){stats.sql_errors.push({at:new Date().toISOString(),code:error.code??error.name,sql_sha256:createHash('sha256').update(actual).digest('hex')});throw error;}finally{if(search){stats.search_sql_timings.push({kind:metadata?'captured_metadata':'prompt_body',started_at:startedAt,finished_at:new Date().toISOString(),elapsed_ms:performance.now()-started,sql_sha256:createHash('sha256').update(actual).digest('hex')});if(stats.search_sql_timings.length>50)stats.search_sql_timings.shift();}}}});};
const db={...trace(rawDatabase),transaction:fn=>rawDatabase.transaction(sql=>fn(trace(sql)))};
function state(){const milliseconds=value=>Number.isFinite(value)?value/1e6:null;const child=consumer?.child,scriptIndex=child?.spawnargs.findIndex(arg=>arg.endsWith('/apps/collector/dist/postgres-worker.js'))??-1;return {tool_version:9,mode,schema:config.schema,config_sha256:configSha256,loaded_source_sha256:loadedSource,production_reference_sha256:productionReference,parent_boot_reference_hashes:parentBootReferenceHashes,collector_consumer_process_reference:child?{pid:child.pid,parent_pid:process.pid,spawnfile:child.spawnfile,worker_script:scriptIndex>=0?child.spawnargs[scriptIndex]:null,exec_argv:scriptIndex>=0?child.spawnargs.slice(1,scriptIndex):[],connected:child.connected,child_self_reported:false,scope:'Actual ChildProcess reference plus parent boot file hashes; frozen file identity is checked by the runner before/after the phase. No child self-reported module hashes.'}:null,...stats,diagnostic_sql_override:diagnosticAdapter?.state??null,
 runtime:{sampled_at:new Date().toISOString(),pid:process.pid,node:process.version,memory:process.memoryUsage(),heap_size_limit_bytes:getHeapStatistics().heap_size_limit,event_loop_delay_ms:{resolution:20,samples:Number(loopDelay.count),max:milliseconds(loopDelay.max),mean:milliseconds(loopDelay.mean),p95:milliseconds(loopDelay.percentile(95)),p99:milliseconds(loopDelay.percentile(99)),scope:'Cumulative since this service process started, including snapshot cold warming. Main process only; Collector ingest child is separate.'}},
 database:db.health(),collector:consumer?.queue.snapshot(),intake:collector?.snapshot()};}
async function stop(){if(stopping)return;stopping=true;clearTimeout(metadataTimer);await work;await metadataPreparing?.catch(()=>{});await api?.close();collector?.server.closeAllConnections();collector?.server.close();await consumer?.close();control?.close();await db.close();loopDelay.disable();}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
if(mode==='api'){
 const identity=createIdentityService(db,{emailDomains:['example.invalid']});
 const snapshots=createSessionListSnapshotReader(db,{providerAccount:config.provider_account,stopWindowEnabled:true});
 api=createApi(undefined,{identity,sessions:createSessionReadService(db,identity,{providerAccount:config.provider_account,stopWindowEnabled:true,snapshots}),secureCookies:false});
 api.get('/capacity/state',async()=>state());await api.listen({host:'0.0.0.0',port:4188});
 async function prepareMetadata(){
  if(metadataPreparing)return metadataPreparing;
  const began=performance.now(),startedAt=new Date().toISOString(),flight=snapshots.warm();metadataPreparing=flight;
  try{const id=await flight;if(diagnosticAdapter&&!stats.startup_warm)stats.startup_warm={snapshot_id:id,started_at:startedAt,finished_at:new Date().toISOString(),wall_ms:performance.now()-began};return id;}finally{if(metadataPreparing===flight)metadataPreparing=undefined;}
 }
 function scheduleMetadata(){
  if(stopping)return;
  metadataTimer=setTimeout(()=>{metadataTimer=undefined;void prepareMetadata().catch(error=>{if(!stopping)stats.snapshot_warm_errors.push({stage:'background_prepare',at:new Date().toISOString(),code:error.code??error.name});}).finally(scheduleMetadata);},1000);metadataTimer.unref();
 }
 work=(async()=>{while(!stopping&&!stats.snapshot_ready){try{await prepareMetadata();stats.snapshot_ready=true;}catch(error){if(error.code==='session_snapshot_pending')stats.snapshot_warm_pending++;else stats.snapshot_warm_errors.push({at:new Date().toISOString(),code:error.code??error.name});await delay(250);}}if(!stopping)scheduleMetadata();})();
}else if(mode==='collector'){
 consumer=startDatabaseConsumer({connectionString:'postgres://adi_capacity:adi_capacity_synthetic_only@postgres-capacity:5432/adi_capacity',schema:config.schema});
 collector=createCollector(consumer.queue,consumer.policy);collector.server.listen(4189,'0.0.0.0');
 control=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(state()));});control.listen(4191,'0.0.0.0');
}else if(mode==='worker'){
 const derivation=createSessionDerivationService(db);
 const publisher=createSessionListSnapshotPublisher(db,{providerAccount:config.provider_account,stopWindowEnabled:true});
 // This provider is only reachable inside the synthetic harness. Publication,
 // claims, leases and job completion still use the real domain worker methods.
 const stopProvider=createSyntheticStopProvider(db,{providerAccount:config.provider_account,onRequest:endpoint=>{stats.provider_requests++;stats.provider_routes[endpoint]++;}});
 const provider={getMemberUsage:stopProvider.getMemberUsage,getSessionUsage:async hook=>{
  if(hook.startsWith('synthetic-stop-bill-')||hook.startsWith('synthetic-live-')&&Number(hook.split('-').at(-1))%10===0)return stopProvider.getSessionUsage(hook);
  stats.provider_requests++;
  stats.provider_routes.session_usage_detail++;
  const row=(await db.query('SELECT s.id,s.user_id,s.first_at FROM sessions s WHERE s.source_session_id=$1',[hook])).rows[0];
  if(!row)throw new Error('synthetic_provider_session_missing');
  const historical=hook.startsWith('synthetic-capacity-')?(config.history_records[row.id]??0):0;
  const items=Array.from({length:historical+8},(_,n)=>({billing_session_id:n<historical?'capacity-bill-'+row.id+'-'+(n+1):'live-capacity-'+row.id+'-'+(n-historical),provider_user_id:'capacity-provider-'+row.user_id,email:config.emails[row.user_id],start_time:String(Math.floor(row.first_at.getTime()/1000)),client:'ide',scene:'Chat',model_name:'Synthetic live model '+n%4,model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{total_tokens:'100',prompt_tokens:'80',completion_tokens:'20',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'}));
  return {items,pagination:null,request_id:'synthetic-'+randomUUID(),observed_at:new Date().toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}};
 }};
 const attribution=createUsageAttributionJobs(db,{providerAccount:config.provider_account,provider,stopping:()=>stopping});
 control=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(state()));});control.listen(4192,'0.0.0.0');
 work=(async()=>{
  while(!stopping&&!stats.snapshot_ready){try{if(await publisher.runOne(true))stats.snapshot_runs++;stats.snapshot_ready=!!await publisher.latest();}catch(error){stats.snapshot_errors.push({stage:'initial_publish',at:new Date().toISOString(),code:error.code??error.name});}if(!stats.snapshot_ready)await delay(250);}
  while(!stopping){let changed=false;try{if(await derivation.runOne()){stats.derivations++;changed=true;}if(await attribution.runOne()){stats.attribution_steps++;changed=true;}}catch(error){stats.worker_errors.push({at:new Date().toISOString(),code:error.code??error.name});}
   try{if(await publisher.runOne()){stats.snapshot_runs++;changed=true;}}catch(error){stats.snapshot_errors.push({stage:'refresh_publish',at:new Date().toISOString(),code:error.code??error.name});}
   if(!changed)await delay(25);
  }
 })();
}else throw new Error('Unknown capacity service');
console.log(JSON.stringify({ready:true,mode,schema:config.schema}));
