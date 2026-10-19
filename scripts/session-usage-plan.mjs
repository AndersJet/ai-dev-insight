import {execFileSync} from 'node:child_process';
import {officialAmountReasonsSql} from '../packages/domain/dist/official-amount-reasons.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from '../packages/storage/test/helpers.ts';
import { createIdentityService, createSessionReadService, createUsageSnapshotStore, createUsageAttributionService,createAnalyticsService,createUsageModelChecks,createSessionTokenChecks,createSessionDerivationService } from '../packages/domain/dist/index.js';

const cleanup=[];const db=await testDatabase({after:callback=>cleanup.push(callback)});
const selectedRows=Number(process.env.ADI_PLAN_SESSION_ROWS??20);if(![20,5000].includes(selectedRows))throw new Error('Use a bounded plan fixture: 20 or 5000');
const allLinks=process.env.ADI_PLAN_ALL_LINKS==='true';
const tokenCheckMode=process.env.ADI_PLAN_TOKEN_CHECKS==='true';
const modelMode=process.env.ADI_PLAN_MODELS==='true';
const reconciliationMode=process.env.ADI_PLAN_RECONCILIATION==='true';
const modelCheckMode=process.env.ADI_PLAN_MODEL_CHECKS==='true';if(modelCheckMode&&!reconciliationMode)throw new Error('Model check plans require reconciliation mode');
const baselineRef=process.env.ADI_PLAN_BASELINE_REF;let baselineSql;
if(baselineRef){
 if(!reconciliationMode||!/^[a-f0-9]{40}$/.test(baselineRef))throw new Error('A fixed commit SHA and reconciliation mode are required for the SQL baseline');
 const source=execFileSync('git',['show',`${baselineRef}:packages/domain/src/official-usage.ts`],{encoding:'utf8',maxBuffer:1024*1024});
 baselineSql=source.match(/const base=`([\s\S]+?)`;/)?.[1]?.replaceAll('${officialAmountReasonsSql}',officialAmountReasonsSql);
 if(!baselineSql||baselineSql.includes('${')||!baselineSql.startsWith('WITH dates AS'))throw new Error('Unsupported baseline SQL shape');
}

try {
 await db.migrate();const now=new Date();const today=Math.floor((now.getTime()+28800000)/86400000)*86400000-28800000;const at=new Date(today-43200000);const from=new Date(today-86400000),to=new Date(today);const date=new Date(from.getTime()+28800000).toISOString().slice(0,10);
 await db.ensurePartitions(from,new Date(today+86400000));
 const identity=createIdentityService(db,{emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'usage-plan-root@example.invalid',name:'官方会话计划夹具'});const temp=await identity.login('usage-plan-root@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(temp.token,seed.temporaryPassword,'usage-plan-synthetic-password');
 const people=(await db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'usage-plan-'||g||'@example.invalid','合成人员'||g FROM generate_series(1,500) g RETURNING id,email_key")).rows;
 await db.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) SELECT gen_random_uuid(),u,'synthetic-plan-hook',$2,$2 FROM unnest($1::uuid[]) u",[people.map(row=>row.id),at]);
 const sessionIds=new Map((await db.query('SELECT user_id,id FROM sessions WHERE user_id=ANY($1::uuid[])',[people.map(row=>row.id)])).rows.map(row=>[row.user_id,row.id]));
 await db.query("INSERT INTO installations(id,user_id,token_hash,label) SELECT gen_random_uuid(),u,md5(u::text)||md5(u::text),'合成计划安装' FROM unnest($1::uuid[]) u",[people.map(row=>row.id)]);
 await db.query("INSERT INTO hook_events(id,occurred_at,received_at,user_id,installation_id,session_id,event_type,payload) SELECT gen_random_uuid(),$2,$2,s.user_id,i.id,s.id,'UserPromptSubmit','{}'::jsonb FROM sessions s JOIN installations i ON i.user_id=s.user_id WHERE s.user_id=ANY($1::uuid[])",[people.map(row=>row.id),at]);
 const store=createUsageSnapshotStore(db,{providerAccount:'plan-source'});let targetItems;
 for(const person of people){
  const draft=await store.begin(person.id,date);const query=draft.parts[0].query;
  const items=Array.from({length:person===people[0]?selectedRows:20},(_,i)=>({billing_session_id:'synthetic-billing-'+i,provider_user_id:'provider-'+person.id,email:person.email_key,start_time:String(query.start_time+3600),client:'ide',scene:'Chat',model_name:'Synthetic '+i%4,model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{total_tokens:'10',prompt_tokens:'8',completion_tokens:'2',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'}));
  for(let page=1;page<=Math.ceil(items.length/200);page++){const rows=items.slice((page-1)*200,page*200);await store.stage(draft,0,{items:rows,pagination:{page,page_size:200,total:items.length,total_pages:Math.ceil(items.length/200)},request_id:'plan-fixture',observed_at:now.toISOString(),response_hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),query:{endpoint:'user_usage_detail',parameters:{...query,page}}});}await store.publish(draft);
  if(modelCheckMode){const models=Array.from({length:4},(_,i)=>({model_name:'Synthetic '+i,model_source:'Trae',model_type:'Chat',usage:{input_tokens:String(items.length/4*8),output_tokens:String(items.length/4*2)}}));const checks=createUsageModelChecks(db,{providerAccount:'plan-source',provider:{getMemberModelUsage:async parameters=>({items:[{provider_user_id:'provider-'+person.id,email:person.email_key,model_usage:models}],pagination:null,request_id:'plan-model-check',observed_at:now.toISOString(),response_hash:'c'.repeat(64),query:{endpoint:'user-model-usage',parameters}})}});const job=await checks.enqueue(person.id,date);await checks.runOne();if((await checks.status(job)).status!=='succeeded')throw new Error('Model check fixture did not publish');}
  if(person===people[0])targetItems=items;
  if(allLinks)await createUsageAttributionService(db,{providerAccount:'plan-source',provider:{getSessionUsage:async hook=>({items,pagination:null,request_id:'plan-all-probe',observed_at:now.toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(sessionIds.get(person.id));
 }
 const sid=(await db.query('SELECT id FROM sessions WHERE user_id=$1',[people[0].id])).rows[0].id;
 await createUsageAttributionService(db,{providerAccount:'plan-source',provider:{getSessionUsage:async hook=>({items:targetItems,pagination:null,request_id:'plan-probe',observed_at:now.toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(sid);
 if(modelMode){await db.query("INSERT INTO session_personal_models(session_id,user_id,models,cleanup_generation) SELECT id,user_id,jsonb_build_array('Confirmed model '||(row_number() OVER(ORDER BY id)%4)::text),0 FROM sessions WHERE user_id=ANY($1::uuid[])",[people.map(row=>row.id)]);await db.query('INSERT INTO personal_model_revisions(user_id,revision) SELECT unnest($1::uuid[]),1',[people.map(row=>row.id)]);}
 if(tokenCheckMode){
  await db.query("UPDATE hook_events SET payload=jsonb_build_object('prompt','合成质量检查提示','model','Synthetic 0')");
  await db.query("INSERT INTO hook_events(id,occurred_at,received_at,user_id,installation_id,session_id,event_type,payload) SELECT gen_random_uuid(),$2::timestamptz+g*interval '1 second',$2,s.user_id,i.id,s.id,'UserPromptSubmit',jsonb_build_object('prompt','合成后续提示','model','Synthetic 0') FROM sessions s JOIN installations i ON i.user_id=s.user_id CROSS JOIN generate_series(1,19) g WHERE s.id=$1",[sid,at]);
  await db.query("UPDATE sessions SET last_at=$2::timestamptz+interval '19 seconds' WHERE id=$1",[sid,at]);
  const derivations=createSessionDerivationService(db);for(const session of sessionIds.values())await derivations.enqueueRebuild(session);let batches=0;while(await derivations.runOne())if(++batches>2000)throw new Error('Synthetic projections did not finish');
  if((await db.query("SELECT count(*)::int AS n FROM session_derivations WHERE state='published'")).rows[0].n!==500)throw new Error('Every synthetic session must have a published projection');
 }
 for(const table of ['users','sessions','hook_events','usage_scopes','usage_snapshot_runs','usage_observations','usage_attribution_evidence','usage_provider_identities','session_personal_models','personal_model_revisions','usage_model_checks','jobs'])await db.query(`ANALYZE ${table}`);
 let statement;let listStatement;let modelStatement;let declaredStatement;const traced=new Proxy(db,{get(target,key){if(key==='query')return(sql,values)=>{if(sql.startsWith('WITH valid_links'))statement={sql,values};if(sql.startsWith('WITH visible AS MATERIALIZED'))listStatement={sql,values};if(sql.startsWith('WITH dates AS'))modelStatement={sql,values};if(sql.startsWith('WITH observed AS MATERIALIZED'))declaredStatement={sql,values};return target.query(sql,values);};return Reflect.get(target,key);}});
 const reader=createSessionReadService(traced,identity,{providerAccount:'plan-source'});const started=performance.now();const result=await reader.officialUsage(root.token,sid,{from:from.toISOString(),to:to.toISOString()});const elapsed=performance.now()-started;
 if(!statement||result.groups.reduce((sum,row)=>sum+BigInt(row.tokens),0n)!==(selectedRows===20?200n:50000n)||result.attribution.linked_ids!==selectedRows)throw new Error('Session usage plan fixture mismatch');
 const plan=(await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.sql}`,statement.values)).rows[0]['QUERY PLAN'][0];
 const listPlans=[];
 if(allLinks)for(const channel of ['all','official']){
  const started=performance.now();const page=await reader.listAll(root.token,{from:from.toISOString(),to:to.toISOString(),channel,limit:20});const ms=performance.now()-started;
  if(!listStatement||page.total!==500||page.items.length!==20)throw new Error('Session list plan fixture mismatch');
  const listPlan=(await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${listStatement.sql}`,listStatement.values)).rows[0]['QUERY PLAN'][0];
  listPlans.push({channel,total:page.total,endpoint_ms:ms,plan:listPlan});
 }
 const modelPlans=[];
 if(modelMode){const analytics=createAnalyticsService(traced,identity,{providerAccount:'plan-source'});const period={from:new Date(today-44*86400000).toISOString(),to:new Date(today+86400000).toISOString()};
  for(const kind of ['official','declared']){const start=performance.now();const data=kind==='official'?await analytics.models(root.token,period):await analytics.declaredModels(root.token,period);const ms=performance.now()-start;const query=kind==='official'?modelStatement:declaredStatement;if(!query||data.total!==4)throw new Error('Model analytics fixture mismatch');const plan=(await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${query.sql}`,query.values)).rows[0]['QUERY PLAN'][0];modelPlans.push({kind,endpoint_ms:ms,plan});}
 }
 const reconciliationPlans=[];
 if(reconciliationMode){const analytics=createAnalyticsService(traced,identity,{providerAccount:'plan-source'});
  for(const days of [1,45]){const period={from:new Date(today-(days===1?1:44)*86400000).toISOString(),to:new Date(days===1?today:today+86400000).toISOString()};const timings=[];
   for(let sample=0;sample<3;sample++){const start=performance.now();let data;try{data=await analytics.officialUsage(root.token,period);}catch(error){if(modelStatement){const estimated=(await db.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${modelStatement.sql}`,modelStatement.values)).rows[0]['QUERY PLAN'][0];await mkdir(new URL('../.run/',import.meta.url),{recursive:true});await writeFile(new URL('../.run/official-reconciliation-failed-plan.json',import.meta.url),JSON.stringify({days,all_links:allLinks,estimated_plan:estimated},null,2)+'\n');}throw error;}timings.push(performance.now()-start);if(!modelStatement||data.reconciliation.total.records!==9980+selectedRows||data.reconciliation.attributed.records!==(allLinks?9980+selectedRows:selectedRows)||BigInt(data.reconciliation.total.known_tokens)!==BigInt(9980+selectedRows)*10n)throw new Error('Reconciliation fixture mismatch');if(modelCheckMode&&(data.model_check.groups.reduce((sum,row)=>sum+BigInt(row.official_input_tokens),0n)!==BigInt(9980+selectedRows)*8n||data.model_check.days.filter(row=>row.state==='matched').reduce((sum,row)=>sum+row.user_days,0)!==500))throw new Error('Model comparison fixture mismatch');}
   const baselinePlan=baselineSql?(await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${baselineSql}`,modelStatement.values.slice(0,5))).rows[0]['QUERY PLAN'][0]:null;
   const plan=(await db.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${modelStatement.sql}`,modelStatement.values)).rows[0]['QUERY PLAN'][0];reconciliationPlans.push({days,endpoint_ms:timings,plan,baseline_ref:baselineRef??null,baseline_plan:baselinePlan});
  }
 }
 if(tokenCheckMode){
  let calls=0,returned=0,writes=0,sourceStatement;
  const trace=sql=>({...sql,query:async(text,values)=>{const result=await sql.query(text,values);calls++;returned+=result.rows.length;if(/^\s*(INSERT|UPDATE|DELETE)/i.test(text))writes++;if(text.startsWith('SELECT s.id AS session_id'))sourceStatement={sql:text,values};return result;}});
  const measured={...trace(db),transaction:fn=>db.transaction(sql=>fn(trace(sql)))},checks=createSessionTokenChecks(measured,{providerAccount:'plan-source'}),authorized=createSessionReadService(measured,identity,{providerAccount:'plan-source'}),samples=[];
  async function measure(name,action){calls=0;returned=0;writes=0;const cpu=process.cpuUsage(),start=performance.now(),value=await action(),used=process.cpuUsage(cpu);samples.push({name,elapsed_ms:performance.now()-start,node_cpu_ms:(used.user+used.system)/1000,traced_sql_calls:calls,traced_returned_rows:returned,traced_write_statements:writes});return value;}
  await checks.enqueue(sid);await measure('first_check',()=>checks.runOne());const first=await checks.read(sid);if(first.state!=='current'||first.result?.eligible!==false||first.result.reasons.includes('trace_pending'))throw new Error('Token quality fixture did not publish from a current projection');
  for(let i=0;i<5;i++){await checks.enqueue(sid);await measure('unchanged_check',()=>checks.runOne());const same=await measure('authorized_read',()=>authorized.tokenCheck(root.token,sid));if(same.checked_at!==first.checked_at||same.state!=='current')throw new Error('Unchanged token check was not reused');}
  const sourcePlan=(await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sourceStatement.sql}`,sourceStatement.values)).rows[0]['QUERY PLAN'][0];
  await measure('enqueue_other_499',async()=>{for(const session of sessionIds.values())if(session!==sid)await checks.enqueue(session);});
  const drained=await measure('drain_other_499',async()=>{let n=0;while(await checks.runOne()){if(++n>499)throw new Error('Daily token tasks spun instead of cooling');}return n;});if(drained!==499)throw new Error('Not every synthetic session was checked');
  const footprint=(await db.query("SELECT count(*)::int AS rows,sum(pg_column_size(result))::text AS result_bytes,pg_total_relation_size('session_token_checks')::text AS table_and_indexes_bytes FROM session_token_checks")).rows[0];if(footprint.rows!==500)throw new Error('Daily token checks did not retain exactly one result per session');
  const statuses=(await db.query("SELECT status,count(*)::int AS jobs FROM jobs WHERE kind='session_token_check' GROUP BY status")).rows;if(statuses.length!==1||statuses[0].status!=='succeeded'||statuses[0].jobs!==500)throw new Error('Failed daily checks cannot pass resource validation');
  const output={fixture:{people:500,sessions:500,official_rows:9980+selectedRows,selected_linked_ids:selectedRows,all_links:allLinks,projection:'published',hook_events:519,selected_fragments:20,synthetic:true},scope:'Trusted daily task plus authorized service reads. Node CPU excludes PG; SQL counters exclude transaction setup and identity service queries. Sequential drain is not mixed collector or HTTP capacity.',samples,source_plan:sourcePlan,cache:footprint,statuses};
  await mkdir(new URL('../.run/',import.meta.url),{recursive:true});await writeFile(new URL(`../.run/token-check-resources-${selectedRows}.json`,import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({...output,source_plan:undefined}));
 }
 if(!tokenCheckMode){
 await mkdir(new URL('../.run/',import.meta.url),{recursive:true});await writeFile(new URL(`../.run/${reconciliationMode?(modelCheckMode?'official-model-reconciliation-plan':allLinks?'official-reconciliation-all-linked-plan':'official-reconciliation-plan'):modelMode?'model-analytics-plan':allLinks?'session-list-plan':'session-usage-plan'}-${selectedRows}.json`,import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),fixture:{people:500,sessions:500,official_rows:9980+selectedRows,selected_official_rows:selectedRows,all_links:allLinks,model_checks:modelCheckMode,synthetic:true},endpoint_ms:elapsed,plan,list_plans:listPlans,model_plans:modelPlans,reconciliation_plans:reconciliationPlans},null,2)+'\n');
 console.log(JSON.stringify({reconciliation:reconciliationPlans.map(row=>({days:row.days,endpoint_ms:row.endpoint_ms,sql_execution_ms:row.plan['Execution Time'],baseline_sql_ms:row.baseline_plan?.['Execution Time']??null})),people:500,official_rows:9980+selectedRows,selected_rows:selectedRows,endpoint_ms:elapsed,sql_execution_ms:plan['Execution Time'],lists:listPlans.map(row=>({channel:row.channel,endpoint_ms:row.endpoint_ms,sql_execution_ms:row.plan['Execution Time']})),models:modelPlans.map(row=>({kind:row.kind,endpoint_ms:row.endpoint_ms,sql_execution_ms:row.plan['Execution Time']}))}));
 }
} finally {for(const action of cleanup.reverse())await action();}
