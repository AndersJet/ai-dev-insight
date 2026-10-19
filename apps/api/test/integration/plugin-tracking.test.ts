import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pluginFixture} from '../plugin-fixture.js';
type Source=Awaited<ReturnType<Awaited<ReturnType<typeof pluginFixture>>['source']>>;
const event=(source:Source,sequence:string,workspace_path:string,extra:object={})=>({schema_version:2,collector_id:source.collector_id,nt_email:source.nt_email,source_config_id:source.source_config_id,observation_id:randomUUID(),sequence,platform:'macos',workspace_path,observed_at:'2024-01-01T00:00:00.000Z',state:'not_git',reason:null,git_root:null,remotes:[],plugin_version:'0.3.0',...extra});

test('retired project deletion cannot modify stored evidence; authenticated scope and CSRF remain enforced',async t=>{
  const {app,headers,source,bearer}=await pluginFixture(t),sender=await source(),payload=event(sender,'1','/synthetic/keep');
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:sender.uploadHeaders,payload})).statusCode,201);
  const before=(await app.inject({url:'/api/v1/plugin/projects',headers})).json().data;
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/plugin/projects',headers,payload:{}})).statusCode,410);
  assert.deepEqual((await app.inject({url:'/api/v1/plugin/projects',headers})).json().data,before);
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/plugin/projects',headers:bearer,payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/plugin/projects',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
});

test('source registration and reports do not create Hook installation/adoption, sessions, estimates, official usage or jobs',async t=>{
  const {app,headers,source,bearer}=await pluginFixture(t),sender=await source();
  const overviewUrl='/api/v1/analytics/overview?scope=organization',estimateUrl='/api/v1/analytics/content-estimate?scope=organization',usageUrl='/api/v1/analytics/official-usage?scope=organization';
  const before=(await app.inject({url:overviewUrl,headers})).json().data;
  const estimateBefore=(await app.inject({url:estimateUrl,headers})).json().data.estimate;
  const usageBefore=(await app.inject({url:usageUrl,headers})).json().data;
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:sender.uploadHeaders,payload:event(sender,'1','/synthetic/isolation')})).statusCode,201);
  assert.equal((await app.inject({url:'/api/v1/me/collection-credential',headers})).json().data.installation,null);
  assert.equal((await app.inject({url:'/api/v1/adoption?scope=self',headers})).json().data.adopted,0);
  assert.equal((await app.inject({url:'/api/v1/admin/sessions',headers})).json().data.total,0);
  const after=(await app.inject({url:overviewUrl,headers})).json().data;
  for(const key of ['observed_users','prompt_turns','sessions','tool_events','coverage_ratio'])assert.equal(after[key],before[key]);
  assert.deepEqual((await app.inject({url:estimateUrl,headers})).json().data.estimate,estimateBefore);
  const usage=(await app.inject({url:usageUrl,headers})).json().data;
  for(const key of ['configured','groups','coverage'])assert.deepEqual(usage[key],usageBefore[key]);
  assert.deepEqual((await app.inject({url:'/api/v1/system/health',headers})).json().data.jobs,[]);
  for(const url of ['/api/v1/me','/api/v1/plugin/projects','/api/v1/me/sessions'])assert.equal((await app.inject({url,headers:bearer})).statusCode,401);
});

test('history preserves decimal source sequence beyond JavaScript safe integer and source instances remain isolated',async t=>{
  const {app,headers,source}=await pluginFixture(t),first=await source(),second=await source();
  for(const sender of [first,second])assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:sender.uploadHeaders,payload:event(sender,'9007199254740993','/synthetic/same')})).statusCode,201);
  const projects=(await app.inject({url:'/api/v1/plugin/projects',headers})).json().data;
  assert.equal(projects.total,2);for(const item of projects.items)assert.equal(item.latest.sequence,'9007199254740993');
  const history=(await app.inject({url:'/api/v1/plugin/observations?'+new URLSearchParams({collector_id:first.collector_id,nt_email:first.nt_email,workspace_path:'/synthetic/same'}),headers})).json().data;assert.equal(history.total,1);
});

test('current repository evidence retains last confirmation on failures and clears it on explicit no-remote',async t=>{
  const {app,headers,source}=await pluginFixture(t),sender=await source();
  const send=async(sequence:string,state:string)=>app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:sender.uploadHeaders,payload:event(sender,sequence,'/synthetic/states',{state,reason:state==='failed'?'timeout':null,git_root:state==='repository'||state==='no_remote'?'/synthetic/states':null,remotes:state==='repository'?[{address:`https://git.example.invalid/repo-${sequence}.git`}]:[]})});
  for(const [sequence,state] of [['1','repository'],['3','failed'],['2','repository']])assert.equal((await send(sequence!,state!)).statusCode,201);
  const read=async()=>(await app.inject({url:'/api/v1/plugin/projects',headers})).json().data.items[0];
  assert.equal((await read()).latest.sequence,'3');assert.equal((await read()).confirmed.sequence,'2');
  assert.equal((await send('4','no_remote')).statusCode,201);assert.equal((await send('5','failed')).statusCode,201);
  assert.equal((await read()).confirmed.state,'no_remote');assert.deepEqual((await read()).confirmed.remotes,[]);
});

test('sanitized address evidence is idempotent, rejects conflicting IDs/sequences, and cannot fabricate Hook links',async t=>{
  const {app,headers,source}=await pluginFixture(t),sender=await source(),payload=event(sender,'1','/synthetic/addresses',{state:'repository',git_root:'/synthetic/addresses',remotes:[{address:'https://synthetic:private@git.example.invalid/team/code.git?secret=private#fragment'},{address:'https://git.example.invalid/team/code.git'}]});
  const submit=(body:object)=>app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:sender.uploadHeaders,payload:body});
  const replies=await Promise.all(Array.from({length:8},()=>submit(payload)));
  assert.equal(replies.filter(reply=>reply.statusCode===201).length,1);assert.equal(replies.filter(reply=>reply.statusCode===200).length,7);assert.equal(new Set(replies.map(reply=>reply.json().data.received_at)).size,1);
  assert.equal((await submit({...payload,workspace_path:'/synthetic/other'})).statusCode,409);
  assert.equal((await submit({...payload,observation_id:randomUUID()})).statusCode,409);
  assert.equal((await submit({...payload,source_kind:'hook',source_session_id:'fabricated'})).statusCode,400);
  const current=(await app.inject({url:'/api/v1/plugin/projects',headers})).json().data.items[0];assert.equal(current.confirmed.remotes.length,1);assert.equal(current.confirmed.remotes[0].address,'https://git.example.invalid/team/code.git');
});

test('authenticated source registration retains a bounded rate and supplies Retry-After',async t=>{
  const {app,bearer}=await pluginFixture(t),body={source_secret:Buffer.alloc(32,4).toString('base64url'),source_config_id:randomUUID(),platform:'macos',plugin_version:'0.3.0'};
  for(let index=0;index<20;index++)assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:body})).statusCode,200);
  const limited=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:body});assert.equal(limited.statusCode,429);assert.equal(limited.headers['retry-after'],'60');
});

test('Linux SSH sources retain POSIX paths and independent project evidence through persisted reports',async t=>{
 const {db,app,headers,bearer}=await pluginFixture(t);
 const input={source_secret:Buffer.alloc(32,29).toString('base64url'),source_config_id:randomUUID(),platform:'linux',plugin_version:'1.0.4'};
 const registration=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:input});assert.equal(registration.statusCode,200,registration.body);
 const payload={schema_version:2,collector_id:registration.json().data.collector_id,source_config_id:input.source_config_id,nt_email:registration.json().data.email,observation_id:randomUUID(),sequence:'1',platform:'linux',workspace_path:'/home/synthetic/SSH Project',observed_at:new Date().toISOString(),state:'repository',reason:null,git_root:'/home/synthetic/SSH Project',remotes:[{address:'ssh://git@git.example.invalid/team/remote.git'}],plugin_version:'1.0.4'};
 const receipt=await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':input.source_secret},payload});assert.equal(receipt.statusCode,201,receipt.body);
 const projects=(await app.inject({url:'/api/v1/plugin/projects',headers})).json().data;assert.equal(projects.items[0].platform,'linux');assert.equal(projects.items[0].workspace_path,payload.workspace_path);
 const persisted=await db.query<{platform:string;workspace:string}>("SELECT s.platform,o.evidence->>'workspace' AS workspace FROM project_streams s JOIN project_observations o ON o.project_id=s.id WHERE s.collector_id=$1",[payload.collector_id]);assert.equal(persisted.rows[0]!.platform,'linux');assert.equal(persisted.rows[0]!.workspace,payload.workspace_path);
 const invalid=await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':input.source_secret},payload:{...payload,observation_id:randomUUID(),sequence:'2',workspace_path:'C:\\not-a-linux-path'}});assert.equal(invalid.statusCode,400,invalid.body);
});
