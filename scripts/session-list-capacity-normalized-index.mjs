import assert from 'node:assert/strict';
import{readFile,writeFile,rename}from'node:fs/promises';
import{createRequire}from'node:module';
import{performance}from'node:perf_hooks';
import{capacityDatabase,localDatabase,digest,verifyCapacityPromptIndex}from'./session-list-capacity-fixture.mjs';
const{Client}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('pg');
const path=new URL('../.run/session-list-capacity/config.json',import.meta.url),fixture=JSON.parse(await readFile(path,'utf8'));
assert.equal(fixture.synthetic,true);assert.equal(fixture.scale,'full');assert.match(fixture.schema,/^test_[a-f0-9]{32}$/);
const target=new URL(localDatabase);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55439');assert.equal(target.pathname,'/adi_capacity');assert.equal(target.username,'adi_capacity');
const schema=fixture.schema,deadline=900000,admin=new Client({connectionString:localDatabase,connectionTimeoutMillis:2000,statement_timeout:deadline,query_timeout:deadline+6000,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
const save=async()=>{await writeFile(path.pathname+'.tmp',JSON.stringify(fixture,null,2)+'\n');await rename(path.pathname+'.tmp',path);};
const stages=[],measure=async(name,sql)=>{const start=performance.now();await admin.query(sql);const stage={name,elapsed_ms:performance.now()-start,sql_sha256:digest(sql)};stages.push(stage);fixture.seed_setup.normalized_prompt_setup={status:'pending',maintenance_deadline_ms:deadline,stages};await save();console.log(JSON.stringify(stage));};
try{
 await admin.connect();await admin.query('SET jit=off');
 const raw=await verifyCapacityPromptIndex(schema),rawDefinition=raw.definition;
 if(fixture.seed_setup.literal_prompt_index){fixture.seed_setup.rejected_literal_prompt_indexes=[...(fixture.seed_setup.rejected_literal_prompt_indexes??[]),{...fixture.seed_setup.literal_prompt_index,rejected:true,reason:'Regexp necessary-condition candidate exceeded the five-second global read budget and increased recheck candidates; original ILIKE exactness retained but performance failed.',performance_artifact:'.run/literal-search-plan-1791552712807.json'}];delete fixture.seed_setup.literal_prompt_index;await save();}
 const before=(await admin.query("SELECT count(*)::int AS events,count(*) FILTER(WHERE event_type='UserPromptSubmit')::int AS prompts FROM hook_events")).rows[0];assert.equal(before.events,fixture.actual.hook_events);
 const beforeStorage=(await admin.query("SELECT sum(pg_total_relation_size(relid))::text AS hook_events_total_bytes FROM pg_partition_tree('hook_events') WHERE isleaf")).rows[0];fixture.seed_setup.normalized_prompt_setup={status:'pending',before_storage:beforeStorage};await save();
 await measure('remove_rejected_expression_gin',`DROP INDEX IF EXISTS ${schema}.hook_prompt_literal_trgm`);
 // Avoid rebuilding an unchanged large GIN during the generated-column table
 // rewrite. Restore and verify its exact definition before applications restart.
 await measure('temporarily_remove_raw_prompt_gin',`DROP INDEX ${schema}.hook_prompt_trgm`);
 await measure('native_stored_projection',`ALTER TABLE ${schema}.hook_events ADD COLUMN IF NOT EXISTS prompt_search text GENERATED ALWAYS AS (CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END) STORED`);
 await measure('restore_exact_raw_prompt_gin',rawDefinition);
 fixture.seed_setup.prompt_index=await verifyCapacityPromptIndex(schema,{expectedDefinition:rawDefinition,elapsedMs:stages.find(s=>s.name==='restore_exact_raw_prompt_gin').elapsed_ms});await save();
 await measure('native_normalized_prompt_gin',`CREATE INDEX IF NOT EXISTS hook_prompt_search_trgm ON ${schema}.hook_events USING gin(prompt_search public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'`);
 fixture.seed_setup.normalized_prompt_index=await verifyCapacityPromptIndex(schema,{indexName:'hook_prompt_search_trgm',expectedExpression:null,expectedColumn:'prompt_search',elapsedMs:stages.find(s=>s.name==='native_normalized_prompt_gin').elapsed_ms});await save();
 await measure('analyze_generated_projection','ANALYZE hook_events');
 const after=(await admin.query("SELECT count(*)::int AS events,count(*) FILTER(WHERE event_type='UserPromptSubmit')::int AS prompts FROM hook_events")).rows[0];assert.deepEqual(after,before,'offline projection preserves all source fact counts');
 const columnCatalog=(await admin.query("SELECT c.relname AS table_name,a.attgenerated AS generated,a.attcollation='pg_catalog.\"default\"'::regcollation AS default_collation,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_partition_tree('hook_events') p JOIN pg_class c ON c.oid=p.relid JOIN pg_attribute a ON a.attrelid=p.relid AND a.attname='prompt_search' JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum ORDER BY c.relname")).rows;
 const storage=(await admin.query("SELECT sum(octet_length(prompt_search))::text AS normalized_text_logical_bytes,sum(pg_column_size(prompt_search))::text AS normalized_text_column_bytes FROM hook_events WHERE event_type='UserPromptSubmit'")).rows[0];
 storage.hook_events_total_bytes=(await admin.query("SELECT sum(pg_total_relation_size(relid))::text AS bytes FROM pg_partition_tree('hook_events') WHERE isleaf")).rows[0].bytes;
 storage.physical_increment_bytes=(BigInt(storage.hook_events_total_bytes)-BigInt(beforeStorage.hook_events_total_bytes)).toString();
 fixture.seed_setup.normalized_prompt_setup={status:'prebuilt',maintenance_deadline_ms:deadline,stages,before,after,column_catalog:columnCatalog,before_storage:beforeStorage,after_storage:storage,scope:'Offline isolated synthetic generated projection/index setup only. Raw facts/counts unchanged, normal application 5-second SQL and quotas unchanged. Generated text follows original row ingest/cleanup/recovery automatically.'};await save();
}catch(e){fixture.seed_setup.normalized_prompt_setup={...fixture.seed_setup.normalized_prompt_setup,status:'failed',error:{code:e.code??e.name,message:e.message},stages};await save();throw e;}finally{await admin.end();}
const db=capacityDatabase(schema,false,1);try{await db.migrate();}finally{await db.close();}
fixture.seed_setup.normalized_prompt_setup.status='complete';await save();
console.log(JSON.stringify({stage:'normalized_projection_verified',config_sha256:digest(await readFile(path)),raw_index_bytes:fixture.seed_setup.prompt_index.bytes,normalized_index_bytes:fixture.seed_setup.normalized_prompt_index.bytes,setup:fixture.seed_setup.normalized_prompt_setup}));
