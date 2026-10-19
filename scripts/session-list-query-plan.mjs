import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {capacityDatabase} from './session-list-capacity-fixture.mjs';
import {createIdentityService,createSessionReadService} from '../packages/domain/dist/index.js';

const directory=new URL('../.run/session-list-capacity/',import.meta.url);
const fixture=JSON.parse(await readFile(new URL('config.json',directory),'utf8'));
const scope=process.argv[2]??'mine-normal',channel=process.argv[3]??'all';
if(!['mine-normal','mine-heavy','super-all','super-department'].includes(scope))throw new Error('Unknown synthetic scope');
const db=capacityDatabase(fixture.schema),timings=[],statements=[];
function observe(target){return new Proxy(target,{get(object,key,receiver){
 if(key==='query')return async(sql,values)=>{
  const kind=sql.startsWith('WITH visible AS MATERIALIZED')?'list':sql.startsWith('SELECT md5(jsonb_build_object(')?'revision':sql.startsWith('SELECT COALESCE(sum(cleanup_generation)')?'cleanup':'identity';
  if(['list','revision'].includes(kind))statements.push({kind,sql,values});
  const start=performance.now();let result;
  try{result=await object.query(sql,values);return result;}finally{timings.push({kind,ms:performance.now()-start,rows:result?.rows.length});}
 };
 if(key==='transaction')return action=>object.transaction(client=>action(observe(client)));
 return Reflect.get(object,key,receiver);
}});}
try{
 const traced=observe(db),identity=createIdentityService(traced,{emailDomains:['example.invalid']});
 const reader=createSessionReadService(traced,identity,{providerAccount:fixture.provider_account,stopWindowEnabled:true});
 const token=scope==='mine-normal'?fixture.own_token:scope==='mine-heavy'?fixture.heavy_token:fixture.admin_token;
 const query={...fixture.period,channel,limit:20,...(scope==='super-department'?{department_id:fixture.departments[0].id}:{})};
 const start=performance.now();let result,error;
 try{result=scope.startsWith('mine')?await reader.listMine(token,query):await reader.listAll(token,query);}catch(reason){error={code:reason.code??reason.name,message:reason.message};}
 const elapsed=performance.now()-start,plans=[];
 for(const statement of statements){
  try{
   const raw=await db.transaction(async client=>{await client.query('SET TRANSACTION READ ONLY');if(statement.kind==='list')await client.query('SET LOCAL jit=off');return client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement.sql,statement.values);});
   const plan=raw.rows[0]['QUERY PLAN'][0],nodes=[];
   function walk(node){if(node['Subplan Name']||node['Relation Name'])nodes.push({name:node['Subplan Name'],relation:node['Relation Name'],type:node['Node Type'],estimated_rows:node['Plan Rows'],actual_rows:node['Actual Rows'],loops:node['Actual Loops'],actual_ms:node['Actual Total Time'],cost:node['Total Cost']});for(const child of node.Plans??[])walk(child);}
   walk(plan.Plan);plans.push({kind:statement.kind,planning_ms:plan['Planning Time'],execution_ms:plan['Execution Time'],jit:plan.JIT,nodes,plan});
  }catch(reason){
   const estimated=(await db.query('EXPLAIN (FORMAT JSON) '+statement.sql,statement.values)).rows[0]['QUERY PLAN'][0];
   plans.push({kind:statement.kind,error:reason.code??reason.name,message:reason.message,estimated_plan:estimated});
  }
 }
 const report={synthetic:true,scope,channel,at:new Date().toISOString(),fixture:fixture.actual,elapsed_ms:elapsed,result:result?{total:result.total,items:result.items.length}:undefined,error,timings,plans};
 const destination=new URL('plan-'+scope+'-'+channel+'-'+Date.now()+'.json',directory);await writeFile(destination,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,artifact:destination.pathname,plans:plans.map(p=>({...p,plan:undefined,nodes:p.nodes?.filter(n=>n.actual_ms>1||n.name)}))}));
 if(error)process.exitCode=1;
}finally{await db.close();}
