import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import process from 'node:process';
import {URL} from 'node:url';
import {openDatabase} from '../../packages/storage/dist/index.js';
import {environment,e2eArtifact} from '../../apps/web/e2e/helpers/environment.mjs';

test('twenty D detail pages include first prompt and response content in the measured loading chain',async({browser,page})=>{
 const url=process.env.ADI_TEST_DATABASE_URL??'postgres://adi_test:adi_test_local_only@127.0.0.1:55438/adi_test';
 const target=new URL(url);
 if(!['localhost','127.0.0.1'].includes(target.hostname)||target.port!=='55438'||target.username!=='adi_test'||target.pathname!=='/adi_test'||target.search||target.hash)throw new Error('Local synthetic database required');
 const db=openDatabase({connectionString:url,schema:environment.schema}),run=randomUUID(),accounts=Array.from({length:500},(_,i)=>({user:randomUUID(),installation:randomUUID(),session:randomUUID(),index:i,marker:`DETAIL_CAPACITY_${run}_${String(i).padStart(4,'0')}`}));
 const contexts=[],runtimeErrors=[],rounds=[],requests=[];let measured=false;
 const report={run,status:'running',pass:false,rounds,negative_controls:[],runtime_errors:runtimeErrors};
 const reportPath=new URL('../../.run/detail-capacity.json',import.meta.url);
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 try{
  if(Number((await db.query("SELECT count(*)::int AS n FROM users WHERE email_key LIKE 'detail-%@example.invalid'")).rows[0].n)!==0)throw new Error('Run pnpm capacity:detail to reset the owned E2E schema before every benchmark');
  const now=new Date(),start=new Date(now.getTime()-6*86400000);await db.ensurePartitions(start,new Date(now.getTime()+86400000));
  await db.transaction(async client=>{
   await client.query("INSERT INTO users(id,email_key,display_name) SELECT (x->>'user')::uuid,'detail-'||(x->>'user')||'@example.invalid','合成详情人员' FROM jsonb_array_elements($1::jsonb) x",[JSON.stringify(accounts)]);
   await client.query("INSERT INTO installations(id,user_id,token_hash,label) SELECT (x->>'installation')::uuid,(x->>'user')::uuid,encode(sha256(convert_to(x->>'installation','UTF8')),'hex'),'合成详情安装' FROM jsonb_array_elements($1::jsonb) x",[JSON.stringify(accounts)]);
   await client.query("INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) SELECT (x->>'session')::uuid,(x->>'user')::uuid,x->>'marker',$2::timestamptz-(((x->>'index')::int%5)+1)*interval '1 day',$2::timestamptz-(((x->>'index')::int%5)+1)*interval '1 day'+interval '19 seconds' FROM jsonb_array_elements($1::jsonb) x",[JSON.stringify(accounts),now]);
   await client.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,installation_id,session_id,event_type,payload)
    SELECT gen_random_uuid(),s.first_at+g*interval '1 second',$2,s.user_id,i.id,s.id,
     CASE g%4 WHEN 0 THEN 'UserPromptSubmit' WHEN 1 THEN 'PreToolUse' WHEN 2 THEN 'PostToolUse' ELSE 'Stop' END,
     CASE g%4 WHEN 0 THEN jsonb_build_object('prompt','DETAIL_PROMPT_'||s.source_session_id||' '||repeat('p',4096))
      WHEN 1 THEN jsonb_build_object('tool_use_id','tool-'||g/4,'tool_name','ReadFile','tool_input',jsonb_build_object('path','synthetic.ts','text',repeat('i',2048)))
      WHEN 2 THEN jsonb_build_object('tool_use_id','tool-'||g/4,'tool_name','ReadFile','tool_response',jsonb_build_object('text',repeat('o',2048)))
      ELSE jsonb_build_object('last_assistant_message','# DETAIL_ANSWER_'||s.source_session_id||E'\n\n'||repeat('a',16384)) END
    FROM sessions s JOIN installations i ON i.user_id=s.user_id CROSS JOIN generate_series(0,19) g WHERE s.id=ANY($1::uuid[])`,[accounts.map(a=>a.session),now]);
   await client.query("INSERT INTO jobs(id,kind,dedupe_key,payload) SELECT gen_random_uuid(),'derive_session','derive:'||id::text,jsonb_build_object('session_id',id) FROM sessions WHERE id=ANY($1::uuid[])",[accounts.map(a=>a.session)]);
  });
  report.fixture_observed=(await db.query(`SELECT count(*)::int AS events,count(DISTINCT user_id)::int AS people,count(DISTINCT session_id)::int AS sessions,
   percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP(ORDER BY octet_length(payload::text)) AS payload_json_bytes_p50_p95_p99,
   max(octet_length(payload::text)) AS payload_json_bytes_max FROM hook_events WHERE session_id=ANY($1::uuid[])`,[accounts.map(a=>a.session)])).rows[0];
  expect(report.fixture_observed.events).toBe(10000);expect(report.fixture_observed.people).toBe(500);expect(report.fixture_observed.sessions).toBe(500);
  const fixture=JSON.parse(await readFile(e2eArtifact('e2e-credentials.json'),'utf8'));
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('navigation',{name:'一级导航'})).toBeVisible();
  const state=await page.context().storageState();
  const pages=[];
  for(let i=0;i<20;i++){
   const context=await browser.newContext({storageState:state,baseURL:environment.webURL});contexts.push(context);const client=await context.newPage();pages.push(client);
   client.on('pageerror',error=>runtimeErrors.push(error.message));
   client.on('response',response=>{if(measured&&new URL(response.url()).pathname.startsWith('/api/v1/sessions/'))requests.push({client:i,path:new URL(response.url()).pathname,status:response.status()});});
  }
  const prepare=async()=>{for(const [i,client] of pages.entries()){await client.goto('/all/sessions?search='+encodeURIComponent(accounts[i].marker)+'&from='+encodeURIComponent(start.toISOString())+'&to='+encodeURIComponent(now.toISOString()));await expect(client.getByRole('row').filter({hasText:accounts[i].marker})).toHaveCount(1,{timeout:15000});await expect(client.getByRole('button',{name:'查看详情',exact:true})).toBeVisible();}};
  // Derivation is deliberately completed before reading. This benchmark is not
  // the separate 2000-Hook/jobs mixed-workload gate.
  await expect.poll(async()=>Number((await db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='derive_session' AND payload->>'session_id'=ANY($1::text[]) AND status<>'succeeded'",[accounts.map(a=>a.session)])).rows[0].n),{timeout:60000}).toBe(0);
  const observe=async(client,marker)=>client.evaluate(marker=>new Promise((resolve,reject)=>{
   const started=globalThis.performance.now(),startedAt=Date.now();let complete=false;
   const timeout=globalThis.setTimeout(()=>{observer.disconnect();reject(new Error('First detail content was not rendered within 15 seconds'));},15000);
   const inspect=()=>{
    const trace=globalThis.document.querySelector('[data-testid="session-trace"]');
    if(complete||!trace?.textContent?.includes('DETAIL_PROMPT_'+marker)||!trace.textContent.includes('DETAIL_ANSWER_'+marker)||trace.querySelector('[role="status"],[role="alert"]'))return;
    complete=true;observer.disconnect();globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(()=>{globalThis.clearTimeout(timeout);resolve({elapsed_ms:globalThis.performance.now()-started,started_at_ms:startedAt,finished_at_ms:Date.now()});}));
   };
   const observer=new globalThis.MutationObserver(inspect);observer.observe(globalThis.document.body,{subtree:true,childList:true,characterData:true});
   const button=[...globalThis.document.querySelectorAll('button')].find(node=>node.textContent.trim()==='查看详情');if(!button){globalThis.clearTimeout(timeout);observer.disconnect();reject(new Error('Visible detail action missing'));return;}button.click();inspect();
  }),marker);
  await prepare();
  // Negative control: a successful but delayed content response must appear in
  // the measurement, even though the heading and detail metadata arrive first.
  for(const part of ['prompt','response']){
   if(part==='response')await prepare();
   await pages[0].route('**/api/v1/sessions/*/events/*/content?*',async route=>{if(new URL(route.request().url()).searchParams.get('part')===part)await delay(2500);await route.continue();});
   const negative=await observe(pages[0],accounts[0].marker);report.negative_controls.push({part,...negative});expect(negative.elapsed_ms).toBeGreaterThanOrEqual(2500);await pages[0].unrouteAll({behavior:'wait'});
  }
  for(let round=1;round<=3;round++){
   await prepare();measured=true;const observations=await Promise.allSettled(pages.map((client,i)=>observe(client,accounts[i].marker)));measured=false;
   const failures=observations.flatMap((x,client)=>x.status==='rejected'?[{client,error:String(x.reason?.message??'observation_failed')}]:[]);
   if(failures.length){rounds.push({round,clients:20,failures,observations:observations.map((x,client)=>({client,...(x.status==='fulfilled'?x.value:{error:String(x.reason?.message??'observation_failed')})}))});throw new Error('Detail observation failed');}
   const samples=observations.map(x=>x.value);
   for(const client of pages)await expect(client.getByRole('complementary',{name:'当前工作区菜单'})).toBeVisible();
   const sorted=samples.map(x=>x.elapsed_ms).sort((a,b)=>a-b);rounds.push({round,clients:20,samples,p95_ms:sorted[18],p99_ms:sorted[19],start_span_ms:Math.max(...samples.map(x=>x.started_at_ms))-Math.min(...samples.map(x=>x.started_at_ms)),all_windows_overlap:Math.max(...samples.map(x=>x.started_at_ms))<Math.min(...samples.map(x=>x.finished_at_ms))});
  }
  Object.assign(report,{status:'completed',scope:'compiled D UI, twenty browser contexts sharing one synthetic super-admin, twenty distinct sessions, first prompt and response rendered after two frames',fixture:{synthetic_accounts:500,sessions:500,events:10000,days:5,events_per_session:20,event_types:['UserPromptSubmit','PreToolUse','PostToolUse','Stop'],prompt_chars:4096,response_chars:16384,tool_text_chars:2048},rounds,http_requests:requests.length,http_errors:requests.filter(r=>r.status>=400),runtime_errors:runtimeErrors,budget_ms:2000,pass:rounds.every(r=>r.p95_ms<=2000&&r.all_windows_overlap)&&requests.every(r=>r.status<400)&&runtimeErrors.length===0,limitations:['API/browser are not CPU-constrained; PostgreSQL uses the existing local test quota and tmpfs.','No TLS, 2000 Hook burst, simultaneous background derivation, or representative real payload distribution.','One authenticated actor across contexts; not twenty distinct users.']});
  expect(report.pass,JSON.stringify(rounds.map(({round,p95_ms,start_span_ms,all_windows_overlap})=>({round,p95_ms,start_span_ms,all_windows_overlap})))).toBe(true);
 }catch(error){report.pass=false;report.status='failed';report.error=String(error.message);throw error;}finally{
  measured=false;report.http_requests=requests.length;report.http_errors=requests.filter(r=>r.status>=400);
  await Promise.allSettled(contexts.map(context=>context.close()));
  try{await db.close();}finally{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
 }
});
