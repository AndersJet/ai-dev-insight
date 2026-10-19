// Bounded synthetic before/after measurement. Never load the application's .env.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {testDatabase} from '../packages/storage/test/helpers.ts';
import {createIdentityService,createSessionDerivationService,createUsageSnapshotStore} from '../packages/domain/src/index.ts';
import {queryBillingSimulation} from '../packages/domain/src/billing-simulation.ts';

const baselineRef='7773ccae64e0bbdd16d270ffb1b64c69b5855da5';
const root=new URL('../',import.meta.url),runDir=new URL('.run/',root);
const cleanups=[];const db=await testDatabase({after:fn=>cleanups.push(fn)});
await mkdir(runDir,{recursive:true});
const scratch=await mkdtemp(fileURLToPath(new URL('simulation-baseline-',runDir)));
const originalHashes={};
try{
 // Preserve the frozen calculation; redirect only module imports to run both
 // versions against the same current projection, errors and storage contracts.
 for(const name of ['billing-simulation','simulation-baseline']){
  const original=execFileSync('git',['show',`${baselineRef}:packages/domain/src/${name}.ts`],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:1024*1024});
  originalHashes[name]=createHash('sha256').update(original).digest('hex');
  const linked=original.replace(/from '(\.\/[^']+)\.js'/g,(_all,target)=>{
   const file=target.slice(2);
   return `from '${['billing-simulation','simulation-baseline'].includes(file)?`./${file}.ts`:new URL(`packages/domain/src/${file}.ts`,root).href}'`;
  });
  await writeFile(`${scratch}/${name}.ts`,linked);
 }
 const oldQuery=(await import(pathToFileURL(`${scratch}/billing-simulation.ts`).href)).queryBillingSimulation;
 await db.migrate();const now=new Date();const today=Math.floor((now.getTime()+28800000)/86400000)*86400000-28800000;
 const from=new Date(today-86400000),to=new Date(today),at=new Date(today-43200000),period={from:from.toISOString(),to:to.toISOString()};
 await db.ensurePartitions(from,new Date(today+86400000));
 const identity=createIdentityService(db,{emailDomains:['example.invalid']});
 const seeded=await identity.bootstrap({email:'simulation-plan@example.invalid',name:'合成模拟测量'});
 const people=(await db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'simulation-plan-'||g||'@example.invalid','合成'||g FROM generate_series(1,499) g RETURNING id,email_key")).rows;
 people.unshift({id:seeded.userId,email_key:'simulation-plan@example.invalid'});
 const store=createUsageSnapshotStore(db,{providerAccount:'synthetic-plan'}),date=new Date(from.getTime()+28800000).toISOString().slice(0,10);
 for(const person of people){
  const draft=await store.begin(person.id,date),parameters=draft.parts[0].query;
  const items=Array.from({length:20},(_,i)=>({billing_session_id:`synthetic-${i}`,provider_user_id:`provider-${person.id}`,email:person.email_key,start_time:String(parameters.start_time+3600),client:'ide',scene:'Chat',model_name:'Synthetic Model',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:'8',completion_tokens:'2',total_tokens:'10',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:'CNY',quality:[],token_basis:'provider_reported'}));
  await store.stage(draft,0,{items,pagination:{page:1,page_size:200,total:20,total_pages:1},request_id:'synthetic',observed_at:now.toISOString(),response_hash:createHash('sha256').update(JSON.stringify(items)).digest('hex'),query:{endpoint:'user_usage_detail',parameters:{...parameters,page:1}}});await store.publish(draft);
 }
 const installation=randomUUID();await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,seeded.userId,'c'.repeat(64),'合成']);
 let seq=0,sid;
 async function put(event_type,payload){const r=await db.ingest({schema_version:2,installation_id:installation,client_event_id:String(++seq),occurred_at:new Date(at.getTime()+seq*1000).toISOString(),event_type,source_session_id:'synthetic-simulation-plan',payload},{admissionEpoch:1,receivedAt:now});assert.equal(r.outcome,'committed');sid=r.sessionId;}
 for(let turn=0;turn<5;turn++){
  await put('UserPromptSubmit',{prompt:'合成提示'.repeat(128),model:'Synthetic Model'});
  for(let step=0;step<4;step++){const tool_use_id=`${turn}-${step}`;await put('PreToolUse',{tool_use_id,tool_name:'Read',tool_input:{path:'synthetic.txt'}});await put('PostToolUse',{tool_use_id,tool_name:'Read',tool_response:'合成工具内容'.repeat(128)});}
  await put('Stop',{last_assistant_message:'合成回答'.repeat(128),stop_hook_active:false,last_stop_reentry_count:0});
 }
 const worker=createSessionDerivationService(db);let jobs=0;while(await worker.runOne())assert.ok(++jobs<30);
 await db.query(`ANALYZE "${db.schema}".usage_scopes`);await db.query(`ANALYZE "${db.schema}".usage_observations`);
 let statements=[];
 const trace=sql=>({...sql,query:async(text,values)=>{const r=await sql.query(text,values);statements.push({text,values,rows:r.rows.length});return r;}});
 const traced={...trace(db),transaction:fn=>db.transaction(sql=>fn(trace(sql)))};
 const metrics=[];
 async function measure(name,query){statements=[];const cpu=process.cpuUsage(),start=performance.now();const result=await query(traced,sid,seeded.userId,period,{},'synthetic-plan');const elapsed=performance.now()-start,used=process.cpuUsage(cpu);assert.equal(result.reason,null);assert.equal(result.baseline.tokens,'24000');assert.ok(BigInt(result.simulated_input_tokens)>0n);return {result,queries:[...statements],metric:{name,elapsed_ms:elapsed,node_cpu_ms:(used.user+used.system)/1000,sql_statements:statements.length,returned_rows:statements.reduce((n,s)=>n+s.rows,0),write_statements:statements.filter(s=>/^\s*(INSERT|UPDATE|DELETE)/i.test(s.text)).length}};}
 const prior=await measure('before_first',oldQuery);metrics.push(prior.metric);
 const first=await measure('after_first',queryBillingSimulation);metrics.push(first.metric);assert.equal(first.result.simulated_input_tokens,prior.result.simulated_input_tokens);
 for(let i=0;i<10;i++){
  for(const [name,query] of i%2?[['after_hit',queryBillingSimulation],['before_repeat',oldQuery]]:[['before_repeat',oldQuery],['after_hit',queryBillingSimulation]]){
   const measured=await measure(name,query);assert.equal(measured.result.simulated_input_tokens,prior.result.simulated_input_tokens);if(name==='after_hit')assert.equal(measured.result.computed_at,first.result.computed_at);metrics.push(measured.metric);
  }
 }
 const hit=await measure('after_hit_plan',queryBillingSimulation);
 // Explain cache hits while the measured key is still resident. First-miss
 // SQL cannot be replayed faithfully after publication, so report its observed
 // statement/row counts only rather than presenting a warm plan as a miss.
 const measuredPlans={before:await plans(prior.queries),after_hit:await plans(hit.queries)};
 const concurrent=[];
 for(const name of ['after_cold_20','after_warm_20']){
  statements=[];const cpu=process.cpuUsage(),start=performance.now(),durations=[];
  const results=await Promise.all(Array.from({length:20},async()=>{const began=performance.now();const r=await queryBillingSimulation(traced,sid,seeded.userId,period,{base_tokens:'10000'},'synthetic-plan');durations.push(performance.now()-began);return r;}));
  const used=process.cpuUsage(cpu);assert.ok(results[0].computed_at);assert.equal(results[0].reason,null);
  assert.equal(new Set(results.map(r=>r.computed_at)).size,1);assert.equal(new Set(results.map(r=>r.simulated_input_tokens)).size,1);
  durations.sort((a,b)=>a-b);concurrent.push({name,requests:20,elapsed_ms:performance.now()-start,node_cpu_ms:(used.user+used.system)/1000,request_ms:durations,sql_statements:statements.length,returned_rows:statements.reduce((n,s)=>n+s.rows,0),write_statements:statements.filter(s=>/^\s*(INSERT|UPDATE|DELETE)/i.test(s.text)).length});
 }
 async function plans(queries){const seen=new Set(),result=[];for(const q of queries){if(seen.has(q.text)||!/^\s*(SELECT|WITH)/i.test(q.text)||/FOR (UPDATE|SHARE)/i.test(q.text))continue;seen.add(q.text);const plan=(await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${q.text}`,q.values)).rows[0]['QUERY PLAN'][0];result.push({sql_hash:createHash('sha256').update(q.text).digest('hex'),returned_rows:q.rows,plan});}return result;}
 const footprint=(await db.query("SELECT count(*)::int AS rows,coalesce(sum(pg_column_size(result)),0)::text AS result_bytes,pg_total_relation_size('session_simulation_cache')::text AS table_and_indexes_bytes FROM session_simulation_cache")).rows[0];
 const output={baseline_ref:baselineRef,baseline_original_sha256:originalHashes,scope:'Calculation-only controlled comparison: same current session projection and DB contracts, frozen old calculation imports relinked. No HTTP, collector, PG CPU, physical I/O, or annual capacity claim.',fixture:{people:500,bills:10000,hook_events:seq,turns:5,tools:20,period},metrics,concurrent,cache:footprint,plans:measuredPlans};
 const destination=new URL('simulation-cache-resources.json',runDir);await writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({artifact:fileURLToPath(destination),metrics,concurrent,cache:footprint}));
}finally{for(const fn of cleanups)await fn();await rm(scratch,{recursive:true,force:true});}
