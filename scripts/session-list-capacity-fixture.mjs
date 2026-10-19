import assert from 'node:assert/strict';
import {randomBytes,randomUUID,randomInt,createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {openDatabase} from '../packages/storage/dist/index.js';
import {createIdentityService} from '../packages/domain/dist/index.js';
import {syntheticPayloadEvent} from './session-list-capacity-events.mjs';
import {captureStaticStopFixtureOracle} from './session-list-capacity-oracle-db.mjs';
const {Client}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('pg');

export const account='synthetic-session-capacity';
export const localDatabase='postgres://adi_capacity:adi_capacity_synthetic_only@127.0.0.1:55439/adi_capacity';
export const containerDatabase='postgres://adi_capacity:adi_capacity_synthetic_only@postgres-capacity:5432/adi_capacity';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function capacityDatabase(schema,container=false,maxConnections=2){
 assert.match(schema,/^test_[a-f0-9]{32}$/);
 if(container)assert.equal(process.env.ADI_SESSION_CAPACITY_CONTAINER,'true');
 return openDatabase({connectionString:container?containerDatabase:localDatabase,schema,maxConnections});
}
const executableIndexDefinition=definition=>definition.replace(/\bON ONLY\b/,'ON');
/** Read-only verification, usable after a separately run test-admin repair. */
export async function verifyCapacityPromptIndex(schema,{indexName='hook_prompt_trgm',expectedExpression="(payload ->> 'prompt'::text)",expectedColumn=null,expectedDefinition,elapsedMs=null,manualRepair=false,originalInvalidAttempt}={}){
 assert.ok(['hook_prompt_trgm','hook_prompt_literal_trgm','hook_prompt_search_trgm','hook_prompt_literal_grams'].includes(indexName));
 const literalGrams=indexName==='hook_prompt_literal_grams';
 const db=capacityDatabase(schema, false,1);
 try{
  const result=await db.transaction(async sql=>{
   await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');await sql.query('SET LOCAL jit=off');
   const indexes=(await sql.query(`WITH RECURSIVE family AS(SELECT to_regclass($1) AS oid UNION ALL SELECT i.inhrelid FROM pg_inherits i JOIN family p ON p.oid=i.inhparent)
    SELECT c.relname AS index_name,c.relkind,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indisunique AS unique,i.indnkeyatts AS keys,i.indnatts AS attributes,i.indcollation[0]::integer AS collation_oid,key_attr.atttypid::regtype::text AS key_type,
    t.oid::text AS table_oid,t.relname AS table_name,a.amname AS method,o.opcname AS operator_class,n.nspname AS operator_schema,
    pg_get_indexdef(c.oid) AS definition,pg_get_expr(i.indexprs,i.indrelid) AS expression,attr.attname AS column_name,pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_relation_size(c.oid)::text AS bytes
    FROM family f JOIN pg_class c ON c.oid=f.oid JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_am a ON a.oid=c.relam JOIN pg_opclass o ON o.oid=i.indclass[0] JOIN pg_namespace n ON n.oid=o.opcnamespace LEFT JOIN pg_attribute attr ON attr.attrelid=i.indrelid AND attr.attnum=i.indkey[0] LEFT JOIN pg_attribute key_attr ON key_attr.attrelid=i.indexrelid AND key_attr.attnum=1 ORDER BY c.relkind,c.relname`,[schema+'.'+indexName])).rows;
   const tables=(await sql.query('SELECT relid::oid::text AS oid FROM pg_partition_tree($1::regclass) WHERE isleaf',[schema+'.hook_events'])).rows;
   const hasPrompts=(await sql.query("SELECT EXISTS(SELECT 1 FROM hook_events WHERE event_type='UserPromptSubmit' LIMIT 1) AS present")).rows[0].present;
   return {indexes,tables,hasPrompts};
  });
  const parent=result.indexes.find(i=>i.index_name===indexName&&i.relkind==='I');assert.ok(parent,'Partitioned GIN parent must exist');
  const expectedPredicate="(event_type = 'UserPromptSubmit'::text)";
  assert.ok(result.indexes.every(i=>i.valid&&i.ready&&i.live&&!i.unique&&i.keys===1&&i.attributes===1&&i.method==='gin'&&i.operator_class===(literalGrams?'array_ops':'gin_trgm_ops')&&i.operator_schema===(literalGrams?'pg_catalog':'public')&&(!literalGrams||i.collation_oid===0&&i.key_type==='bigint')&&i.expression===expectedExpression&&i.column_name===expectedColumn&&i.predicate===expectedPredicate),'Every GIN parent/child must be valid, ready, live and match the exact migrated expression/column/predicate/operator class');
  if(literalGrams)assert.equal(expectedExpression,'hook_prompt_codepoint_grams(prompt_search)');
  const children=result.indexes.filter(i=>i.relkind==='i'),covered=new Set(children.map(i=>i.table_oid));assert.equal(covered.size,result.tables.length);assert.ok(result.tables.every(t=>covered.has(t.oid)),'Every table leaf must have an attached physical GIN index');
  const bytes=result.indexes.reduce((n,i)=>n+BigInt(i.bytes),0n);if(result.hasPrompts)assert.ok(bytes>0n,'Populated prompt corpus requires positive physical GIN bytes');
  const definition=executableIndexDefinition(parent.definition);if(expectedDefinition)assert.equal(definition,executableIndexDefinition(expectedDefinition),'Rebuilt catalog definition must equal the original migrated index');
  return {definition,catalog_definition:parent.definition,elapsed_ms:elapsedMs,bytes:bytes.toString(),valid:true,ready:true,live:true,leaf_indexes:children.length,table_leaves:result.tables.length,index_catalog:result.indexes,maintenance_deadline_ms:900000,manual_repair:manualRepair,...(originalInvalidAttempt?{original_invalid_attempt:originalInvalidAttempt}:{}),scope:'Offline synthetic setup only. Partitioned CREATE runs without ON ONLY and all physical children are validated; ordinary application/query deadlines and resource limits unchanged.'};
 }finally{await db.close();}
}
const bodyBytes=n=>n%1000===0?524288:n%100<1?65536:n%10===0?8192:1024;
const text=bytes=>randomBytes(Math.ceil(bytes*3/4)).toString('base64').slice(0,bytes);
function classifications(count,full){
 const long=full?50:0,pool=[];
 for(const [channel,fraction]of [['official',.4],['pending',.2],['custom',.2],['mixed',.1],['unknown',.1]])for(let n=0;n<count*fraction-(channel==='official'?long:0);n++)pool.push(channel);
 for(let n=pool.length-1;n>0;n--){const j=randomInt(n+1);[pool[n],pool[j]]=[pool[j],pool[n]];}
 return [...Array(long).fill('official'),...pool];
}
/** History is explicitly synthetic fixture data. Live traffic uses Collector/worker.
 * No job is ever set to succeeded by fixture setup. */
export async function seedSessionCapacity({scale='full',fixtureBusinessDate,onProgress=()=>{}}={}){
 assert.ok(['full','smoke'].includes(scale));
 const full=scale==='full',peopleCount=full?500:10,sessionCount=full?50000:500;
 const schema='test_'+randomUUID().replaceAll('-',''),db=capacityDatabase(schema);let keepSchema=false;
 try{
  // Dedicated synthetic administrator bootstrap, distinct from app migrations.
  const target=new URL(localDatabase);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55439');assert.equal(target.username,'adi_capacity');assert.equal(target.pathname,'/adi_capacity');assert.equal(target.search,'');assert.equal(target.hash,'');
  const administrator=new Client({connectionString:localDatabase,connectionTimeoutMillis:2000,statement_timeout:5000,query_timeout:6000});
  try{await administrator.connect();await administrator.query('CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public');await administrator.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');}finally{await administrator.end();}
  await db.migrate();
  const promptIndexes=[];
  for(const indexName of ['hook_prompt_trgm','hook_prompt_search_trgm','hook_prompt_literal_grams']){
   const row=(await db.query('SELECT pg_get_indexdef(indexrelid) AS definition,pg_get_expr(indexprs,indrelid) AS expression FROM pg_index WHERE indexrelid=to_regclass($1)',[schema+'.'+indexName])).rows[0];
   assert.equal(typeof row?.definition,'string');assert.ok(row.definition.startsWith('CREATE INDEX '+indexName+' '));assert.ok(row.definition.includes(schema+'.hook_events'));
   promptIndexes.push({name:indexName,definition:row.definition,expression:row.expression});
  }
  // Offline synthetic bulk loading, before any capacity application starts.
  // Preserve the exact migrated index and rebuild it before returning config.
  for(const index of promptIndexes)await db.query(`DROP INDEX "${schema}".${index.name}`);
  const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const seed=await identity.bootstrap({email:'capacity-admin@example.invalid',name:'Synthetic capacity administrator'});
  const temporary=await identity.login('capacity-admin@example.invalid',seed.temporaryPassword);
  const password='synthetic-session-capacity-password';
  const admin=await identity.changePassword(temporary.token,seed.temporaryPassword,password);
  const generatedAt=Date.now(),todayMidnight=Math.floor((generatedAt+28800000)/86400000)*86400000-28800000;
  const midnight=fixtureBusinessDate?Date.parse(fixtureBusinessDate+'T00:00:00+08:00'):todayMidnight;
  assert.ok(Number.isFinite(midnight));assert.ok([todayMidnight,todayMidnight+86400000].includes(midnight),'Only current or next actual Beijing business date may be prepared');
  fixtureBusinessDate=new Date(midnight+28800000).toISOString().slice(0,10);
  const period={from:new Date(midnight-44*86400000).toISOString(),to:new Date(midnight+86400000).toISOString()};
  const firstFloor=Date.parse(period.from)+3600000,latestFirst=Math.min(midnight+3600000,generatedAt-300000),historySpan=latestFirst-firstFloor;
  assert.ok(historySpan>0);
  await db.ensurePartitions(new Date(period.from),new Date(period.to));
  const departments=Array.from({length:10},(_,n)=>({id:randomUUID(),name:'Synthetic department '+n}));
  await db.query('INSERT INTO departments(id,name) SELECT id,name FROM jsonb_to_recordset($1::jsonb) x(id uuid,name text)',[JSON.stringify(departments)]);
  const people=Array.from({length:peopleCount},(_,n)=>({n,user_id:n===0?admin.user.user_id:randomUUID(),email:n===0?'capacity-admin@example.invalid':`capacity-person-${n}@example.invalid`,installation:randomUUID(),token:randomBytes(32).toString('base64url'),department:departments[n%10].id}));
  await db.query('CREATE TABLE capacity_fixture_people(n integer PRIMARY KEY,user_id uuid NOT NULL,installation uuid NOT NULL,department uuid NOT NULL)');
  await db.query('INSERT INTO capacity_fixture_people SELECT n,user_id,installation,department FROM jsonb_to_recordset($1::jsonb) x(n integer,user_id uuid,installation uuid,department uuid)',[JSON.stringify(people)]);
  await db.query(`INSERT INTO users(id,email_key,display_name,registered_at) SELECT user_id,email,'Synthetic person '||n,$2 FROM jsonb_to_recordset($1::jsonb) x(n integer,user_id uuid,email text) WHERE n>0`,[JSON.stringify(people),period.from]);
  await db.query('UPDATE users SET registered_at=$1',[period.from]);
  await db.query(`INSERT INTO credentials(user_id,password_hash,must_change) SELECT p.user_id,c.password_hash,false FROM capacity_fixture_people p CROSS JOIN credentials c WHERE c.user_id=$1 AND p.n>0`,[admin.user.user_id]);
  await db.query(`INSERT INTO installations(id,user_id,token_hash,label) SELECT installation,user_id,token_hash,'Synthetic capacity installation' FROM jsonb_to_recordset($1::jsonb) x(installation uuid,user_id uuid,token_hash text)`,[JSON.stringify(people.map(p=>({...p,token_hash:digest(p.token)})))]);
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) SELECT user_id,department,$1 FROM capacity_fixture_people',[period.from]);
  await db.query(`INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) SELECT $1,id,'capacity-provider-'||id,email_key FROM users`,[account]);
  const heavy=people[1],channels=classifications(sessionCount,full);
  const sessions=Array.from({length:sessionCount},(_,n)=>{
   const owner=full?(n<25000?people[n%50]:people[50+(n-25000)%450]):people[n%people.length];
   const events=full?(n<50?4001:n<500?401:n<5000?41:9):9;
   const first=new Date(firstFloor+n*historySpan/sessionCount);
   return {n,id:randomUUID(),user_id:owner.user_id,installation:owner.installation,department:owner.department,source_session_id:`synthetic-capacity-${n}`,first_at:first.toISOString(),last_at:new Date(first.getTime()+(events-1)*250).toISOString(),events,channel:channels[n]};
  });
  const ordinary=people.slice(full?50:2).find(p=>['official','pending','custom'].every(c=>sessions.filter(s=>s.user_id===p.user_id&&(s.channel===c||s.channel==='mixed'&&c!=='pending')).length>5))??people[full?50:2];
  const own=await identity.login(ordinary.email,password),heavyLogin=await identity.login(heavy.email,password);
  await db.query('CREATE TABLE capacity_fixture_sessions(n integer PRIMARY KEY,id uuid NOT NULL,user_id uuid NOT NULL,channel text NOT NULL)');
  for(let start=0;start<sessions.length;start+=500){
   const rows=sessions.slice(start,start+500),encoded=JSON.stringify(rows);
   await db.query('INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) SELECT id,user_id,source_session_id,first_at,last_at FROM jsonb_to_recordset($1::jsonb) x(id uuid,user_id uuid,source_session_id text,first_at timestamptz,last_at timestamptz)',[encoded]);
   await db.query('INSERT INTO capacity_fixture_sessions SELECT n,id,user_id,channel FROM jsonb_to_recordset($1::jsonb) x(n integer,id uuid,user_id uuid,channel text)',[encoded]);
  }
  const batchMaxRows=100,batchMaxBytes=1048576;
  let eventNumber=0,payloadBytes=0,textBytes=0,maxTextBytes=0,batch=[],batchBytes=2,batchCount=0,batchPeakRows=0,batchPeakBytes=0;const textHistogram={};
  async function flush(){if(!batch.length)return;await db.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload,capture_generation,timestamp_source)
   SELECT id,occurred_at,$2,user_id,department,installation,session_id,event_type,payload,capture_generation,'client_observed' FROM jsonb_to_recordset($1::jsonb) x(id uuid,occurred_at timestamptz,user_id uuid,department uuid,installation uuid,session_id uuid,event_type text,payload jsonb,capture_generation integer)`,['['+batch.join(',')+']',new Date()]);batchCount++;batchPeakRows=Math.max(batchPeakRows,batch.length);batchPeakBytes=Math.max(batchPeakBytes,batchBytes);batch=[];batchBytes=2;}
  async function append(row){const encoded=JSON.stringify(row),bytes=Buffer.byteLength(encoded);assert.ok(bytes+2<=batchMaxBytes);
   if(batch.length&&(batch.length>=batchMaxRows||batchBytes+bytes+1>batchMaxBytes))await flush();
   batchBytes+=bytes+(batch.length?1:0);batch.push(encoded);
   if(batch.length>=batchMaxRows)await flush();
  }
  for(const s of sessions){
   for(let e=0;e<s.events;e++){
    const bytes=bodyBytes(eventNumber),prefix=`[synthetic-search:${s.n%17}] `,content=prefix+text(bytes-Buffer.byteLength(prefix));
    const {event_type,payload}=syntheticPayloadEvent(e,s.events,content,s.source_session_id);
    const actualText=Buffer.byteLength(content);textBytes+=actualText;maxTextBytes=Math.max(maxTextBytes,actualText);textHistogram[actualText]=(textHistogram[actualText]??0)+1;payloadBytes+=Buffer.byteLength(JSON.stringify(payload));
    await append({id:randomUUID(),occurred_at:new Date(Date.parse(s.first_at)+e*250).toISOString(),user_id:s.user_id,department:s.department,installation:s.installation,session_id:s.id,event_type,payload,capture_generation:0});eventNumber++;
   }
   if(s.n%500===0)onProgress({stage:'hooks',sessions:s.n,events:eventNumber,payload_bytes:payloadBytes});
  }
  if(full)for(let n=0;n<10000;n++){
   const s=sessions[n],content=text(bodyBytes(eventNumber)),payload={message:content};textBytes+=Buffer.byteLength(content);maxTextBytes=Math.max(maxTextBytes,Buffer.byteLength(content));textHistogram[content.length]=(textHistogram[content.length]??0)+1;payloadBytes+=Buffer.byteLength(JSON.stringify(payload));
   await append({id:randomUUID(),occurred_at:s.first_at,user_id:s.user_id,department:s.department,installation:s.installation,session_id:s.id,event_type:'Notification',payload,capture_generation:0});eventNumber++;
  }
  await flush();onProgress({stage:'hooks_complete',events:eventNumber,payload_bytes:payloadBytes});
  await db.query(`INSERT INTO session_personal_models(session_id,user_id,models,cleanup_generation) SELECT id,user_id,'["Synthetic personal model"]'::jsonb,0 FROM capacity_fixture_sessions WHERE channel IN('custom','mixed')`);
  await db.query(`INSERT INTO jobs(id,kind,dedupe_key,payload,available_at) SELECT gen_random_uuid(),'usage_attribution','usage-link:'||$1||':'||id,jsonb_build_object('provider_account',$1::text,'session_id',id::text,'recurring',false),clock_timestamp()+interval '1 day' FROM capacity_fixture_sessions WHERE channel='pending'`,[account]);
  // Compute exactly the real source key from persisted Hook facts. Unique bill IDs
  // preserve claim semantics; quantities exist only in this independent query source.
  for(let start=0;start<sessionCount;start+=250){
   await db.query(`INSERT INTO session_usage_queries(provider_account,session_id,user_id,provider_user_id,cleanup_generation,ingest_epoch,hook_key,observed_at,result)
    SELECT $1,s.id,s.user_id,'capacity-provider-'||s.user_id,0,1,
    md5(jsonb_build_array(s.first_at,s.last_at,s.history_redacted,s.history_expired,COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id,e.occurred_at,e.capture_generation) ORDER BY e.occurred_at,e.id) FROM hook_events e WHERE e.session_id=s.id),'[]'::jsonb))::text),$4::timestamptz,
    jsonb_build_object('windows','[]'::jsonb,'reasons','[]'::jsonb,'bills',(SELECT jsonb_agg(jsonb_build_object('id','capacity-bill-'||s.id||'-'||b,'basis','single_hook_query','observed_at',($4::timestamptz)::text,'response_hash',repeat('a',64),'request_id','synthetic-fixture','items',jsonb_build_array(jsonb_build_object('billing_session_id','capacity-bill-'||s.id||'-'||b,'provider_user_id','capacity-provider-'||s.user_id,'start_time',floor(extract(epoch FROM s.first_at))::text,'client','ide','scene','Chat','model_name','Synthetic model '||(b%4),'model_type','Chat','model_source','Trae','consumption_source','basic','model_call_count','1','departments','[]'::jsonb,'usage',jsonb_build_object('total_tokens','100','prompt_tokens','80','completion_tokens','20','cache_creation_input_tokens','0','cache_read_input_tokens','0'),'amount','0.000000','amount_reason',NULL,'currency','CNY','quality','[]'::jsonb,'token_basis','provider_reported')))) FROM generate_series(1,CASE WHEN f.n<50 AND $5::boolean THEN 100 ELSE 8 END) b))
    FROM sessions s JOIN capacity_fixture_sessions f ON f.id=s.id WHERE f.n>=$2 AND f.n<$3 AND f.channel IN('official','mixed')`,[account,start,start+250,new Date().toISOString(),full]);
  }
  // A tenth of real published query fixtures also exercises Stop-window safety.
  // One discovered bill contains all model items; duplicate model rows remain
  // separate quantities, and this does not invent multiple unique candidates.
  for(let start=0;start<sessionCount;start+=250)await db.query(`UPDATE session_usage_queries q SET result=jsonb_build_object('reasons','[]'::jsonb,
   'windows',jsonb_build_array(jsonb_build_object('event_id',e.id,'at',e.occurred_at,'from',floor(extract(epoch FROM e.occurred_at))-1,'to',floor(extract(epoch FROM e.occurred_at))+1,'ids',jsonb_build_array('synthetic-static-stop-'||s.id),'start_seconds',jsonb_build_array(floor(extract(epoch FROM e.occurred_at))))),
   'bills',jsonb_build_array(jsonb_build_object('id','synthetic-static-stop-'||s.id,'basis','stop_window','observed_at',q.observed_at,'response_hash',repeat('c',64),'request_id','synthetic-static-stop',
   'items',(SELECT jsonb_agg(jsonb_set(jsonb_set(i.value,'{billing_session_id}',to_jsonb('synthetic-static-stop-'||s.id)),'{start_time}',to_jsonb(floor(extract(epoch FROM e.occurred_at))::text))) FROM jsonb_array_elements(q.result->'bills') b CROSS JOIN LATERAL jsonb_array_elements(b->'items') i(value)))))
   FROM capacity_fixture_sessions f JOIN sessions s ON s.id=f.id JOIN LATERAL(SELECT id,occurred_at FROM hook_events WHERE session_id=s.id AND event_type='Stop' ORDER BY occurred_at DESC,id DESC LIMIT 1) e ON true
   WHERE q.session_id=s.id AND f.n>=$1 AND f.n<$2 AND f.n%10=0`,[start,start+250]);
  const maintenanceDeadlineMs=900000,maintenance=new Client({connectionString:localDatabase,connectionTimeoutMillis:2000,statement_timeout:maintenanceDeadlineMs,query_timeout:maintenanceDeadlineMs,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
  const indexMetadata={};
  try{await maintenance.connect();for(const index of promptIndexes){
   const started=performance.now();await maintenance.query(executableIndexDefinition(index.definition));const elapsedMs=performance.now()-started;
   const metadata=await verifyCapacityPromptIndex(schema,{indexName:index.name,expectedExpression:index.expression,expectedColumn:index.name==='hook_prompt_search_trgm'?'prompt_search':null,expectedDefinition:index.definition,elapsedMs});
   indexMetadata[index.name==='hook_prompt_trgm'?'prompt_index':index.name==='hook_prompt_search_trgm'?'normalized_prompt_index':'literal_prompt_index']=metadata;
   onProgress({stage:'prompt_index_ready',index_name:index.name,elapsed_ms:elapsedMs,index_bytes:metadata.bytes,maintenance_deadline_ms:maintenanceDeadlineMs});
  }
  // Expression-index sampling reads large source bodies too. It is part of
  // offline bulk-load maintenance, before any application capacity measurement.
  const started=performance.now();await maintenance.query('ANALYZE hook_events');const analyze={status:'complete',elapsed_ms:performance.now()-started,maintenance_deadline_ms:maintenanceDeadlineMs};for(const metadata of Object.values(indexMetadata))metadata.analyze=analyze;
  }finally{await maintenance.end();}
  for(const table of ['users','sessions','session_usage_queries','usage_provider_identities','session_personal_models','jobs','membership_periods'])await db.query(`ANALYZE ${table}`);
  const actual=(await db.query(`SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM sessions) sessions,(SELECT count(*)::int FROM hook_events) hook_events,(SELECT sum(jsonb_array_length(b->'items'))::int FROM session_usage_queries q CROSS JOIN LATERAL jsonb_array_elements(q.result->'bills') b) official_items,(SELECT count(*)::int FROM session_usage_queries) session_queries,(SELECT count(*)::int FROM session_usage_queries q WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(q.result->'bills') b WHERE b->>'basis'='stop_window')) stop_window_queries,(SELECT count(*)::int FROM jobs WHERE status='succeeded') fixture_succeeded_jobs`)).rows[0];
  assert.equal(actual.users,peopleCount);assert.equal(actual.sessions,sessionCount);assert.equal(actual.hook_events,eventNumber);assert.equal(actual.fixture_succeeded_jobs,0);
  if(full)assert.equal(actual.official_items,204600);
  const expected={},expected_page_ids={};
  for(const scope of ['mine-normal','mine-heavy','super-all','super-department'])for(const channel of ['all','official','pending','custom'])for(const variant of ['first','search','next']){
   const rows=sessions.filter(s=>scope==='super-all'||scope==='super-department'&&s.department===departments[0].id||scope==='mine-normal'&&s.user_id===ordinary.user_id||scope==='mine-heavy'&&s.user_id===heavy.user_id).filter(s=>channel==='all'||s.channel===channel||s.channel==='mixed'&&['official','custom'].includes(channel)).filter(s=>variant!=='search'||s.n%17===1);
   expected[scope+'/'+channel+'/'+variant]=rows.length;
   rows.sort((a,b)=>a.last_at>b.last_at?-1:a.last_at<b.last_at?1:a.id>b.id?-1:a.id<b.id?1:0);
   expected_page_ids[scope+'/'+channel+'/'+variant]=rows.slice(variant==='next'?5:0,variant==='next'?10:20).map(s=>s.id);
   if(variant==='next')expected_page_ids[scope+'/'+channel+'/next-setup']=rows.slice(0,5).map(s=>s.id);
  }
  const static_stop_oracle=await captureStaticStopFixtureOracle(db,account);
  assert.equal(static_stop_oracle.length,actual.stop_window_queries);
  keepSchema=true;
  const item_oracle=Object.fromEntries(sessions.map(s=>[s.id,{user_id:s.user_id,channel:s.channel,official_tokens:['official','mixed'].includes(s.channel)?String(full&&s.n<50?10000:800):null,official_records:['official','mixed'].includes(s.channel)?full&&s.n<50?100:8:0}]));
  assert.ok(maxTextBytes<=524288);
  return {version:9,synthetic:true,scale,schema,fixture_business_date:fixtureBusinessDate,fixture_generation:{generated_at:new Date(generatedAt).toISOString(),earliest_session_at:new Date(firstFloor).toISOString(),latest_session_start_bound:new Date(latestFirst).toISOString(),history_span_ms:historySpan,scope:'Independent newly randomized synthetic facts and IDs; not a shift or hash-equivalent copy. Forty-five Beijing business-day window includes the declared target day; preparation before that day has no initial facts after real now minus five minutes. Live events use actual clock.'},provider_account:account,period,people,departments,admin_token:admin.token,own_token:own.token,heavy_token:heavyLogin.token,own_user:ordinary.user_id,heavy_user:heavy.user_id,actual,expected,expected_page_ids,item_oracle,static_stop_oracle,payload_bytes:payloadBytes,text_bytes:textBytes,max_text_bytes:maxTextBytes,text_size_histogram:textHistogram,seed_setup:{hook_batch_max_rows:batchMaxRows,hook_batch_max_bytes:batchMaxBytes,hook_batches:batchCount,hook_batch_peak_rows:batchPeakRows,hook_batch_peak_bytes:batchPeakBytes,...indexMetadata},history_capture_generation:0,history_scope:'Preconstructed synthetic source facts at generation 0; no forged succeeded jobs or derived projections. Live continuation must be derived by the real worker.',long_sessions:sessions.slice(0,full?50:1).map(s=>({id:s.id,user_id:s.user_id,source_session_id:s.source_session_id,initial_events:s.events})),seeded_at:new Date().toISOString()};
 }catch(error){await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});throw error;}finally{if(!keepSchema)onProgress({stage:'failed_fixture_removed',schema});await db.close();}
}
