import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {openDatabase} from '../../../packages/storage/src/index.js';
import {createUsageSnapshotStore} from '../../../packages/domain/src/usage-snapshots.js';
import {createUsageModelChecks} from '../../../packages/domain/src/usage-model-checks.js';
import {createTraeUsageProvider,type ProviderUsageItem} from '../../../packages/domain/src/usage-provider.js';

test('model checks reach the browser through real HTTP, scoped API and database, and hide stale or department-incompatible quantities',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
 const today=Math.floor((Date.now()+28800000)/86400000)*86400000-28800000,from=new Date(today-86400000).toISOString(),to=new Date(today).toISOString(),date=new Date(today-86400000+28800000).toISOString().slice(0,10),period=new URLSearchParams({from,to});
 let failed=false,empty=false,modelName='Synthetic Root',requests=0;
 const upstream=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url?.endsWith('/auth/token')){res.end(JSON.stringify({code:0,data:{access_token:'synthetic-model-token',expire:7200}}));return;}
  requests++;expect(body.user_ids).toEqual(['e2e-model-root']);expect(body.start_time).toBe((today-86400000)/1000);expect(body.end_time).toBe(today/1000-1);
  if(failed){res.writeHead(503);res.end();return;}
  res.end(JSON.stringify({code:0,data:{items:[{user_id:'e2e-model-root',email:fixture.admin.email,model_usage:empty?[]:[{model_name:modelName,model_source:'Trae',model_type:'Chat',usage:{input_tokens:130,output_tokens:10}}]}]}}));
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const store=createUsageSnapshotStore(db,{providerAccount:'e2e-official'}),checks=createUsageModelChecks(db,{providerAccount:'e2e-official',provider:createTraeUsageProvider({baseUrl:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,appId:'synthetic-id',appSecret:'synthetic-secret'})});
 async function publish(input:string){const draft=await store.begin(fixture.admin.userId,date),query=draft.parts[0]!.query;
  const rows:ProviderUsageItem[]=[['ide',input],['cli','20']].map(([client,tokens])=>({billing_session_id:`private-billing-root-${client}`,provider_user_id:'e2e-model-root',email:fixture.admin.email,start_time:String(query.start_time+1),client:client!,scene:'Chat',model_name:'Synthetic Root',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens!,completion_tokens:'5',total_tokens:String(BigInt(tokens!)+5n),cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:null,quality:[],token_basis:'provider_reported'}));
  await store.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:2,total_pages:1},request_id:'private-model-source',observed_at:new Date().toISOString(),response_hash:input==='100'?'c'.repeat(64):'d'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);
 }
 try{
  await publish('100');await checks.enqueue(fixture.admin.userId,date);
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await page.goto(`/my/overview?${period}`);const panel=page.getByTestId('model-check-panel');await expect(panel).toContainText('排队或执行中');
  await checks.runOne();await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('存在差异，待复核');await expect(panel.getByTestId('model-check-groups')).toContainText('120');await expect(panel.getByTestId('model-check-groups')).toContainText('130');
  const payload=await page.request.get(`/api/v1/analytics/official-usage?scope=self&${period}`);expect(payload.status()).toBe(200);expect(await payload.text()).not.toContain('private-billing-root');expect(await payload.text()).not.toContain('private-model-source');
  await panel.screenshot({path:'.run/model-check-comparison.png'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await panel.screenshot({path:'.run/model-check-comparison-mobile.png'});await page.setViewportSize({width:1280,height:900});
  await publish('110');await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('结果已失效');await expect(panel.getByTestId('model-check-groups')).toHaveCount(0);
  await checks.enqueue(fixture.admin.userId,date);await checks.runOne();await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('逐模型相等');
  modelName='Different Root Name';await checks.enqueue(fixture.admin.userId,date);await checks.runOne();await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('仅来源合计相等');
  empty=true;await checks.enqueue(fixture.admin.userId,date);await checks.runOne();await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('当前不可比');await expect(panel.getByTestId('model-check-groups')).toContainText('未知');
  failed=true;await checks.enqueue(fixture.admin.userId,date);await checks.runOne();await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(panel).toContainText('核查失败');await expect(panel.getByTestId('model-check-groups')).toHaveCount(0);
  await page.goto(`/organization/${fixture.analytics.departmentA}?${period}`);await expect(panel).toContainText('部门范围不可比');await expect(panel.getByTestId('model-check-groups')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await panel.screenshot({path:'.run/model-check-department-mobile.png'});expect(requests).toBe(5);
 }finally{upstream.closeAllConnections();upstream.close();await db.close();}
});
