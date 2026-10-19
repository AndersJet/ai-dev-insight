import assert from 'node:assert/strict';
import{readFile,writeFile,rename}from'node:fs/promises';
import{createRequire}from'node:module';
import{randomUUID}from'node:crypto';
import{performance}from'node:perf_hooks';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{capacityDatabase,localDatabase,digest,verifyCapacityPromptIndex}from'./session-list-capacity-fixture.mjs';
const{Client}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('pg');
const configPath=new URL('../.run/session-list-capacity/config.json',import.meta.url),originalBytes=await readFile(configPath),fixture=JSON.parse(originalBytes.toString('utf8'));
assert.equal(fixture.synthetic,true);assert.equal(fixture.scale,'full');assert.match(fixture.schema,/^test_[a-f0-9]{32}$/);
const target=new URL(localDatabase);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55439');assert.equal(target.pathname,'/adi_capacity');assert.equal(target.username,'adi_capacity');
const source=fixture.schema,destination='test_'+randomUUID().replaceAll('-',''),deadline=900000,db=capacityDatabase(destination,false,1);
const admin=new Client({connectionString:localDatabase,connectionTimeoutMillis:2000,statement_timeout:deadline,query_timeout:deadline+6000,options:`-c search_path=${destination},pg_catalog -c timezone=UTC`});
const quote=value=>{assert.match(value,/^[a-z][a-z0-9_]*$/);return '"'+value+'"';},relation=(schema,table)=>quote(schema)+'.'+quote(table);
const artifact=new URL('../.run/session-list-capacity/copy-fixture-'+Date.now()+'.json',import.meta.url),evidence={source_schema:source,destination_schema:destination,original_config_sha256:digest(originalBytes),started_at:new Date().toISOString(),synthetic:true,status:'preparing',stages:[],tables:[],maintenance_deadline_ms:deadline,scope:'New schema is normally migrated. Original columns are copied with constraints and triggers enabled; generated columns are computed natively. No old snapshot, entry, migration ledger or forged derived status is copied. All counts and full original-row SHA256 multiset digests are compared before config switches.'};
const save=()=>writeFile(artifact,JSON.stringify(evidence,null,2)+'\n');
const measure=async(name,operation)=>{const start=performance.now(),value=await operation();const stage={name,elapsed_ms:performance.now()-start};evidence.stages.push(stage);await save();console.log(JSON.stringify(stage));return value;};
try{
 const state=(await promisify(execFile)('docker',['compose','-f','deploy/product/compose.session-capacity.yml','ps','-a','--format','json'])).stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 evidence.source_services=state.filter(service=>['api','worker','collector'].includes(service.Service)).map(service=>({service:service.Service,state:service.State,status:service.Status}));assert.equal(evidence.source_services.length,3);assert.ok(evidence.source_services.every(service=>service.state==='exited'),'source applications must stop before copying');
 await measure('real_final_migrations',()=>db.migrate());await db.ensurePartitions(new Date(fixture.period.from),new Date(fixture.period.to));await admin.connect();await admin.query('SET jit=off');
 for(const table of ['capacity_fixture_people','capacity_fixture_sessions'])await admin.query(`CREATE TABLE ${relation(destination,table)} (LIKE ${relation(source,table)} INCLUDING ALL)`);
 const excluded=['pgmigrations','migration_checksums','session_list_snapshots','session_list_snapshot_entries'];
 const names=(await admin.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p') AND NOT c.relispartition ORDER BY c.relname",[destination])).rows.map(row=>row.name).filter(name=>!excluded.includes(name));
 const tables=new Map();
 for(const table of names){
  const columns=(await admin.query("SELECT a.attname AS name,a.attidentity AS identity FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum",[destination+'.'+table])).rows;
  const count=Number((await admin.query(`SELECT count(*)::text AS n FROM ${relation(source,table)}`)).rows[0].n);assert.ok(Number.isSafeInteger(count));tables.set(table,{table,columns,count});
 }
 await admin.query('TRUNCATE '+names.map(name=>relation(destination,name)).join(',')+' RESTART IDENTITY CASCADE');
 const definitions={};for(const index of ['hook_prompt_trgm','hook_prompt_search_trgm']){definitions[index]=(await admin.query('SELECT pg_get_indexdef(to_regclass($1)) AS definition',[destination+'.'+index])).rows[0].definition.replace(/\bON ONLY\b/,'ON');await admin.query(`DROP INDEX ${relation(destination,index)}`);}
 const edges=(await admin.query("SELECT t.relname AS child,p.relname AS parent FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class p ON p.oid=k.confrelid WHERE n.nspname=$1 AND k.contype='f' AND NOT t.relispartition",[destination])).rows;
 const remaining=new Set([...tables.values()].filter(t=>t.count>0).map(t=>t.table)),ordered=[];
 while(remaining.size){const ready=[...remaining].filter(name=>!edges.some(edge=>edge.child===name&&edge.parent!==name&&remaining.has(edge.parent)));assert.ok(ready.length,'non-empty cyclic facts require an explicit reviewed copy order');for(const name of ready){remaining.delete(name);ordered.push(name);}}
 for(const name of ordered){const t=tables.get(name),cols=t.columns.map(c=>quote(c.name)).join(','),override=t.columns.some(c=>c.identity==='a')?' OVERRIDING SYSTEM VALUE':'';const start=performance.now();const copied=await admin.query(`INSERT INTO ${relation(destination,name)} (${cols})${override} SELECT ${cols} FROM ${relation(source,name)}`);assert.equal(copied.rowCount,t.count);evidence.tables.push({name,source_rows:t.count,copied_rows:copied.rowCount,copy_ms:performance.now()-start,columns:t.columns.map(c=>c.name),generated_columns_excluded:true});await save();console.log(JSON.stringify({stage:'copied_table',table:name,rows:t.count,elapsed_ms:evidence.tables.at(-1).copy_ms}));}
 const rowDigest=async(schema,t)=>{const columns=t.columns.map(c=>quote(c.name)).join(',');return (await admin.query(`SELECT encode(sha256(convert_to(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS digest FROM (SELECT encode(sha256(convert_to(jsonb_build_array(${columns})::text,'UTF8')),'hex') AS row_hash FROM ${relation(schema,t.table)}) rows`)).rows[0].digest;};
 for(const t of tables.values()){
  const actual=Number((await admin.query(`SELECT count(*)::text AS n FROM ${relation(destination,t.table)}`)).rows[0].n);assert.equal(actual,t.count,'every factual table count must be preserved');
  const start=performance.now(),sourceDigest=await rowDigest(source,t),destinationDigest=await rowDigest(destination,t);assert.equal(destinationDigest,sourceDigest,'all original column values including UUID/microseconds/full payload must match');
  const checked={name:t.table,source_rows:t.count,destination_rows:actual,original_row_sha256:sourceDigest,verified_ms:performance.now()-start,columns:t.columns.map(c=>c.name)};const prior=evidence.tables.find(table=>table.name===t.table);if(prior)Object.assign(prior,checked);else evidence.tables.push(checked);await save();
 }
 const generated=(await admin.query(`SELECT count(*) FILTER(WHERE prompt_search IS DISTINCT FROM CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END)::int AS invalid FROM ${relation(destination,'hook_events')}`)).rows[0];assert.equal(generated.invalid,0);evidence.generated_values=generated;
 const indexes={};for(const index of ['hook_prompt_trgm','hook_prompt_search_trgm']){const start=performance.now();await measure('build_'+index,()=>admin.query(definitions[index]));indexes[index]=await verifyCapacityPromptIndex(destination,{indexName:index,expectedExpression:index==='hook_prompt_trgm'?"(payload ->> 'prompt'::text)":null,expectedColumn:index==='hook_prompt_search_trgm'?'prompt_search':null,expectedDefinition:definitions[index],elapsedMs:performance.now()-start});}
 for(const name of names)await admin.query(`ANALYZE ${relation(destination,name)}`);
 evidence.storage=(await admin.query(`SELECT sum(octet_length(prompt_search))::text AS normalized_text_logical_bytes,sum(pg_column_size(prompt_search))::text AS normalized_stored_value_bytes FROM ${relation(destination,'hook_events')} WHERE event_type='UserPromptSubmit'`)).rows[0];
 evidence.storage.hook_events_total_bytes=(await admin.query('SELECT sum(pg_total_relation_size(relid))::text AS n FROM pg_partition_tree($1::regclass) WHERE isleaf',[destination+'.hook_events'])).rows[0].n;
 evidence.storage.raw_prompt_index_bytes=indexes.hook_prompt_trgm.bytes;evidence.storage.normalized_prompt_index_bytes=indexes.hook_prompt_search_trgm.bytes;
 evidence.storage.scope='Exact current physical index bytes, stored-value bytes and table total. Original full-table pre-projection physical baseline was not captured, so no fabricated net physical increment.';
 const migrations=(await admin.query(`SELECT m.name,c.checksum FROM ${relation(destination,'pgmigrations')} m JOIN ${relation(destination,'migration_checksums')} c ON c.name=m.name ORDER BY m.id`)).rows;evidence.migrations=migrations;
 const {normalized_prompt_setup,rejected_literal_prompt_indexes,release_fixture_copy:_previousCopy,...seedSetup}=fixture.seed_setup;void _previousCopy;
 const next={...fixture,version:8,schema:destination,seed_setup:{...seedSetup,source_experimental_setup_history:{schema:source,normalized_prompt_setup,rejected_literal_prompt_indexes},prompt_index:indexes.hook_prompt_trgm,normalized_prompt_index:indexes.hook_prompt_search_trgm,release_fixture_copy:{artifact:artifact.pathname,source_schema:source,destination_schema:destination,tables:evidence.tables,generated_values:evidence.generated_values,storage:evidence.storage,migrations,stages:evidence.stages}}};
 evidence.status='complete';evidence.finished_at=new Date().toISOString();await save();
 await writeFile(new URL('config-experimental-'+source+'.json',configPath),originalBytes,{mode:0o600});await writeFile(configPath.pathname+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});await rename(configPath.pathname+'.tmp',configPath);
 console.log(JSON.stringify({stage:'final_fixture_ready',schema:destination,artifact:artifact.pathname,config_sha256:digest(await readFile(configPath)),storage:evidence.storage}));
}catch(error){evidence.status='failed';evidence.error={code:error.code??error.name,message:error.message};await save();throw error;}finally{await admin.end().catch(()=>{});await db.close();}
