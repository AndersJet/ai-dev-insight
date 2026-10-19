import {loadEnvironment} from './lib/environment.mjs';
import {openDatabase} from '../packages/storage/dist/index.js';
const tables=['data_identity','users','departments','membership_periods','project_streams','project_observations','project_hook_links','sessions','hook_events','cleanup_tombstones','repository_allowlist','plugin_project_observations'];
const env=loadEnvironment();
if(!env.ADI_DATABASE_URL)throw new Error('database_configuration_required');
const db=openDatabase({connectionString:env.ADI_DATABASE_URL,schema:env.ADI_DATABASE_SCHEMA,maxConnections:1});
try{
  await db.assertNotRecovering();
  const existing=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p') AND c.relname=ANY($2::text[])",[db.schema,tables])).rows.map(row=>row.relname);
  if(tables.some(table=>!existing.includes(table)))throw new Error('project_tracking_schema_incomplete');
  for(const table of tables)await db.query(`ANALYZE "${db.schema}"."${table}"`);
  const estimates=(await db.query("SELECT c.relname AS table_name,c.reltuples::bigint::text AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname",[db.schema,tables])).rows;
  console.log(JSON.stringify({event:'project_tracking_statistics_refreshed',schema:db.schema,tables:estimates}));
}catch(error){
  console.error(JSON.stringify({event:'project_tracking_statistics_failed',code:error.code??(['project_tracking_schema_incomplete','recovery_quarantined'].includes(error.message)?error.message:'statistics_refresh_failed')}));
  process.exitCode=1;
}finally{await db.close();}
