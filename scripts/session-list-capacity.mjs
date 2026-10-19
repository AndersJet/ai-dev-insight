import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {setInterval,clearInterval} from 'node:timers';
import {performance} from 'node:perf_hooks';
import {seedSessionCapacity,capacityDatabase,digest} from './session-list-capacity-fixture.mjs';
import {startMixedTraffic,readCapacityDiagnostic,assessCapacityFreshResponse} from './session-list-capacity-traffic.mjs';
import {assessSnapshotStaticStopOracle} from './session-list-capacity-oracle-db.mjs';
import {sessionCapacityResourceProfile,assertSessionCapacityResource} from './session-list-capacity-resources.mjs';

const directory=new URL('../.run/session-list-capacity/',import.meta.url);
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const phase=option('phase','read'),scale=option('scale','full'),durationMs=Number(option('duration-ms','1800000'));
const samplesPerTarget=Number(option('samples-per-target','1000'));
const selectedScenario=option('scenario',null);
const diagnosticOnly=args.includes('--diagnostic-only');
const resourceProfile=sessionCapacityResourceProfile(option('resource-profile','baseline'));
const measurementConditions={api_cache:option('api-cache-condition','not separately recorded'),database_cache:option('database-cache-condition','not separately recorded'),prior_failed_read_artifact:option('prior-failed-read-artifact',null)};
assert.ok(['seed','read','mixed'].includes(phase));assert.ok(['full','smoke'].includes(scale));
assert.ok(Number.isInteger(durationMs)&&durationMs>=1000&&durationMs<=3600000);
assert.ok(Number.isInteger(samplesPerTarget)&&samplesPerTarget>=1&&samplesPerTarget<=10000);
await mkdir(directory,{recursive:true});
if(phase==='seed'){
 const fixture=await seedSessionCapacity({scale,fixtureBusinessDate:option('fixture-business-date',undefined),onProgress:value=>console.log(JSON.stringify(value))});
 await writeFile(new URL('config.json',directory),JSON.stringify({...fixture,resource_profile:resourceProfile.name},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({phase,scale,resource_profile:resourceProfile,schema:fixture.schema,actual:fixture.actual,payload_bytes:fixture.payload_bytes}));
}else{
 const configBytes=await readFile(new URL('config.json',directory)),fixture=JSON.parse(configBytes.toString('utf8')),fixtureConfigSha256=digest(configBytes);assert.equal(fixture.synthetic,true);assert.equal(fixture.scale,scale);
 assert.equal(fixture.resource_profile??'baseline',resourceProfile.name,'Fixture and runner must declare the same resource profile');
 if(fixture.fixture_business_date)assert.equal(new Date(Date.now()+28800000).toISOString().slice(0,10),fixture.fixture_business_date,'Prepared fixture may only be measured on its real Beijing business date');
 const startup=[],startupStart=performance.now(),startupDeadline=performance.now()+600000;let toolMismatch=false;
 for(const port of phase==='mixed'?[4188,4192,4191]:[4188]){
  let ready=false;
  while(performance.now()<startupDeadline){try{const response=await globalThis.fetch('http://127.0.0.1:'+port+'/capacity/state',{signal:globalThis.AbortSignal.timeout(2000)}),state=await response.json();
   if(response.ok&&state.tool_version!==9){toolMismatch=true;startup.push({port,ready:false,error:'tool_mismatch',expected_version:9,actual_version:state.tool_version??null});break;}
   if(response.ok&&state.schema===fixture.schema&&state.snapshot_ready===true&&(port!==4191||state.collector?.ready===true)){ready=true;startup.push({port,ready:true,schema:state.schema,tool_version:state.tool_version,snapshot_ready:true,elapsed_ms:performance.now()-startupStart});break;}
   startup.push({port,ready:false,status:response.status,schema:state.schema??null});
  }catch(error){startup.push({port,ready:false,error:error.name});}await delay(250);}
  if(!ready){const failure={phase,scale,synthetic:true,pass:false,startup_failure:true,tool_mismatch:toolMismatch,startup};await writeFile(new URL('startup-failed-'+Date.now()+'.json',directory),JSON.stringify(failure,null,2)+'\n');throw new Error('Capacity service did not load expected tool/schema: '+port);}
 }
 const scenarios=[];
 for(const scope of ['mine-normal','mine-heavy','super-all','super-department'])for(const channel of ['all','official','pending','custom'])for(const variant of ['first','search','next']){
  const query={...fixture.period,limit:variant==='next'?'5':'20',channel,search:variant==='search'?'[synthetic-search:1]':''};
  if(scope==='super-department')query.department_id=fixture.departments[0].id;
  const path=scope.startsWith('mine')?'/api/v1/me/sessions':'/api/v1/admin/sessions';
  const token=scope==='mine-normal'?fixture.own_token:scope==='mine-heavy'?fixture.heavy_token:fixture.admin_token;
  scenarios.push({name:scope+'/'+channel+'/'+variant,scope,channel,variant,path,query,token,samples:[],operation_samples:[],errors:{},statuses:{},requests:0,correct:0,cursor:null});
 }
 if(selectedScenario){const kept=scenarios.filter(s=>s.name===selectedScenario);assert.equal(kept.length,1,'Select an exact known scenario');scenarios.splice(0,scenarios.length,...kept);}
 const runFile=promisify(execFile),compose=['compose',...resourceProfile.compose_files.flatMap(path=>['-f',path])];
 const resources=[];let postgresContainerId;
 for(const {service}of resourceProfile.services){
  const id=(await runFile('docker',[...compose,'ps','-q',service])).stdout.trim();assert.ok(id,'Required capacity container is running: '+service);
  const info=JSON.parse((await runFile('docker',['inspect','--format','{{json .}}',id])).stdout);
  const record={service,cpu:info.HostConfig.NanoCpus/1e9,memory:info.HostConfig.Memory,mounts:info.Mounts.map(m=>({type:m.Type,destination:m.Destination})),image:info.Image};
  assertSessionCapacityResource(resourceProfile,record);
  if(service==='postgres-capacity')assert.ok(record.mounts.some(m=>m.type==='volume'&&m.destination==='/var/lib/postgresql'),'Postgres must use physical volume');
  if(service==='postgres-capacity')postgresContainerId=id;
  resources.push(record);
 }
 const measuredAt=new Date().toISOString();
 const sourceHashes={};for(const path of ['packages/domain/src/session-official-usage.ts','packages/domain/src/session-usage-query.ts','packages/domain/src/session-reading.ts','packages/domain/src/session-list-snapshot-reading.ts','packages/domain/src/session-list-snapshot-publisher.ts','packages/domain/src/session-list-snapshot-loader.ts','packages/domain/dist/session-official-usage.js','packages/domain/dist/session-usage-query.js','packages/domain/dist/session-reading.js','packages/domain/dist/session-list-snapshot-reading.js','packages/domain/dist/session-list-snapshot-publisher.js','packages/domain/dist/session-list-snapshot-loader.js','packages/storage/migrations/202610100002_snapshot_safety_and_prompt_search.sql','packages/storage/migrations/202610100003_snapshot_normalized_prompt_search.sql','scripts/session-list-capacity-fixture.mjs','scripts/session-list-capacity.mjs','scripts/session-list-capacity-service.mjs','scripts/session-list-capacity-traffic.mjs','scripts/session-list-capacity-events.mjs'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['packages/storage/migrations/202610100001_session_list_snapshots.sql','packages/storage/migrations/202610100004_snapshot_publication_tie_order.sql','deploy/product/compose.session-capacity.yml','apps/worker/dist/supervisor.js','scripts/session-list-capacity-worker.mjs','scripts/session-list-capacity-provider.mjs'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['packages/domain/src/usage-attribution.ts','packages/domain/dist/usage-attribution.js'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['packages/domain/src/session-derivation.ts','packages/domain/dist/session-derivation.js'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['packages/domain/src/session-token-checks.ts','packages/domain/dist/session-token-checks.js'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['packages/storage/migrations/202610100005_snapshot_literal_prompt_grams.sql','apps/api/src/main.ts','apps/api/dist/main.js'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['apps/worker/src/main.ts','apps/worker/dist/main.js'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['scripts/session-list-capacity-oracle.mjs','scripts/session-list-capacity-oracle-db.mjs'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 for(const path of ['scripts/session-list-capacity-resources.mjs',...resourceProfile.compose_files])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 const collectorReferencePaths=['packages/storage/dist/index.js','packages/storage/dist/ingest.js','apps/collector/dist/ingest-worker.js','apps/collector/dist/postgres-worker.js','apps/collector/dist/database-consumer.js','apps/collector/dist/delivery.js'];
 for(const path of [...collectorReferencePaths,'packages/storage/src/index.ts','packages/storage/src/ingest.ts','apps/collector/src/ingest-worker.ts','apps/collector/src/postgres-worker.ts','apps/collector/src/database-consumer.ts','apps/collector/src/delivery.ts'])sourceHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));
 const gitBase=(await runFile('git',['rev-parse','HEAD'])).stdout.trim(),gitDiffHash=digest((await runFile('git',['diff','--','packages/domain/src','packages/storage/migrations','apps/api/src/main.ts','apps/worker/src/jobs-main.ts','scripts/session-list-capacity.mjs','scripts/session-list-capacity-service.mjs','scripts/session-list-capacity-traffic.mjs','deploy/product/compose.session-capacity.yml'])).stdout);
 let active=0,peak=0;const waiting=[];
 async function acquire(){if(active>=20)await new Promise(resolve=>waiting.push(resolve));else active++;peak=Math.max(peak,active);}
 function release(){const next=waiting.shift();if(next)next();else active--;}
 async function request(s,page={}){
  const query={...s.query};if(s.variant==='next'&&(page.cursor??s.cursor))query.cursor=page.cursor??s.cursor;
  const started=performance.now();let code,status=0,data;
  await acquire();
  try{
   const response=await globalThis.fetch('http://127.0.0.1:4188'+s.path+'?'+new globalThis.URLSearchParams(query),{headers:{cookie:'adi_session='+s.token},signal:globalThis.AbortSignal.timeout(15000)});status=response.status;
   const body=await response.json();data=body.data;code=response.ok?'ok':body.error?.code??'http_'+status;
   if(response.ok&&(!data||!Array.isArray(data.items)||!Number.isInteger(data.total)||data.items.length>20))code='invalid_response';
   if(code==='ok'&&(!data.snapshot||typeof data.snapshot.id!=='string'||!data.snapshot.id||!Number.isFinite(Date.parse(data.snapshot.as_of))||!Number.isFinite(Date.parse(data.snapshot.expires_at))||Date.parse(data.snapshot.as_of)>Date.parse(data.snapshot.expires_at)||typeof data.snapshot.updating!=='boolean'))code='snapshot_metadata_missing';
   if(code==='ok'&&s.scope.startsWith('mine')&&data.items.some(i=>i.user_id!==(s.scope==='mine-normal'?fixture.own_user:fixture.heavy_user)))code='ownership_mismatch';
   if(code==='ok'&&s.channel!=='all'&&data.items.some(i=>i.channel!==s.channel&&!(i.channel==='mixed'&&['official','custom'].includes(s.channel))))code='channel_mismatch';
   const oracleName=s.name.replace('/next-setup','/next');
   if(code==='ok'&&phase==='read'&&fixture.expected[oracleName]!==undefined&&data.total!==fixture.expected[oracleName])code='total_mismatch';
   if(code==='ok'&&phase==='read'&&data.items.some(i=>{const expected=fixture.item_oracle[i.id];return !expected||i.user_id!==expected.user_id||i.channel!==expected.channel||i.official_tokens!==expected.official_tokens||i.official_records!==expected.official_records;}))code='item_oracle_mismatch';
   if(code==='ok'&&phase==='read'&&fixture.expected_page_ids?.[s.name]&&JSON.stringify(data.items.map(i=>i.id))!==JSON.stringify(fixture.expected_page_ids[s.name]))code='ordered_page_mismatch';
   if(code==='ok'&&page.previous_ids&&data.items.some(i=>page.previous_ids.includes(i.id)))code='pagination_duplicate';
   if(code==='ok'&&page.snapshot_id&&data.snapshot.id!==page.snapshot_id)code='snapshot_page_mismatch';
  }catch(error){code=error.name==='TimeoutError'?'http_timeout':'transport';}
  finally{release();}
  s.requests++;s.samples.push(performance.now()-started);s.statuses[status]=(s.statuses[status]??0)+1;
  if(code==='ok')s.correct++;else s.errors[code]=(s.errors[code]??0)+1;
  return {data,code};
 }
 // A next-page sample must really use an API-issued cursor. First-page setup
 // is reported separately and cannot silently count as a next-page success.
 const setup=[],setupMeasurements=[];
 const freshnessMeasurements={name:'freshness/read',scope:'super-user',channel:'all',variant:'freshness',path:'/api/v1/admin/sessions',query:{...fixture.period,limit:'20',channel:'all'},token:fixture.admin_token,samples:[],errors:{},statuses:{},requests:0,correct:0};
 const finalizationErrors=[];
 let traffic=null;const runStamp=Date.now(),checkpointPath=new URL(phase+'-'+runStamp+'.checkpoint.json',directory);let checkpointWrites=Promise.resolve();
 const raw=s=>({name:s.name,requests:s.requests,correct:s.correct,errors:{...s.errors},statuses:{...s.statuses},request_ms:[...s.samples],operation_ms:[...(s.operation_samples??[])]});
 function checkpoint(){
  const body=JSON.stringify({version:9,phase,scale,synthetic:true,resource_profile:resourceProfile,diagnostic_only:diagnosticOnly,measurement_conditions:measurementConditions,incomplete:true,pass:false,at:new Date().toISOString(),git_base_sha:gitBase,git_domain_diff_sha256:gitDiffHash,source_sha256:sourceHashes,fixture_config_sha256:fixtureConfigSha256,actual_fixture:fixture.actual,fixture_business_date:fixture.fixture_business_date??null,fixture_generation:fixture.fixture_generation??null,seed_setup:fixture.seed_setup??null,startup,resources,setup,scenarios:scenarios.map(raw),auxiliary:setupMeasurements.map(raw),freshness_requests:raw(freshnessMeasurements),traffic:traffic?.snapshot()??null,finalization_errors:[...finalizationErrors]},null,2)+'\n';
  checkpointWrites=checkpointWrites.then(async()=>{const temporary=new URL(checkpointPath.href+'.tmp');await writeFile(temporary,body);await rename(temporary,checkpointPath);}).catch(error=>{finalizationErrors.push({stage:'checkpoint_write',code:error.code??error.name,at:new Date().toISOString()});});
  return checkpointWrites;
 }
 await checkpoint();const checkpointTimer=setInterval(()=>{void checkpoint();},15000);checkpointTimer.unref();
 for(const [signal,code]of [['SIGINT',130],['SIGTERM',143]])process.once(signal,()=>{finalizationErrors.push({stage:'interrupted',code:signal,at:new Date().toISOString()});void checkpoint().finally(()=>process.exit(code));});
 for(const s of scenarios.filter(s=>s.variant==='next')){
  const first={...s,name:s.name.replace('/next','/next-setup'),variant:'setup',samples:[],errors:{},statuses:{},requests:0,correct:0};
  const {data}=await request(first);s.cursor=data?.next_cursor??null;
  setupMeasurements.push(first);
  setup.push({name:s.name,cursor_available:!!s.cursor,requests:first.requests,errors:first.errors});
 }
 traffic=phase==='mixed'?startMixedTraffic(fixture,durationMs,async(source,id,expectedTokens,userId,stop)=>{
  freshnessMeasurements.query.search=scale==='full'?'':source;freshnessMeasurements.query.user_id=userId;const result=await request(freshnessMeasurements);
  return assessCapacityFreshResponse(result,source,id,expectedTokens,userId,stop);
 }):null;
 let index=0;const start=performance.now(),deadline=start+durationMs;const stages=[];
 const progress=setInterval(()=>console.log(JSON.stringify({kind:'progress',phase,scale,elapsed_ms:performance.now()-start,requests:scenarios.reduce((n,s)=>n+s.requests,0),correct:scenarios.reduce((n,s)=>n+s.correct,0),active,traffic:traffic?{sent:traffic.snapshot().sent,planned:traffic.snapshot().planned_events,http_ack:traffic.snapshot().http_ack,freshness_samples:traffic.snapshot().freshness_samples}:null})),15000);progress.unref();
 async function runClients(targets){
  let stageActive=0,stagePeak=0;const stageStart=performance.now();
  await Promise.all(Array.from({length:20},async()=>{
  while(phase==='mixed'?performance.now()<deadline:targets.some(s=>s.requests<samplesPerTarget)){
   const s=targets[index++%targets.length];if(phase==='read'&&s.requests>=samplesPerTarget)continue;
   const operationStart=performance.now();
   stageActive++;stagePeak=Math.max(stagePeak,stageActive);
   let page={};
   if(s.variant==='next'){
    const first=setupMeasurements.find(m=>m.name===s.name.replace('/next','/next-setup'));
    const {data}=await request(first);page={cursor:data?.next_cursor??null,previous_ids:data?.items.map(i=>i.id)??[],snapshot_id:data?.snapshot?.id??null};
   }
   if(s.variant==='next'&&!page.cursor){s.requests++;s.errors.cursor_unavailable=(s.errors.cursor_unavailable??0)+1;const elapsed=performance.now()-operationStart;s.samples.push(elapsed);s.operation_samples.push(elapsed);stageActive--;continue;}
   await request(s,page);s.operation_samples.push(performance.now()-operationStart);stageActive--;
  }
  }));
  stages.push({scenarios:targets.map(s=>s.name),clients:20,peak_active_operations:stagePeak,elapsed_ms:performance.now()-stageStart});
  console.log(JSON.stringify({kind:'stage_finished',phase,scenarios:targets.map(s=>s.name),peak_active_operations:stagePeak,elapsed_ms:performance.now()-stageStart,requests:targets.reduce((n,s)=>n+s.requests,0),correct:targets.reduce((n,s)=>n+s.correct,0)}));
 }
 try{if(phase==='read')for(const s of scenarios)await runClients([s]);else await runClients(scenarios);}catch(error){finalizationErrors.push({stage:'query_workload',code:error.code??error.name,at:new Date().toISOString()});}
 await checkpoint();let mixed;
 try{mixed=await traffic?.finish()??null;}catch(error){finalizationErrors.push({stage:'traffic_finish',code:error.code??error.name,at:new Date().toISOString()});mixed={...traffic.snapshot(),pass:false,finalization_errors:[{stage:'traffic_finish',code:error.code??error.name}],job_states:[],continuations:[],missing:[]};}
 await checkpoint();
 const postDrain=[],staticOracleBySnapshot=new Map(),staticFixtureById=new Map((fixture.static_stop_oracle??[]).map(s=>[s.session_id,s]));
 const oracleDatabase=mixed?capacityDatabase(fixture.schema):null;
 try{if(mixed)for(const s of scenarios.filter(s=>s.variant==='first')){
  const inScope=f=>s.scope==='super-all'||s.scope==='super-department'&&f.department===fixture.departments[0].id||s.scope==='mine-normal'&&f.user_id===fixture.own_user||s.scope==='mine-heavy'&&f.user_id===fixture.heavy_user;
  const inChannel=channel=>s.channel==='all'||channel===s.channel||channel==='mixed'&&['official','custom'].includes(s.channel);
  const added=mixed.sources.filter(f=>!f.continuation&&inScope(f));
  // Every planned complete live source must be official after the fixed drain.
  // Missing delivery/publication stays an oracle failure; never use observed
  // freshness to shrink the expected source or quantity denominator.
  const officialAdded=added.filter(f=>f.has_stop).length;
  const moved=mixed.sources.filter(f=>f.continuation&&inScope(f)&&f.has_stop).reduce((n,f)=>{const before=fixture.item_oracle[f.session_id].channel,after=['custom','mixed'].includes(before)?'mixed':'official';return n+Number(inChannel(after))-Number(inChannel(before));},0);
  const plannedExpected=fixture.expected[s.name]+(s.channel==='all'?added.length:s.channel==='official'?officialAdded:0)+moved;
  const check={...s,name:s.name+'/post-drain',samples:[],errors:{},statuses:{},requests:0,correct:0};
  const result=await request(check),actual=result.data?.total??null;
  let model=null;
  if(result.code==='ok'){
   const snapshot=result.data.snapshot;
   if(!staticOracleBySnapshot.has(snapshot.id))staticOracleBySnapshot.set(snapshot.id,await assessSnapshotStaticStopOracle(oracleDatabase,fixture,snapshot,mixed.sources));
   model=staticOracleBySnapshot.get(snapshot.id);
  }
  const staticAdjustment=(model?.channel_adjustments??[]).reduce((n,a)=>{
   const source=staticFixtureById.get(a.session_id);if(!source||!inScope({user_id:a.user_id,department:source.department_id}))return n;
   return n+Number(inChannel(a.expected_channel))-Number(inChannel(a.initial_channel));
  },0);
  const expected=model?.status==='complete'?plannedExpected+staticAdjustment:null;
  postDrain.push({name:s.name,planned_expected:plannedExpected,expected,actual,pass:result.code==='ok'&&model?.status==='complete'&&expected===actual,errors:check.errors,request_ms:check.samples,snapshot:result.data?.snapshot??null,static_oracle_status:model?.status??null,static_competition_adjustment:staticAdjustment,static_inconclusive:model?.inconclusive??null});
 }}catch(error){finalizationErrors.push({stage:'post_drain_oracle',code:error.code??error.name,at:new Date().toISOString()});}
 finally{await oracleDatabase?.close().catch(error=>finalizationErrors.push({stage:'post_drain_oracle_close',code:error.code??error.name,at:new Date().toISOString()}));}
 const percentile=(a,p)=>a.length?a[Math.ceil(a.length*p)-1]:null;
 const results=scenarios.map(s=>{const sorted=[...s.samples].sort((a,b)=>a-b),p95=percentile(sorted,.95),p99=percentile(sorted,.99),success=s.correct/s.requests;
  const operations=[...s.operation_samples].sort((a,b)=>a-b),operationP95=percentile(operations,.95),operationP99=percentile(operations,.99);
  return {name:s.name,requests:s.requests,correct:s.correct,success,p95_ms:p95,p99_ms:p99,max_ms:sorted.at(-1)??null,operation_p95_ms:operationP95,operation_p99_ms:operationP99,request_ms:s.samples,operation_ms:s.operation_samples,errors:s.errors,statuses:s.statuses,pass:s.requests>=samplesPerTarget&&success>=.999&&p95!==null&&p95<=1000&&p99<=2000&&operationP95!==null&&operationP95<=1000&&operationP99<=2000&&!Object.keys(s.errors).some(k=>['database_io_timeout','57014','database_unavailable','http_timeout'].includes(k))};});
 const auxiliary=setupMeasurements.map(s=>({name:s.name,requests:s.requests,correct:s.correct,success:s.correct/s.requests,errors:s.errors,statuses:s.statuses,request_ms:s.samples}));
 const db=capacityDatabase(fixture.schema);let database=null;
 try{database=(await readCapacityDiagnostic(db,`SELECT version() version,current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous_commit,current_setting('jit') diagnostic_jit,pg_database_size(current_database())::text database_bytes`)).rows[0];}catch(error){finalizationErrors.push({stage:'database_metadata',code:error.code??error.name,at:new Date().toISOString()});}finally{await db.close().catch(error=>finalizationErrors.push({stage:'database_metadata_close',code:error.code??error.name,at:new Date().toISOString()}));}
 const serviceStates=await Promise.all((phase==='mixed'?[4188,4192,4191]:[4188]).map(async port=>{try{return {port,state:await(await globalThis.fetch('http://127.0.0.1:'+port+'/capacity/state',{signal:globalThis.AbortSignal.timeout(5000)})).json()};}catch(error){finalizationErrors.push({stage:'service_state_'+port,code:error.code??error.name,at:new Date().toISOString()});return {port,error:error.name};}}));
 const serviceHealthy=serviceStates.every(s=>!s.error&&s.state?.tool_version===9&&s.state?.schema===fixture.schema&&s.state?.snapshot_ready===true&&s.state?.database?.readTimeouts===0&&s.state?.database?.connectionFaults===0&&Array.isArray(s.state?.worker_errors)&&s.state.worker_errors.length===0&&Array.isArray(s.state?.sql_errors)&&s.state.sql_errors.length===0&&Array.isArray(s.state?.snapshot_errors)&&s.state.snapshot_errors.length===0&&Array.isArray(s.state?.snapshot_warm_errors)&&s.state.snapshot_warm_errors.length===0&&(!s.state.collector||s.state.collector.dropped===0&&s.state.collector.deliveryUnknown===0&&s.state.collector.refused===0&&s.state.collector.restarts===0));
 const collectorReferencePostHashes={};try{for(const path of collectorReferencePaths)collectorReferencePostHashes[path]=digest(await readFile(new URL('../'+path,import.meta.url)));}catch(error){finalizationErrors.push({stage:'collector_reference_post_hashes',code:error.code??error.name,at:new Date().toISOString()});}
 const collectorState=serviceStates.find(s=>s.port===4191)?.state,consumerProcess=collectorState?.collector_consumer_process_reference;
 const collectorReferencesFrozen=collectorReferencePaths.every(path=>collectorReferencePostHashes[path]===sourceHashes[path])&&(phase!=='mixed'||collectorReferencePaths.every(path=>collectorState?.parent_boot_reference_hashes?.[path]===sourceHashes[path])&&Number.isSafeInteger(consumerProcess?.pid)&&consumerProcess.pid>0&&consumerProcess.connected===true&&consumerProcess.child_self_reported===false&&typeof consumerProcess.spawnfile==='string'&&consumerProcess.spawnfile.length>0&&consumerProcess.worker_script?.endsWith('/apps/collector/dist/postgres-worker.js')===true&&consumerProcess.exec_argv?.includes('--max-old-space-size=256')===true);
 const loadedSourcesMatch=collectorReferencesFrozen&&serviceStates.every(s=>!s.error&&s.state?.loaded_source_sha256&&Object.entries(s.state.loaded_source_sha256).every(([path,sha])=>sourceHashes[path]===sha)&&Object.entries(s.state.production_reference_sha256??{}).every(([path,sha])=>sourceHashes[path]===sha));
 const loadedConfigsMatch=serviceStates.every(s=>!s.error&&s.state?.config_sha256===fixtureConfigSha256);
 let postgresDiagnostics;try{const logs=await runFile('docker',['logs','--since',measuredAt,postgresContainerId],{maxBuffer:64*1024*1024}),combined=logs.stdout+logs.stderr;postgresDiagnostics={statement_timeouts:(combined.match(/canceling statement due to statement timeout/g)??[]).length,lock_timeouts:(combined.match(/canceling statement due to lock timeout/g)??[]).length,scope:'PostgreSQL container diagnostics since measured run started; statement text and payloads are not persisted'};}catch(error){postgresDiagnostics={error:error.code??error.name};}
 const freshnessRequests={name:freshnessMeasurements.name,scope:scale==='full'?'Actual super API owner firstpage(limit20, empty search); generated initial facts precede live events and each owner receives at most five live sources in the supported <=1h profile, so every present live source is in this page. Exact session/owner/source/time/token/records/channel verified; missing still fails. Separate from unchanged full 48-scenario global body searches.':'Actual super API with persisted owner user_id and exact source search; small correctness smoke, not the full ranking workload.',requests:freshnessMeasurements.requests,correct:freshnessMeasurements.correct,errors:freshnessMeasurements.errors,statuses:freshnessMeasurements.statuses,request_ms:freshnessMeasurements.samples};
 clearInterval(progress);clearInterval(checkpointTimer);await checkpointWrites;
 const pass=finalizationErrors.length===0&&results.every(s=>s.pass)&&auxiliary.every(s=>s.success>=.999)&&peak===20&&serviceHealthy&&loadedSourcesMatch&&loadedConfigsMatch&&(!mixed||mixed.pass)&&postDrain.every(s=>s.pass)&&Object.keys(freshnessMeasurements.errors).length===0&&!postgresDiagnostics.error&&postgresDiagnostics.statement_timeouts===0&&postgresDiagnostics.lock_timeouts===0&&database?.fsync==='on'&&database?.synchronous_commit==='on';
 const fullProfile=scale==='full'&&phase==='mixed'&&durationMs===1800000&&!selectedScenario&&scenarios.length===48;
 const report={version:9,reader_mode:'published_snapshot',phase,scale,synthetic:true,full_acceptance_profile:fullProfile,full_acceptance:fullProfile&&pass,concurrency_scope:phase==='read'?'20 closed-loop clients for each scenario in its own stage':'20 shared closed-loop clients rotate through the selected scenarios while real collector and worker traffic runs',at:new Date().toISOString(),fixture_config_sha256:fixtureConfigSha256,seed_setup:fixture.seed_setup??null,actual_fixture:fixture.actual,fixture_business_date:fixture.fixture_business_date??null,fixture_generation:fixture.fixture_generation??null,official_source_fixture:{session_query_items:fixture.actual.official_items,daily_usage_observations:0},payload_bytes:fixture.payload_bytes,text_bytes:fixture.text_bytes,max_text_bytes:fixture.max_text_bytes,text_size_histogram:fixture.text_size_histogram,elapsed_ms:performance.now()-start,clients:20,peak_active_requests:peak,startup,stages,resources,git_base_sha:gitBase,git_domain_diff_sha256:gitDiffHash,source_sha256:sourceHashes,loaded_sources_match:loadedSourcesMatch,loaded_configs_match:loadedConfigsMatch,setup,auxiliary,freshness_requests:freshnessRequests,post_drain_total_oracle:postDrain,oracle_scope:'Read stage verifies exact independent fixture total, ordered page IDs/length and every item owner, channel, tokens and record count. Mixed stage verifies owner/channel/shape, each current live quantity and independent post-drain totals, with raw version conflicts retained.',thresholds:{p95_ms:1000,p99_ms:2000,success:.999,database_timeouts:0,minimum_samples_per_scenario:samplesPerTarget},database,postgres_diagnostics:postgresDiagnostics,service_states:serviceStates,service_runtime:serviceStates.map(s=>({port:s.port,mode:s.state?.mode,runtime:s.state?.runtime??null,error:s.error??null})),mixed,scenarios:results,finalization_errors:finalizationErrors,checkpoint:checkpointPath.pathname,pass};
 Object.assign(report,{collector_reference_provenance:{scope:'Parent boot referenced dist hashes with phase pre/post frozen file identity; not child self-reported imported-module hashes.',required_dist_paths:collectorReferencePaths,post_sha256:collectorReferencePostHashes,pass:collectorReferencesFrozen},resource_profile:resourceProfile,static_competition_oracles:[...staticOracleBySnapshot.values()],diagnostic_only:diagnosticOnly,measurement_conditions:measurementConditions,phase_pass:pass,full_acceptance:fullProfile&&pass&&!diagnosticOnly&&!measurementConditions.prior_failed_read_artifact});
 const destination=new URL(phase+'-'+Date.now()+'.json',directory);
 try{await writeFile(destination,JSON.stringify(report,null,2)+'\n');}catch(error){report.pass=false;report.full_acceptance=false;finalizationErrors.push({stage:'final_report_write',code:error.code??error.name,at:new Date().toISOString()});console.error(JSON.stringify({kind:'report_write_failed',report}));}
 console.log(JSON.stringify({artifact:destination.pathname,pass:report.pass,full_acceptance:report.full_acceptance,phase,scale,elapsed_ms:report.elapsed_ms,scenarios:results.map(({request_ms: _requestMs,operation_ms:_operationMs,...s})=>s),mixed:mixed?{planned_events:mixed.planned_events,sent:mixed.sent,http_ack:mixed.http_ack,persisted_events:mixed.persisted_events,published_queries:mixed.published_queries,readable_queries:mixed.readable_queries,pass:mixed.pass}:null}));if(!report.pass)process.exitCode=1;
}
