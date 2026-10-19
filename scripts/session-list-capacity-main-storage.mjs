import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{createRequire}from'node:module';
import{performance}from'node:perf_hooks';
import{capacityDatabase,localDatabase,digest,verifyCapacityPromptIndex}from'./session-list-capacity-fixture.mjs';
const{Client}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('pg'),p=new URL('../.run/session-list-capacity/config.json',import.meta.url),f=JSON.parse(await readFile(p,'utf8'));
assert.equal(f.synthetic,true);assert.equal(f.scale,'full');assert.match(f.schema,/^test_[a-f0-9]{32}$/);const target=new URL(localDatabase);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55439');assert.equal(target.pathname,'/adi_capacity');
const schema=f.schema,deadline=900000,c=new Client({connectionString:localDatabase,statement_timeout:deadline,query_timeout:deadline+6000,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
const artifact=new URL('../.run/session-list-capacity/main-storage-'+Date.now()+'.json',import.meta.url),out={schema,synthetic:true,started_at:new Date().toISOString(),status:'preparing',stages:[],scope:'Physical MAIN prototype only. Source row values, generated lower values, quantities, IDs, timestamps, capture generations and normal application budgets unchanged. Offline VACUUM FULL recreates leaf heap/toast; original exact GINs are restored.'},save=()=>writeFile(artifact,JSON.stringify(out,null,2)+'\n');
const quote=s=>{assert.match(s,/^[a-z][a-z0-9_]*$/);return'"'+s+'"';};
const measure=async(name,sql)=>{const start=performance.now(),r=await c.query(sql);out.stages.push({name,elapsed_ms:performance.now()-start,sql_sha256:digest(sql)});await save();console.log(JSON.stringify(out.stages.at(-1)));return r;};
async function snapshot(){
 const cols=(await c.query("SELECT attname AS name FROM pg_attribute WHERE attrelid='hook_events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows.map(r=>quote(r.name)).join(',');
 const hooks=(await c.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS original_and_generated_row_sha256 FROM(SELECT encode(sha256(convert_to(jsonb_build_array(${cols})::text,'UTF8')),'hex') AS h FROM hook_events) rows`)).rows[0];
 const queries=(await c.query("SELECT count(*)::int AS queries,encode(sha256(convert_to(string_agg(to_jsonb(q)::text,'' ORDER BY provider_account,session_id),'UTF8')),'hex') AS query_rows_sha256,(SELECT sum(jsonb_array_length(b->'items'))::int FROM session_usage_queries CROSS JOIN LATERAL jsonb_array_elements(result->'bills') b) AS official_items FROM session_usage_queries q")).rows[0];
 const storage=(await c.query("SELECT c.relname AS table_name,a.attstorage AS storage,pg_relation_size(p.relid)::text AS heap_bytes,pg_total_relation_size(p.relid)::text AS total_bytes FROM pg_partition_tree('hook_events') p JOIN pg_class c ON c.oid=p.relid JOIN pg_attribute a ON a.attrelid=p.relid AND a.attname='prompt_search' ORDER BY c.relname")).rows;
 return {hooks,queries,storage};
}
try{
 await c.connect();await c.query('SET jit=off');out.before=await snapshot();assert.equal(out.before.hooks.count,f.actual.hook_events);assert.equal(out.before.queries.official_items,f.actual.official_items);await save();console.log(JSON.stringify({stage:'before_full_row_digest',hooks:out.before.hooks,queries:out.before.queries}));
 const definitions={};for(const name of ['hook_prompt_trgm','hook_prompt_search_trgm']){definitions[name]=(await c.query('SELECT pg_get_indexdef(to_regclass($1)) AS definition',[schema+'.'+name])).rows[0].definition.replace(/\bON ONLY\b/,'ON');await measure('temporarily_drop_'+name,`DROP INDEX ${quote(schema)}.${quote(name)}`);}
 await measure('main_storage_policy',`ALTER TABLE ${quote(schema)}.hook_events ALTER COLUMN prompt_search SET STORAGE MAIN`);
 const leaves=(await c.query("SELECT c.relname AS name FROM pg_partition_tree('hook_events') p JOIN pg_class c ON c.oid=p.relid WHERE p.isleaf ORDER BY c.relname")).rows;
 for(const leaf of leaves)await measure('vacuum_full_'+leaf.name,`VACUUM FULL ${quote(schema)}.${quote(leaf.name)}`);
 const indexes={};for(const name of ['hook_prompt_trgm','hook_prompt_search_trgm']){await measure('restore_'+name,definitions[name]);indexes[name]=await verifyCapacityPromptIndex(schema,{indexName:name,expectedExpression:name==='hook_prompt_trgm'?"(payload ->> 'prompt'::text)":null,expectedColumn:name==='hook_prompt_search_trgm'?'prompt_search':null,expectedDefinition:definitions[name],elapsedMs:out.stages.at(-1).elapsed_ms});}
 await measure('analyze','ANALYZE hook_events');out.after=await snapshot();assert.deepEqual(out.after.hooks,out.before.hooks);assert.deepEqual(out.after.queries,out.before.queries);assert.ok(out.after.storage.every(row=>row.storage==='m'));out.indexes=indexes;out.status='complete';out.finished_at=new Date().toISOString();await save();
 f.seed_setup.main_storage_prototype={artifact:artifact.pathname,...out};f.seed_setup.prompt_index=indexes.hook_prompt_trgm;f.seed_setup.normalized_prompt_index=indexes.hook_prompt_search_trgm;await writeFile(p,JSON.stringify(f,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({stage:'main_physical_fixture_ready',artifact:artifact.pathname,before:out.before.storage,after:out.after.storage}));
}catch(e){out.status='failed';out.error={code:e.code??e.name,message:e.message};await save();throw e;}finally{await c.end();const db=capacityDatabase(schema,false,1);await db.close();}
