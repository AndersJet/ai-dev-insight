import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createUsageAttributionJobs} from '../../src/usage-attribution-jobs.js';
import {createTraeUsageProvider} from '../../src/usage-provider.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';

test('a long Hook session yields between source requests instead of occupying one whole usage-worker turn',async t=>{
 const f=await stopUsageFixture(t);
 for(let i=1;i<1000;i++){
  const time=new Date(f.stop.getTime()-i*1000);
  await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'batch-history-'+i,source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:time.toISOString(),payload:{last_assistant_message:'合成长会话'}},{admissionEpoch:1,receivedAt:f.at});
 }
 const id=await f.jobs.enqueue(f.session);
 await f.jobs.runOne();
 assert.ok(f.requests.filter(r=>!r.path.endsWith('/auth/token')).length<=1,'one turn must issue at most one source request');
 assert.equal((await f.jobs.status(id)).status,'queued');
 assert.deepEqual((await f.read()).groups,[],'an unfinished round must not publish a partial quantity');
 const restarted=createUsageAttributionJobs(f.db,{providerAccount:'stop-test',provider:f.provider});
 for(let turns=0;turns<1100&&(await restarted.status(id)).status==='queued';turns++){
  const before=f.requests.filter(r=>!r.path.endsWith('/auth/token')).length;
  await restarted.runOne();
  assert.ok(f.requests.filter(r=>!r.path.endsWith('/auth/token')).length-before<=1);
 }
 assert.equal((await restarted.status(id)).status,'succeeded');
 assert.equal(f.requests.filter(r=>r.path.endsWith('user_usage_detail')).length,1000,'all Stop windows must be processed, including after a worker restart');
 assert.equal((await f.read()).groups[0]?.tokens,'176004','the bill shared by all windows is counted once');
});

test('member pagination survives restart and a candidate on the last page prevents premature attribution',async t=>{
 const f=await stopUsageFixture(t);const seen:number[]=[];let billQueries=0;
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  res.setHeader('Content-Type','application/json');
  if(req.url?.endsWith('/auth/token')){res.end(JSON.stringify({code:0,data:{access_token:'pagination-synthetic',expire:7200}}));return;}
  const member=req.url?.endsWith('user_usage_detail');
  if(member)seen.push(body.page);else if(body.session_ids[0]!=='synthetic-hook')billQueries++;
  const row=(id:string)=>({session_id:id,user_id:'external-owner',start_time:body.start_time+1,scene:'Chat',client:'ide',model_source:'Trae',model_name:'Synthetic',model_type:'Chat',consumption_source:'basic',model_call_count:1,usage:{prompt_tokens:10,completion_tokens:0,total_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0},total_cost:'0.000000',total_cost_currency:'CNY'});
  res.end(JSON.stringify({code:0,data:{items:member?(body.page===1?Array.from({length:200},()=>row('bill-a')):[row('bill-b')]):[],...(member?{pagination:{page:body.page,page_size:200,total:201,total_pages:2}}:{})}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const provider=createTraeUsageProvider({baseUrl:`http://127.0.0.1:${address.port}`,appId:'synthetic',appSecret:'synthetic'});
 let jobs=createUsageAttributionJobs(f.db,{providerAccount:'stop-test',provider});const id=await jobs.enqueue(f.session);
 await jobs.runOne();await jobs.runOne();assert.equal((await jobs.status(id)).status,'queued');assert.deepEqual((await f.read()).groups,[]);
 jobs=createUsageAttributionJobs(f.db,{providerAccount:'stop-test',provider});await jobs.runOne();
 assert.equal((await jobs.status(id)).status,'succeeded');assert.deepEqual(seen,[1,2]);assert.equal(billQueries,0);
 const result=await f.read();assert.equal(result.session_query?.state,'pending');assert.ok(result.session_query?.reasons.includes('multiple_candidates'));
});

test('a new Stop resumes completed windows while a later periodic refresh replaces revised quantities',async t=>{
 const f=await stopUsageFixture(t),earlier=new Date(f.stop.getTime()-20000);
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'batch-earlier-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:earlier.toISOString(),payload:{last_assistant_message:'较早轮次'}},{admissionEpoch:1,receivedAt:f.at});
 const id=await f.jobs.enqueue(f.session);
 await f.jobs.runOne();await f.jobs.runOne();await f.jobs.runOne(); // One complete window and its quantity, with another window pending.
 assert.deepEqual((await f.read()).groups,[]);
 const oldFrom=Math.floor(f.stop.getTime()/1000)-1,newAt=new Date(),newFrom=Math.floor(newAt.getTime()/1000)-1;
 await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'batch-new-stop',source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:newAt.toISOString(),payload:{last_assistant_message:'新增轮次'}},{admissionEpoch:1,receivedAt:newAt});
 const restarted=createUsageAttributionJobs(f.db,{providerAccount:'stop-test',provider:f.provider});
 for(let n=0;n<10&&(await restarted.status(id)).status!=='succeeded';n++)await restarted.runOne();
 assert.equal((await restarted.status(id)).status,'succeeded');
 const froms=f.requests.filter(r=>r.path.endsWith('user_usage_detail')).map(r=>r.body.start_time);
 assert.deepEqual(froms,[Math.floor(earlier.getTime()/1000)-1,oldFrom,newFrom],'completed windows are not requested again within the same unfinished round');
 assert.equal((await f.read()).groups[0]?.tokens,'176004');
 f.control.tokens=200000;await f.run();assert.equal((await f.read()).groups[0]?.tokens,'200000');
 f.control.windows.set(oldFrom,['official-bill','late-bill']);await f.run();assert.ok((await f.read()).session_query?.reasons.includes('multiple_candidates'),'a subsequent round must recheck old windows for late candidates');
});

test('a cooled recurring job removes its unfinished query evidence when it leaves the recent discovery window',async t=>{
 const f=await stopUsageFixture(t);await f.jobs.discoverRecent();const id=await f.jobs.enqueue(f.session);await f.jobs.runOne();
 // Physical erasure is checked at the public storage boundary: HTTP intentionally never exposes private job progress.
 const progress=()=>f.db.query<{progress:unknown}>('SELECT progress FROM jobs WHERE id=$1',[id]);
 assert.notDeepEqual((await progress()).rows[0]?.progress,{});
 const later=new Date(f.at.getTime()+46*86400000),cooled=createUsageAttributionJobs(f.db,{providerAccount:'stop-test',provider:f.provider,clock:()=>later});
 const requests=f.requests.length;await cooled.runOne();assert.equal((await cooled.status(id)).status,'succeeded');assert.equal(f.requests.length,requests);
 assert.deepEqual((await progress()).rows[0]?.progress,{});
});
