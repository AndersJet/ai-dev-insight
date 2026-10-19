import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {URL} from 'node:url';
import console from 'node:console';
import process from 'node:process';
import {connectionString,testDatabase} from '../packages/storage/test/helpers.ts';
import {createIdentityService,createProjectInventoryService} from '../packages/domain/dist/index.js';

// pnpm --filter @adi/domain... build && node --import tsx scripts/project-query-plan.mjs
// This tool cannot use the application .env or a company database. Its only
// writes are synthetic fixtures in a fresh owned test_ schema and this report.
const target=new URL(connectionString);
if(!['127.0.0.1','localhost'].includes(target.hostname)||target.port!=='55438'||target.pathname!=='/adi_test'||target.username!=='adi_test'||target.search||target.hash)throw new Error('Project plan requires the isolated local adi_test database at port 55438');
const scenarios=[{name:'small',projects:2,events:8},{name:'medium',projects:100,events:1000},{name:'large',projects:1000,events:10000}];
const analyzedTables=['users','departments','membership_periods','installations','sessions','hook_events','project_streams','project_observations','project_hook_links','cleanup_tombstones','repository_allowlist','data_identity'];
const samples=5,hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,median_ms:sorted[Math.floor(sorted.length/2)],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],min_ms:sorted[0],max_ms:sorted.at(-1)};};

async function seed(db,actor,now,scenario){
  const eventsPerProject=scenario.events/scenario.projects;assert.ok(Number.isInteger(eventsPerProject)&&eventsPerProject>=4);
  const at=new Date(now.getTime()-86400000),departmentIds=[randomUUID(),randomUUID()],people=Math.min(scenario.projects,100);
  await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(now.getTime()+86400000));
  await db.query("INSERT INTO departments(id,name) SELECT x.id,'Synthetic plan department '||x.n FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)",[departmentIds]);
  const additional=(await db.query("INSERT INTO users(id,email_key,display_name) SELECT gen_random_uuid(),'project-plan-'||g||'@example.invalid','Synthetic project member '||g FROM generate_series(1,$1::int) g RETURNING id",[people-1])).rows;
  const owners=[actor.user.user_id,...additional.map(row=>row.id)].map((user_id,i)=>({user_id,installation_id:randomUUID(),collector_id:randomUUID(),department_id:departmentIds[i%2]}));
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) SELECT x.installation_id,x.user_id,md5(x.user_id::text)||md5(x.user_id::text),'Synthetic plan installation' FROM jsonb_to_recordset($1::jsonb) x(user_id uuid,installation_id uuid)",[JSON.stringify(owners)]);
  await db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) SELECT x.user_id,x.department_id,$2::timestamptz-interval '7 days' FROM jsonb_to_recordset($1::jsonb) x(user_id uuid,department_id uuid)",[JSON.stringify(owners),at]);
  const projects=Array.from({length:scenario.projects},(_,i)=>{
    const workspace='/synthetic/project-plan-'+String(i+1).padStart(6,'0');
    return {n:i+1,id:randomUUID(),observation_id:randomUUID(),session_one:randomUUID(),session_two:randomUUID(),workspace,workspace_key:hash(['macos',workspace]),...owners[i%owners.length]};
  });
  await db.transaction(async sql=>{
    await sql.query(`CREATE TEMP TABLE project_plan_projects ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb)
      x(n int,id uuid,observation_id uuid,session_one uuid,session_two uuid,workspace text,workspace_key text,user_id uuid,installation_id uuid,collector_id uuid,department_id uuid)`,[JSON.stringify(projects)]);
    await sql.query(`CREATE TEMP TABLE project_plan_events ON COMMIT DROP AS
      SELECT p.*,g.ordinal,gen_random_uuid() AS event_id,
        CASE WHEN g.ordinal%2=1 THEN p.session_one ELSE p.session_two END AS session_id,
        $2::timestamptz+((p.n-1)*$1::int+g.ordinal)*interval '1 millisecond' AS occurred_at
      FROM project_plan_projects p CROSS JOIN generate_series(1,$1::int) g(ordinal)`,[eventsPerProject,at]);
    await sql.query(`INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at)
      SELECT session_id,user_id,'synthetic-plan-session-'||session_id::text,min(occurred_at),max(occurred_at)
      FROM project_plan_events GROUP BY session_id,user_id`);
    await sql.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload)
      SELECT event_id,occurred_at,$1,user_id,department_id,installation_id,session_id,'UserPromptSubmit','{}'::jsonb FROM project_plan_events`,[now]);
    await sql.query(`INSERT INTO project_streams(id,user_id,collector_id,workspace_key,latest_sequence,confirmed_sequence)
      SELECT id,user_id,collector_id,workspace_key,n,n FROM project_plan_projects`);
    await sql.query(`INSERT INTO project_observations(user_id,collector_id,id,sequence,project_id,observed_at,received_at,source_event_id,source_event_at,source_session_id,cleanup_generation,payload_hash,state,evidence)
      SELECT user_id,collector_id,observation_id,n,id,occurred_at,$1,event_id,occurred_at,session_id,0,md5(id::text)||md5(id::text),'repository',
        jsonb_build_object('workspace',workspace,'platform','macos','git_root',workspace,'reason',NULL,
          'remotes',jsonb_build_array(jsonb_build_object('name','origin','direction','fetch','address','https://git.example.invalid/team/project-'||n||'.git')))
      FROM project_plan_events WHERE ordinal=1`,[now]);
    // One of each project's actual Hook events is deliberately unresolved.
    await sql.query(`INSERT INTO project_hook_links(event_id,occurred_at,user_id,collector_id,project_id,session_id,unresolved_reason)
      SELECT event_id,occurred_at,user_id,collector_id,CASE WHEN ordinal=$1 THEN NULL ELSE id END,session_id,
        CASE WHEN ordinal=$1 THEN 'probe_pending' ELSE NULL END FROM project_plan_events`,[eventsPerProject]);
  });
  await db.query("INSERT INTO repository_allowlist(kind,value,value_hash,created_by) VALUES('host','git.example.invalid',$1,$2)",[createHash('sha256').update('git.example.invalid').digest('hex'),actor.user.user_id]);
  const integrity=(await db.query(`SELECT
    (SELECT count(*)::int FROM project_hook_links k LEFT JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at AND e.user_id=k.user_id
      LEFT JOIN sessions s ON s.id=k.session_id AND s.user_id=k.user_id LEFT JOIN project_streams p ON p.id=k.project_id AND p.user_id=k.user_id AND p.collector_id=k.collector_id
      WHERE e.id IS NULL OR s.id IS NULL OR (k.project_id IS NOT NULL AND p.id IS NULL)) AS broken_links,
    (SELECT count(*)::int FROM project_observations o LEFT JOIN hook_events e ON e.id=o.source_event_id AND e.occurred_at=o.source_event_at AND e.user_id=o.user_id AND e.session_id=o.source_session_id
      WHERE e.id IS NULL) AS broken_observations,
    (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM project_streams) AS projects,
    (SELECT count(*)::int FROM project_observations) AS observations,(SELECT count(*)::int FROM sessions) AS sessions,
    (SELECT count(*)::int FROM hook_events) AS events,(SELECT count(*)::int FROM project_hook_links WHERE project_id IS NULL) AS pending_hooks`)).rows[0];
  assert.equal(integrity.broken_links,0);assert.equal(integrity.broken_observations,0);assert.equal(integrity.projects,scenario.projects);assert.equal(integrity.events,scenario.events);
  for(const table of analyzedTables)await db.query(`ANALYZE ${table}`);
  return {integrity,departmentIds,projects};
}

function captureDatabase(db){
  let captured;
  const traced=new Proxy(db,{get(target,key){
    if(key!=='transaction')return Reflect.get(target,key);
    return action=>target.transaction(sql=>{
      let disabled=false;
      return action(new Proxy(sql,{get(client,property){
        if(property!=='query')return Reflect.get(client,property);
        return async(statement,values)=>{
          if(statement.startsWith('WITH eligible AS MATERIALIZED'))assert.ok(disabled,'Build the current service: its actual project transaction must disable JIT before reading');
          const result=await client.query(statement,values);
          if(statement==='SET LOCAL jit=off')disabled=true;
          if(statement.startsWith('WITH eligible AS MATERIALIZED'))captured={sql:statement,values,rows:result.rows};
          return result;
        };
      }}));
    });
  }});
  return {traced,latest:()=>captured};
}
async function replay(db,statement,jit,explain=false){
  return db.transaction(async sql=>{
    await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await sql.query(jit==='on'?'SET LOCAL jit=on':'SET LOCAL jit=off');
    return (await sql.query((explain?'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ':'')+statement.sql,statement.values)).rows;
  });
}
function planSummary(rows){
  const plan=rows[0]['QUERY PLAN'][0];
  return {planning_ms:plan['Planning Time'],execution_ms:plan['Execution Time'],estimated_cost:plan.Plan['Total Cost'],actual_rows:plan.Plan['Actual Rows'],jit_used:!!plan.JIT,jit_functions:plan.JIT?.Functions??0,jit_total_ms:plan.JIT?.Timing?.Total??0,jit_options:plan.JIT?.Options??null};
}
async function compare(db,statement){
  assert.ok(statement,'Real project list SQL must be captured');const digest=hash(statement.rows),timings={off:[],on:[]};
  // Warm both modes once, then alternate paired samples with identical SQL/parameters.
  for(const jit of ['off','on'])assert.equal(hash(await replay(db,statement,jit)),digest,'Warm JIT modes must return identical raw project rows');
  for(let n=0;n<samples;n++)for(const jit of n%2?['on','off']:['off','on']){
    const started=performance.now(),rows=await replay(db,statement,jit);timings[jit].push(performance.now()-started);
    assert.equal(hash(rows),digest,'JIT must preserve list rows, total and pending counts');
  }
  return {same_results:true,sql_sha256:hash(statement.sql),off:summary(timings.off),on:summary(timings.on),plans:{off:planSummary(await replay(db,statement,'off',true)),on:planSummary(await replay(db,statement,'on',true))}};
}
async function scenarioRun(scenario){
  const cleanup=[],db=await testDatabase({after:callback=>cleanup.push(callback)});
  try{
    await db.migrate();const now=new Date(),identity=createIdentityService(db,{emailDomains:['example.invalid']});
    const seedUser=await identity.bootstrap({email:'project-plan-root@example.invalid',name:'Synthetic project plan reader'}),initial=await identity.login('project-plan-root@example.invalid',seedUser.temporaryPassword);
    const actor=await identity.changePassword(initial.token,seedUser.temporaryPassword,'synthetic-project-plan-only-password');
    const fixture=await seed(db,actor,now,scenario),capture=captureDatabase(db),service=createProjectInventoryService(capture.traced,identity,{clock:()=>now});
    const first=await service.list(actor.token,{limit:20});assert.equal(first.total,scenario.projects);assert.equal(first.pending_hooks,scenario.projects);assert.ok(first.items.every(row=>row.session_count===2&&row.remotes[0].source_tag==='department'));
    const firstStatement=capture.latest(),baselineDigest=hash(first),serviceTimings=[];
    for(let n=0;n<samples;n++){const start=performance.now(),result=await service.list(actor.token,{limit:20});serviceTimings.push(performance.now()-start);assert.equal(hash(result),baselineDigest,'Repeated real service reads must preserve pagination and counts');}
    const firstComparison=await compare(db,firstStatement);
    let nextComparison=null;
    if(first.next_cursor){const next=await service.list(actor.token,{limit:20,cursor:first.next_cursor});assert.equal(next.total,scenario.projects);assert.equal(next.pending_hooks,scenario.projects);assert.ok(next.items.every(row=>!first.items.some(prior=>prior.id===row.id)));nextComparison=await compare(db,capture.latest());}
    // Traverse every page through the public service, checking exact completeness.
    const seen=new Set();let cursor;
    do{const result=await service.list(actor.token,{limit:100,...(cursor?{cursor}:{})});assert.equal(result.total,scenario.projects);for(const row of result.items){assert.ok(!seen.has(row.id),'A project cannot repeat between pages');seen.add(row.id);}cursor=result.next_cursor;}while(cursor);
    assert.equal(seen.size,scenario.projects);
    const scoped=await service.list(actor.token,{limit:20,department_id:fixture.departmentIds[0]});assert.equal(scoped.total,fixture.projects.filter(row=>row.department_id===fixture.departmentIds[0]).length);await compare(db,capture.latest());
    const searched=await service.list(actor.token,{limit:20,search:'/synthetic/project-plan-000001'});assert.equal(searched.total,1);await compare(db,capture.latest());
    let concurrent=null;
    if(scenario.name==='large'){
      const times=[],start=performance.now();await Promise.all(Array.from({length:20},async()=>{const began=performance.now(),result=await service.list(actor.token,{limit:20});times.push(performance.now()-began);assert.equal(hash(result),baselineDigest,'Every concurrent service response must remain correct');}));
      concurrent={reads:20,pool_max:6,completed:20,total_ms:performance.now()-start,...summary(times),scope:'Local database/service concurrency only; not production HTTP or collector mixed load'};
    }
    return {name:scenario.name,fixture:fixture.integrity,analyzed_tables:analyzedTables,service_off:summary(serviceTimings),first_page_sql:firstComparison,next_page_sql:nextComparison,pagination_projects:seen.size,department_and_search_equal:true,concurrent};
  }finally{for(const action of cleanup.reverse())await action();}
}

try{
  const results=[];for(const scenario of scenarios){const result=await scenarioRun(scenario);results.push(result);console.log(JSON.stringify({scenario:result.name,projects:result.fixture.projects,events:result.fixture.events,service_off:result.service_off,sql_off:result.first_page_sql.off,sql_on:result.first_page_sql.on,jit_on_used:result.first_page_sql.plans.on.jit_used,concurrent:result.concurrent}));}
  const report={completed:true,checked_at:new Date().toISOString(),database:'isolated adi_test, local 55438',scope:'Fresh owned synthetic schemas with explicit ANALYZE; fixed small JSON facts, not annual storage or production HTTP acceptance',jit_override:'Transaction-local only; no global setting or original application data changed',samples_per_mode:samples,results};
  await mkdir(new URL('../.run/',import.meta.url),{recursive:true});await writeFile(new URL('../.run/project-query-plan.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
}catch(error){console.error(JSON.stringify({completed:false,code:error?.code??error?.name??'project_plan_failed',message:error instanceof Error?error.message:'Project plan failed'}));process.exitCode=1;}
