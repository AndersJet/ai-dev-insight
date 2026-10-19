import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {getHeapStatistics} from 'node:v8';
import {capacityDatabase} from './session-list-capacity-fixture.mjs';
import {createCapacityProvider} from './session-list-capacity-provider.mjs';
import {supervise} from '../apps/worker/dist/supervisor.js';
import {createRuntimeReporter} from '../packages/storage/dist/index.js';
import {createIdentityService,createMemberImportService,createSessionDerivationService,createSessionTokenChecks,createSessionListSnapshotPublisher,createUsageAttributionJobs,createUsageSyncService,createUsageModelChecks} from '../packages/domain/dist/index.js';

assert.equal(process.env.ADI_SESSION_CAPACITY_CONTAINER,'true');
const role=process.argv[2]??'supervisor';assert.ok(['supervisor','jobs','usage'].includes(role));
assert.ok(process.execArgv.includes('--max-old-space-size=256'),'Each synthetic worker Node process uses the production 256 MiB old-space limit');
async function configuration(){
 const bytes=await readFile(process.env.ADI_SESSION_CAPACITY_CONFIG),raw=JSON.parse(bytes.toString('utf8'));
 assert.equal(raw.synthetic,true);assert.match(raw.schema,/^test_[a-f0-9]{32}$/);assert.ok(['full','smoke'].includes(raw.scale));
 const config={schema:raw.schema,scale:raw.scale,synthetic:true,provider_account:raw.provider_account};
 if(role==='usage'){config.history_records=Object.fromEntries(Object.entries(raw.item_oracle).filter(([,row])=>row.official_records>0).map(([id,row])=>[id,row.official_records]));config.emails=Object.fromEntries(raw.people.map(person=>[person.user_id,person.email]));}
 return {config,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const selected=await configuration(),config=selected.config,configSha256=selected.sha256;
const loadedSource={};for(const path of ['packages/domain/dist/session-derivation.js','packages/domain/dist/session-token-checks.js','packages/domain/dist/session-official-usage.js','packages/domain/dist/usage-attribution.js','packages/domain/dist/session-usage-query.js','packages/domain/dist/session-reading.js','packages/domain/dist/session-list-snapshot-reading.js','packages/domain/dist/session-list-snapshot-publisher.js','packages/domain/dist/session-list-snapshot-loader.js','apps/worker/dist/supervisor.js','scripts/session-list-capacity-worker.mjs','scripts/session-list-capacity-provider.mjs'])loadedSource[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
// The capacity adapter executes the real domain methods; production main is
// a frozen scheduling/configuration reference, not imported as a second loop.
const productionReference={};for(const path of ['apps/worker/src/main.ts','apps/worker/dist/main.js'])productionReference[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
const loop=monitorEventLoopDelay({resolution:20});loop.enable();
const stats={started_at:new Date().toISOString(),reader_mode:'published_snapshot',worker_scheduling:'Independent jobs and usage Node processes; production jobs/usage order and per-child 256 MiB heap, same shared container CPU/memory. Daily usage discovery disabled, matching the declared zero-daily fixture.',daily_usage_discovery:false,snapshot_ready:false,snapshot_runs:0,snapshot_errors:[],snapshot_warm_errors:[],derivations:0,attribution_steps:0,usage_sync_steps:0,model_checks:0,pruned:0,imports:0,token_checks:0,worker_errors:[],sql_errors:[],search_sql_timings:[],provider_requests:0,provider_routes:{session_usage_detail:0,user_usage_detail:0},supervisor_events:[]};
stats.provider_transport='Isolated immediate provider-method substitute; upstream HTTP, pacing gate and rate-limit response are outside this local pipeline measurement.';
let stopping=false,work,control,supervisor,db;
const generations=new Map();
const stageDiagnostics=process.env.ADI_SESSION_CAPACITY_STAGE_DIAGNOSTICS==='true';
stats.stage_diagnostics=stageDiagnostics;stats.sql_stage_timings=[];
function stage(statement){
 if(statement==='SELECT id,cleanup_generation FROM users ORDER BY id FOR SHARE')return 'publisher_all_users_lock';
 if(statement.startsWith('INSERT INTO session_list_snapshot_entries'))return 'publisher_entry_insert';
 if(statement.includes('DELETE FROM session_list_snapshot_entries'))return 'publisher_entry_gc';
 if(statement.includes('DELETE FROM session_list_snapshots'))return 'publisher_header_gc';
 if(statement.includes('WITH parts AS'))return 'publisher_revision_vector';
 if(statement.includes('pg_try_advisory_xact_lock'))return 'publisher_advisory';
 if(statement.includes('jsonb_agg')&&statement.includes('capture_generation')&&statement.includes('AS key'))return 'usage_hook_context';
 if(statement.includes('FROM users')&&statement.includes('FOR UPDATE'))return 'owner_update_lock';
 if(statement.includes("kind='usage_attribution'")&&statement.includes('FOR UPDATE SKIP LOCKED'))return 'usage_claim';
 if(statement.includes('INSERT INTO session_usage_queries'))return 'usage_query_publish';
 return null;
}
let observationInFlight=null,observationRequested=false,nextObservation=0;
function runtime(){const ms=value=>Number.isFinite(value)?value/1e6:null;return {sampled_at:new Date().toISOString(),pid:process.pid,ppid:process.ppid,role,node:process.version,exec_argv:process.execArgv,cpu_usage_us:process.cpuUsage(),memory:process.memoryUsage(),heap_size_limit_bytes:getHeapStatistics().heap_size_limit,event_loop_delay_ms:{resolution:20,samples:Number(loop.count),max:ms(loop.max),mean:ms(loop.mean),p95:ms(loop.percentile(95)),p99:ms(loop.percentile(99)),scope:'This process since startup, including initial publication; children reported independently.'}};}
function state(){return {tool_version:9,mode:'worker',role,schema:config.schema,config_sha256:configSha256,loaded_source_sha256:loadedSource,production_reference_sha256:productionReference,derivation_batch_size:16,database_max_connections:role==='supervisor'?0:2,...stats,runtime:runtime(),database:db?.health()??{connectionFaults:0,readTimeouts:0,waiting:0,total:0,idle:0}};}
const traced=sql=>({...sql,query:async(statement,values)=>{const category=stageDiagnostics?stage(statement):null,started=category?performance.now():0,startedAt=category?new Date().toISOString():null;let failure=null;try{return await sql.query(statement,values);}catch(error){failure=error.code??error.name;const record={at:new Date().toISOString(),role,pid:process.pid,code:failure,sql_sha256:createHash('sha256').update(statement).digest('hex')};stats.sql_errors.push(record);console.error(JSON.stringify({event:'capacity_worker_sql_error',...record}));throw error;}finally{if(category){stats.sql_stage_timings.push({role,pid:process.pid,category,started_at:startedAt,finished_at:new Date().toISOString(),elapsed_ms:performance.now()-started,error:failure,sql_sha256:createHash('sha256').update(statement).digest('hex')});if(stats.sql_stage_timings.length>512)stats.sql_stage_timings.shift();}}}});
async function publishObservation(force=false){
 if(role==='supervisor')return;
 // Only two worker processes send their cumulative counters and error arrays.
 // The supervisor retains each PID generation, so a replacement process cannot
 // erase failed SQL/publications or reset the measured lifetime totals.
 if(!force&&Date.now()<nextObservation)return;
 nextObservation=Date.now()+5000;observationRequested=true;
 if(!observationInFlight)observationInFlight=(async()=>{
  while(observationRequested){observationRequested=false;const observation=state();
   try{const response=await globalThis.fetch('http://127.0.0.1:4192/capacity/worker-observation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(observation),signal:globalThis.AbortSignal.timeout(2000)});if(!response.ok)throw new Error('worker_observation_http_'+response.status);}
   catch(error){const record={role,pid:process.pid,at:new Date().toISOString(),code:'worker_observation_delivery_failed',reason:error.name};stats.worker_errors.push(record);console.error(JSON.stringify(record));}
  }
 })().finally(()=>{observationInFlight=null;});
 if(force)await observationInFlight;
}
async function stop(){if(stopping)return;stopping=true;if(supervisor)await supervisor.close();await work;control?.closeAllConnections();control?.close();await db?.close();loop.disable();}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});

if(role==='supervisor'){
 const entries=['jobs','usage'].map(childRole=>({name:'capacity-'+childRole,command:process.execPath,args:['--max-old-space-size=256',fileURLToPath(import.meta.url),childRole],env:{...process.env,ADI_USAGE_DISCOVERY:'false'}}));
 supervisor=supervise(entries,{restart:true,shutdownMs:8000,onEvent:event=>{stats.supervisor_events.push({...event,at:new Date().toISOString()});if(['process_restarting','process_failed','process_start_failed'].includes(event.event))stats.worker_errors.push({role:'supervisor',code:event.event,at:new Date().toISOString(),name:event.name});console.log(JSON.stringify(event));}});
 function retain(observation){assert.ok(['jobs','usage'].includes(observation.role));assert.equal(observation.schema,config.schema);assert.equal(observation.config_sha256,configSha256);assert.ok(Number.isInteger(observation.runtime.pid));assert.equal(observation.runtime.ppid,process.pid);generations.set(observation.runtime.pid,observation);}
 control=createServer(async(request,response)=>{
  response.setHeader('Content-Type','application/json');
  if(request.method==='POST'&&request.url==='/capacity/worker-observation'){
   try{const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>16*1024*1024)throw new Error('oversized_worker_observation');chunks.push(chunk);}retain(JSON.parse(Buffer.concat(chunks).toString('utf8')));response.end('{}');}
   catch(error){stats.worker_errors.push({role:'supervisor',code:'invalid_worker_observation',reason:error.name,at:new Date().toISOString()});response.statusCode=400;response.end('{}');}return;
  }
  const children=await Promise.all([['jobs',4193],['usage',4194]].map(async([childRole,port])=>{try{return {role:childRole,state:await(await globalThis.fetch('http://127.0.0.1:'+port+'/capacity/state',{signal:globalThis.AbortSignal.timeout(2000)})).json()};}catch(error){return {role:childRole,error:error.name};}}));
  const current=state(),valid=children.filter(child=>child.state);
  for(const child of valid)retain(child.state);const lifetime=[...generations.values()];current.child_generations=lifetime;
  current.children=children;current.snapshot_ready=children.every(child=>child.state?.snapshot_ready===true&&child.state.schema===config.schema&&child.state.config_sha256===configSha256&&child.state.runtime.ppid===process.pid&&child.state.runtime.exec_argv.includes('--max-old-space-size=256')&&child.state.derivation_batch_size===16&&Object.entries(loadedSource).every(([path,sha])=>child.state.loaded_source_sha256[path]===sha)&&Object.entries(productionReference).every(([path,sha])=>child.state.production_reference_sha256?.[path]===sha));
  current.sql_stage_timings=lifetime.flatMap(child=>child.sql_stage_timings);
  for(const key of ['derivations','attribution_steps','usage_sync_steps','model_checks','snapshot_runs','pruned','imports','token_checks','provider_requests'])current[key]=lifetime.reduce((n,child)=>n+child[key],0);
  current.provider_routes={session_usage_detail:lifetime.reduce((n,c)=>n+c.provider_routes.session_usage_detail,0),user_usage_detail:lifetime.reduce((n,c)=>n+c.provider_routes.user_usage_detail,0)};
  for(const key of ['worker_errors','sql_errors','snapshot_errors','snapshot_warm_errors'])current[key]=[...current[key],...lifetime.flatMap(child=>child[key]),...children.filter(child=>child.error).map(child=>({role:child.role,code:'child_control_'+child.error,at:new Date().toISOString()}))];
  current.database=Object.fromEntries(['connectionFaults','readTimeouts','waiting','total','idle'].map(key=>[key,['connectionFaults','readTimeouts'].includes(key)?lifetime.reduce((n,child)=>n+child.database[key],0):valid.reduce((n,child)=>n+child.state.database[key],0)]));
  response.end(JSON.stringify(current));
 });control.listen(4192,'0.0.0.0');
 work=supervisor.finished.then(code=>{process.exitCode=code;stopping=true;control.closeAllConnections();control.close();loop.disable();});
}else{
 const raw=capacityDatabase(config.schema,true,2);db={...traced(raw),transaction:fn=>raw.transaction(sql=>fn(traced(sql)))};
 const reporter=createRuntimeReporter(db,role==='jobs'?'worker':'usage_worker');
 control=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(state()));});control.listen(role==='jobs'?4193:4194,'127.0.0.1');
 try{await db.assertNotRecovering();await reporter.flush();}catch(error){stats.worker_errors.push({role,pid:process.pid,at:new Date().toISOString(),code:error.code??error.name});await publishObservation(true);throw error;}
 if(role==='jobs'){
  const identity=createIdentityService(db,{emailDomains:['example.invalid']}),imports=createMemberImportService(db,identity),derivations=createSessionDerivationService(db,{batchSize:16}),tokenChecks=createSessionTokenChecks(db,{providerAccount:config.provider_account,stopping:()=>stopping}),publisher=createSessionListSnapshotPublisher(db,{providerAccount:config.provider_account,stopWindowEnabled:true});let tokenTurn=0;
  work=(async()=>{
   while(!stopping&&!stats.snapshot_ready){try{if(await publisher.runOne(true))stats.snapshot_runs++;stats.snapshot_ready=!!await publisher.latest();}catch(error){stats.snapshot_errors.push({stage:'initial_publish',role,at:new Date().toISOString(),code:error.code??error.name});}await publishObservation();if(!stats.snapshot_ready)await delay(250);}
   while(!stopping){try{
    await db.assertNotRecovering();const discovered=await derivations.discoverStale()+await tokenChecks.discoverRecent();
    const imported=await imports.runOne(),derived=await derivations.runOne(),pruned=await derivations.pruneRetired(),projected=await publisher.runOne(),checked=(++tokenTurn%64===0||(!imported&&!derived&&!pruned))?await tokenChecks.runOne():false;
    stats.imports+=Number(imported);stats.derivations+=Number(derived);stats.pruned+=Number(pruned);stats.snapshot_runs+=Number(projected);stats.token_checks+=Number(checked);
    reporter.success(Number(imported)+Number(derived)+Number(pruned)+Number(projected)+Number(checked));await reporter.flush();await publishObservation();if(!discovered&&!imported&&!derived&&!pruned&&!checked&&!projected)await delay(300);
   }catch(error){stats.worker_errors.push({role,at:new Date().toISOString(),code:error.code??error.name});reporter.failure();await reporter.flush();await publishObservation(true);await delay(1000);}}
   await reporter.flush(true);await publishObservation(true);
  })();
 }else{
  assert.equal(process.env.ADI_USAGE_DISCOVERY,'false');
  assert.equal((await db.query("SELECT EXISTS(SELECT 1 FROM usage_scopes) OR EXISTS(SELECT 1 FROM usage_observations) OR EXISTS(SELECT 1 FROM jobs WHERE kind IN('usage_sync','usage_model_check')) AS outside_scope")).rows[0].outside_scope,false,'This workload has an explicit zero-daily source scope');
  const provider=createCapacityProvider(db,config,stats),attribution=createUsageAttributionJobs(db,{providerAccount:config.provider_account,provider,stopping:()=>stopping}),sync=createUsageSyncService(db,{providerAccount:config.provider_account,provider,leaseMs:60000,stopping:()=>stopping}),modelChecks=createUsageModelChecks(db,{providerAccount:config.provider_account,provider:{getMemberModelUsage:async()=>{throw new Error('synthetic_daily_model_endpoint_out_of_scope');}},stopping:()=>stopping});let modelTurn=0;stats.snapshot_ready=true;
  work=(async()=>{while(!stopping){try{
   await db.assertNotRecovering();
   const worked=await sync.runOne(),linked=await attribution.runOne(),checked=(++modelTurn%16===0||(!worked&&!linked))?await modelChecks.runOne():false,pruned=await sync.pruneTransient();
   stats.usage_sync_steps+=Number(worked);stats.attribution_steps+=Number(linked);stats.model_checks+=Number(checked);stats.pruned+=Number(pruned);
   reporter.success(Number(worked)+Number(linked)+Number(checked)+Number(pruned));await reporter.flush();await publishObservation();if(!worked&&!linked&&!checked&&!pruned)await delay(300);
  }catch(error){stats.worker_errors.push({role,at:new Date().toISOString(),code:error.code??error.name});reporter.failure();await reporter.flush();await publishObservation(true);await delay(1000);}}await reporter.flush(true);await publishObservation(true);})();
 }
}
console.log(JSON.stringify({ready:true,role,mode:'worker',schema:config.schema,pid:process.pid,heap_size_limit_bytes:getHeapStatistics().heap_size_limit}));
