import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityService,createOrganizationService,createRegistrationService,createInstallationService,createAdministrationService,createUsageSnapshotStore,createSessionDerivationService,type ProviderUsageItem} from '@adi/domain';
import {loadClientDistribution} from '../../src/client-distribution.js';
import {createHash} from 'node:crypto';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../../packages/storage/test/helpers.js';
import {createApi} from '../../src/app.js';

async function fixture(t:Parameters<typeof testDatabase>[0],pluginOptions:{providerAccount?:string;clock?:()=>Date}={}){
  const db=await testDatabase(t);await db.migrate();
  const identity=createIdentityService(db,{emailDomains:['example.org']});
  const seed=await identity.bootstrap({email:'synthetic.plugin.admin@example.org',name:'合成插件测试'});
  const first=await identity.login('synthetic.plugin.admin@example.org',seed.temporaryPassword);
  const login=await identity.changePassword(first.token,seed.temporaryPassword,'synthetic-plugin-password-1');
  const organization=createOrganizationService(db,identity),registration=createRegistrationService(db,identity);
  const department=await organization.createDepartment(login.token,'合成部门');
  await registration.activate(login.token,{department_id:department.id});
  const installations=createInstallationService(db,identity,{encryptionKey:Buffer.alloc(32,7)});
  const distribution=await loadClientDistribution({collectorUrl:'http://web.example.invalid/hooks'});
  const app=createApi(undefined,{identity,registration,installations,clientDistribution:distribution,plugin:{db,signingKey:Buffer.alloc(32,7),...pluginOptions},allowedOrigin:'http://web.example.invalid'});
  t.after(()=>app.close());
  const headers={cookie:`adi_session=${login.token}`,'x-csrf-token':login.csrfToken,origin:'http://web.example.invalid'};
  return {db,identity,app,login,headers,installations,registration,department};
}

test('本人正常登录首次取码并发及重试始终返回同一份，状态查询不泄露码',async t=>{
  const {app,headers}=await fixture(t);
  const before=await app.inject({url:'/api/v1/me/plugin-credential',headers});
  assert.equal(before.statusCode,200,before.body);assert.equal(before.json().data.credential,null);
  const replies=await Promise.all(Array.from({length:4},()=>app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})));
  for(const reply of replies)assert.equal(reply.statusCode,200,reply.body);
  const codes=replies.map(reply=>reply.json().data.api_token);
  assert.match(codes[0],/^adi_api_v2\.[A-Za-z0-9_-]{43}$/);assert.equal(new Set(codes).size,1);
  const status=await app.inject({url:'/api/v1/me/plugin-credential',headers});
  assert.equal(status.statusCode,200,status.body);assert.equal(status.body.includes(codes[0]),false);
  assert.equal((await app.inject({url:'/api/v1/me/plugin-credential',headers:{authorization:`Bearer ${codes[0]}`}})).statusCode,401);
});

test('永久插件码改密后仍可验证本人但不能读取普通Web或原文API，旧匿名入口退役',async t=>{
  const {app,headers,identity,login}=await fixture(t);
  const issued=await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}});
  const api=issued.json().data.api_token,bearer={authorization:`Bearer ${api}`};
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:bearer})).statusCode,200);
  await identity.changePassword(login.token,'synthetic-plugin-password-1','synthetic-plugin-password-2');
  const me=await app.inject({url:'/api/v1/plugin/me',headers:bearer});
  assert.equal(me.statusCode,200,me.body);assert.equal(me.json().data.user_id,login.user.user_id);
  assert.equal(Object.hasOwn(me.json().data,'roles'),false);
  for(const url of ['/api/v1/me','/api/v1/me/plugin-credential','/api/v1/analytics/overview','/api/v1/me/sessions','/api/v1/admin/sessions'])assert.equal((await app.inject({url,headers:bearer})).statusCode,401,url);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/registration',payload:{}})).statusCode,410);
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:{authorization:'Bearer adi_plugin_v1.fake.fake'}})).statusCode,401);
});

test('认证来源绑定及原配置连续性可复用，邮箱伪造与错来源秘密被拒绝',async t=>{
  const {app,headers}=await fixture(t);
  const api=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token;
  const source={source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'macos',plugin_version:'0.3.0'};
  const bearer={authorization:`Bearer ${api}`};
  const registered=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:source});
  assert.equal(registered.statusCode,200,registered.body);
  const again=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:source});assert.equal(again.json().data.collector_id,registered.json().data.collector_id);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:{...source,nt_email:'other@example.org'}})).statusCode,400);
  const status=await app.inject({url:'/api/v1/me/plugin-credential',headers});
  assert.equal(status.json().data.sources.length,1);assert.equal(status.json().data.sources[0].last_seen,null);
  const event={schema_version:2,collector_id:registered.json().data.collector_id,source_config_id:source.source_config_id,nt_email:'forged@example.org',observation_id:randomUUID(),sequence:'1',platform:'macos',workspace_path:'/synthetic/plugin-source',observed_at:new Date().toISOString(),state:'not_git',reason:null,git_root:null,remotes:[],plugin_version:'0.3.0'};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':randomBytes(32).toString('base64url')},payload:event})).statusCode,401);
  const saved=await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':source.source_secret},payload:event});assert.equal(saved.statusCode,201,saved.body);
  const after=await app.inject({url:'/api/v1/me/plugin-credential',headers});assert.equal(after.json().data.sources[0].last_seen,saved.json().data.received_at);
});

test('插件今日摘要强制北京今日和本人，不允许历史筛选或把未配置官方量当零',async t=>{
  const {app,headers}=await fixture(t);
  const token=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token;
  const bearer={authorization:`Bearer ${token}`};
  const response=await app.inject({url:'/api/v1/plugin/today',headers:bearer});assert.equal(response.statusCode,200,response.body);
  const dto=response.json().data;assert.equal(dto.timezone,'Asia/Shanghai');assert.equal(dto.today_in_progress,true);assert.equal(dto.official_chat_tokens,null);assert.equal(dto.official_cue_tokens,null);assert.equal(dto.official_configured,false);
  for(const query of ['scope=organization','member_id='+randomUUID(),'from=2024-01-01T00:00:00Z'])assert.equal((await app.inject({url:'/api/v1/plugin/today?'+query,headers:bearer})).statusCode,400);
});

test('插件本人今日数字分开官方Chat与CUE，只读本人当日Hook且不泄露合成原文',async t=>{
  const at=new Date(),clock=()=>at,providerAccount='synthetic-today-account';
  const {db,app,headers,identity,login,registration,department,installations}=await fixture(t,{clock,providerAccount});
  const start=Math.floor((at.getTime()+28800000)/86400000)*86400000-28800000,businessDate=new Date(start+28800000).toISOString().slice(0,10);
  const other=await registration.register({email:'synthetic.today.other@example.org',password:'synthetic-today-other-password',display_name:'合成其他今日成员',department_id:department.id});
  const otherLogin=await identity.login('synthetic.today.other@example.org','synthetic-today-other-password');
  const ownInstall=await installations.credential(login.token),otherInstall=await installations.credential(otherLogin.token);
  await db.ensurePartitions(new Date(start-86400000),new Date(start+86400000));
  for(const [installation_id,source_session_id,count,occurred_at] of [[ownInstall.installation.id,'synthetic-own-today',2,at.toISOString()],[otherInstall.installation.id,'synthetic-other-today',3,at.toISOString()],[ownInstall.installation.id,'synthetic-own-yesterday',1,new Date(start-3600000).toISOString()]] as const){
    for(let i=0;i<count;i++){
      const saved=await db.ingest({schema_version:2,installation_id,client_event_id:source_session_id+'-'+i,source_session_id,event_type:'UserPromptSubmit',occurred_at,payload:{prompt:'SYNTHETIC_PRIVATE_TODAY_PROMPT'}},{admissionEpoch:1,receivedAt:at});
      assert.equal(saved.outcome,'committed');
    }
  }
  const store=createUsageSnapshotStore(db,{providerAccount,clock});
  const publish=async(userId:string,email:string,chat:string,cue:string)=>{
    const draft=await store.begin(userId,businessDate);assert.equal(draft.parts.length,1);
    const make=(scene:string,client:string,tokens:string):ProviderUsageItem=>({billing_session_id:'synthetic-bill-'+userId+'-'+scene+'-'+client,provider_user_id:'synthetic-provider-'+userId,email,start_time:String(draft.parts[0]!.query.start_time),client,scene,model_name:'SYNTHETIC_PRIVATE_MODEL',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens,completion_tokens:'0',total_tokens:tokens,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'});
    const rows=[make('Chat','ide',chat),make('CUE','ide',cue),make('Chat','cli','999')];
    await store.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:rows.length,total_pages:1},request_id:'synthetic-today',observed_at:at.toISOString(),response_hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),query:{endpoint:'user_usage_detail',parameters:draft.parts[0]!.query}});
    await store.publish(draft);
  };
  await publish(login.user.user_id,login.user.email,'9007199254740993','30');await publish(other.user_id,'synthetic.today.other@example.org','9000','8000');
  const token=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token,bearer={authorization:`Bearer ${token}`};
  const pending=await app.inject({url:'/api/v1/plugin/today',headers:bearer});assert.equal(pending.statusCode,200,pending.body);
  const first=pending.json().data;
  assert.equal(first.business_date,businessDate);assert.deepEqual(first.period,{from:new Date(start).toISOString(),to:new Date(start+86400000).toISOString()});
  assert.equal(first.official_chat_tokens,'9007199254740993');assert.equal(first.official_cue_tokens,'30');assert.equal(first.official_configured,true);assert.equal(first.official_coverage.expected_user_days,1);
  assert.equal(first.official_chat_usage.calls,'1');assert.equal(first.official_chat_usage.token_breakdown.input.tokens,'9007199254740993');assert.equal(first.official_chat_usage.token_breakdown.output.tokens,'0');assert.equal(first.official_chat_usage.token_breakdown.cache_read.tokens,'0');assert.equal(first.official_cue_usage.token_breakdown.input.tokens,'30');assert.equal(first.hook_sessions,1);assert.equal(first.prompt_turns,2);assert.equal(first.content_estimate_tokens,null);assert.equal(first.content_estimate_reason,null);assert.equal(first.partial_history,true);
  const derivation=createSessionDerivationService(db,{clock});let done=false;for(let attempts=0;attempts<20;attempts++)if(!await derivation.runOne()){done=true;break;}assert.equal(done,true);
  const ready=await app.inject({url:'/api/v1/plugin/today',headers:bearer});assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().data.prompt_turns,2);assert.equal(ready.json().data.content_estimate_tokens,null);assert.equal(ready.json().data.partial_history,false);
  for(const secret of ['SYNTHETIC_PRIVATE_TODAY_PROMPT','SYNTHETIC_PRIVATE_MODEL','synthetic.today.other@example.org',token])assert.equal(ready.body.includes(secret),false);
});

test('受限插件下载实际个人ZIP并核验哈希，独立Hook撤销不可被重新领取静默恢复',async t=>{
  const {app,headers,installations,login}=await fixture(t);
  const token=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token;
  const bearer={authorization:`Bearer ${token}`};
  const first=await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}});assert.equal(first.statusCode,200,first.body);
  const grant=first.json().data;assert.match(grant.authorization,/^adi_pkg_v2\./);assert.equal(grant.endpoint,'http://web.example.invalid/hooks');
  const archive=await app.inject({url:grant.download_path,headers:{authorization:`Bearer ${grant.authorization}`}});assert.equal(archive.statusCode,200,archive.body);
  assert.equal(archive.rawPayload.length,grant.bytes);assert.equal(createHash('sha256').update(archive.rawPayload).digest('hex'),grant.sha256);
  assert.equal((await app.inject({url:grant.download_path,headers:bearer})).statusCode,401);
  const again=await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}});assert.equal(again.json().data.installation_id,grant.installation_id);
  await installations.revoke(login.token);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).statusCode,409);
  assert.equal((await app.inject({url:grant.download_path,headers:{authorization:`Bearer ${grant.authorization}`}})).statusCode,401);
  for(const url of ['/api/v1/me/collection-install-command','/api/v1/me/collection-client'])assert.equal((await app.inject({method:'POST',url,headers,payload:{}})).statusCode,410);
  assert.equal((await app.inject({url:'/api/v1/collection-install/macos',headers:{authorization:`Bearer ${grant.authorization}`}})).statusCode,410);
});

test('停用与注册门禁拒绝永久码，恢复后原码可用且他人不能接管来源',async t=>{
  const {db,app,headers,identity,login,registration,department}=await fixture(t);
  const second=await registration.register({email:'synthetic.other@example.org',password:'synthetic-other-password',display_name:'合成第二人',department_id:department.id});
  const other=await identity.login('synthetic.other@example.org','synthetic-other-password');
  const otherHeaders={cookie:`adi_session=${other.token}`,'x-csrf-token':other.csrfToken,origin:'http://web.example.invalid'};
  const firstCode=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token;
  const otherCode=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers:otherHeaders,payload:{}})).json().data.api_token;
  const source={source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'windows',plugin_version:'0.3.0'};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:{authorization:`Bearer ${firstCode}`},payload:source})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:{authorization:`Bearer ${otherCode}`},payload:source})).statusCode,401);
  const administration=createAdministrationService(db,identity),account=await administration.getAccount(login.token,second.user_id);
  await administration.setStatus(login.token,second.user_id,{version:account.version,status:'suspended',reason:'合成拒绝测试'});
  const denied=await app.inject({url:'/api/v1/plugin/me',headers:{authorization:`Bearer ${otherCode}`}});assert.equal(denied.statusCode,403);
  const suspended=await administration.getAccount(login.token,second.user_id);
  await administration.setStatus(login.token,second.user_id,{version:suspended.version,status:'active',reason:'合成恢复测试'});
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:{authorization:`Bearer ${otherCode}`}})).statusCode,200);
  await db.query('UPDATE users SET registered_at=NULL WHERE id=$1',[second.user_id]);
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:{authorization:`Bearer ${otherCode}`}})).statusCode,409);
});

test('关闭或尚未开始的新基线拒绝插件业务和已有下载grant，开放后原码恢复',async t=>{
  const {db,app,headers}=await fixture(t);
  const code=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data.api_token,bearer={authorization:`Bearer ${code}`};
  const grant=(await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).json().data;
  await db.query('UPDATE data_identity SET collection_enabled=false');
  for(const url of ['/api/v1/plugin/me','/api/v1/plugin/today','/api/v1/plugin/collection-setup']){
    const denied=await app.inject({url,headers:bearer});assert.equal(denied.statusCode,503,url);assert.equal(denied.json().error.code,'collection_disabled');
  }
  assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).statusCode,503);
  assert.equal((await app.inject({url:grant.download_path,headers:{authorization:`Bearer ${grant.authorization}`}})).statusCode,503);
  await db.query("UPDATE data_identity SET collection_enabled=true,collection_baseline_at='2099-01-01T00:00:00+08:00'");
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:bearer})).statusCode,503);
  await db.query('UPDATE data_identity SET collection_baseline_at=NULL');
  assert.equal((await app.inject({url:'/api/v1/plugin/me',headers:bearer})).statusCode,200);
});

test('持久加密密钥不匹配时本人重取失败，不自动替换已有永久插件码',async t=>{
  const {db,identity,app,headers}=await fixture(t);
  const issued=(await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}})).json().data;
  const wrongKey=createApi(undefined,{identity,plugin:{db,signingKey:Buffer.alloc(32,19)},allowedOrigin:'http://web.example.invalid'});t.after(()=>wrongKey.close());
  for(let attempt=0;attempt<2;attempt++){
    const result=await wrongKey.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}});assert.equal(result.statusCode,503);assert.equal(result.json().error.code,'plugin_key_unavailable');
  }
  const me=await wrongKey.inject({url:'/api/v1/plugin/me',headers:{authorization:`Bearer ${issued.api_token}`}});assert.equal(me.statusCode,200);
  const status=await wrongKey.inject({url:'/api/v1/me/plugin-credential',headers});assert.equal(status.json().data.credential.created_at,issued.created_at);
});
