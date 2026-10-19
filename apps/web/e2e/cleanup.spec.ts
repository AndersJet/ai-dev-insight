import {environment as e2eEnv} from './helpers/environment.mjs';
import {registeredFixture,collectionFixture} from './helpers/registered-fixture.js';
import {test,expect} from './helpers/browser.js';import {randomUUID} from 'node:crypto';
test('superadmin previews and confirms scoped cleanup while the independent worker preserves outside observations',async({page})=>{
 // Allow a slower Runner to finish two <=60-second snapshot waits, bounded
 // same-request confirmation retries and background cleanup. HTTP/database
 // deadlines and the publication budget stay unchanged.
 test.setTimeout(180000);
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();const csrf=(await page.context().cookies()).find(value=>value.name==='adi_csrf')!.value,headers={'x-csrf-token':csrf};
 const dep=await page.request.post('/api/v1/departments',{headers,data:{name:'E2E清理部'}});expect(dep.status()).toBe(201);const department=(await dep.json()).data.id;const member=await page.request.post(`/api/v1/departments/${department}/members`,{headers,data:{email:'cleanup-browser@example.invalid',display_name:'清理验证成员'}});expect(member.status()).toBe(201);const user=(await member.json()).data.user_id;
 await registeredFixture(user);
 // Pin second 50 so the cleanup end boundary is exactly a minute, every run.
 const credential=await collectionFixture(user),policyAfter=Date.now();
 // HTTP 200 is the Hook fast path. A fresh policy must include this newly
 // seeded identity before the one-time three-event persistence assertion.
 await expect.poll(async()=>{
  const response=await page.request.get('/api/v1/system/health');expect(response.ok()).toBe(true);
  const health=(await response.json()).data,current=health.instances.find((instance:{boot_id:string})=>instance.boot_id===health.collector.boot_id),expiresAt=current?.metrics.delivery_policyExpiresAt;
  return current?.fresh===true&&typeof expiresAt==='number'&&expiresAt-10000>=policyAfter;
 },{timeout:15000}).toBe(true);
 const now=Math.floor(Date.now()/60000)*60000+50000,targetAt=now-2*3600000,source=randomUUID();const events=[3,2,1].map(hours=>({schema_version:2,installation_id:credential.installation.id,client_event_id:randomUUID(),source_session_id:source,event_type:'UserPromptSubmit',occurred_at:new Date(now-hours*3600000).toISOString(),payload:{prompt:hours===2?'REMOVE_SYNTHETIC_ONLY':'KEEP_SYNTHETIC_OUTSIDE'},...(hours===2?{project:{collector_id:randomUUID(),platform:'macos',workspace:'/synthetic/browser-project',unresolved_reason:null,observation:{id:randomUUID(),sequence:'1',observed_at:new Date(now-hours*3600000).toISOString(),state:'repository',reason:null,git_root:'/synthetic/browser-project',remotes:[{name:'origin',direction:'fetch',address:'https://git.example.invalid/cleanup.git'}]}}}:{})}));
 for(const event of events){const response=await page.request.post(e2eEnv.collectorURL+'/hooks',{headers:{authorization:`Bearer ${credential.token}`},data:event});expect(response.status()).toBe(200);}
 const currentList=async(allowCleanupFence=false)=>{const response=await page.request.get(`/api/v1/admin/sessions?user_id=${user}`),body=await response.json();
  if(response.status()===503){expect(body.error.code).toBe('session_snapshot_pending');return null;}
  if(allowCleanupFence&&response.status()===409){expect(body.error.code).toBe('content_changed');return null;}
  expect(response.status()).toBe(200);expect(body.data.snapshot.id).toEqual(expect.any(String));
  return {total:body.data.total,source:body.data.items[0]?.source_session_id,prompts:body.data.items[0]?.prompt_turns};
 };
 await expect.poll(()=>currentList(),{timeout:60000}).toEqual({total:1,source,prompts:3});
 // Reproduce the valid unconfirmed response seen on the Runner while the
 // real API/worker still handle this same cleanup request.
 let firstSubmission=true;const submissions:{key:string|undefined;body:unknown}[]=[];
 await page.route('**/api/v1/admin/cleanup/jobs',async route=>{
  if(route.request().method()!=='POST'){await route.fallback();return;}
  submissions.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
  if(!firstSubmission){await route.fallback();return;}
  firstSubmission=false;const response=await route.fetch();
  if(response.status()!==202){await route.fulfill({response});return;}
  await route.fulfill({status:503,json:{error:{code:'cleanup_acceptance_unconfirmed',message:'提交确认尚未完成；任务可能已经接收，请重试原操作并核对任务历史',request_id:'synthetic-cleanup-unconfirmed'}}});
 });
 await page.goto(`/organization-management/${department}/members`);await page.getByRole('row').filter({hasText:'cleanup-browser@example.invalid'}).getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('menuitem',{name:'清理使用数据',exact:true}).click();const dialog=page.getByRole('dialog',{name:'清理使用数据',exact:true});await expect(dialog).toBeVisible();
 // Chromium normalizes zero seconds away; use the same datetime-local representation.
 const local=(value:number)=>new Date(value+8*3600000).toISOString().slice(0,19).replace(/:00$/,'');await dialog.getByLabel('开始时间（北京时间）').fill(local(targetAt-10000));await dialog.getByLabel('结束时间（北京时间）').fill(local(targetAt+10000));await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();await expect(dialog.getByTestId('cleanup-event-count')).toHaveText('1');await expect(dialog.getByTestId('cleanup-project-observation-count')).toHaveText('1');await expect(dialog.getByTestId('cleanup-project-link-count')).toHaveText('1');await expect(dialog).not.toContainText('REMOVE_SYNTHETIC_ONLY');await dialog.getByLabel('确认目标邮箱').fill('cleanup-browser@example.invalid');
 const submit=dialog.getByRole('button',{name:'确认清理并提交任务',exact:true});let accepted=false;
 for(let attempt=0;attempt<8;attempt++){
  const [response]=await Promise.all([
   page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/admin/cleanup/jobs'),
   submit.click(),
  ]);
  if(response.status()===202){accepted=true;break;}
  expect(response.status()).toBe(503);expect((await response.json()).error.code).toBe('cleanup_acceptance_unconfirmed');
  await expect(dialog.getByRole('alert')).toContainText('提交确认尚未完成');
  await expect(dialog.getByLabel('确认目标邮箱')).toHaveValue('cleanup-browser@example.invalid');
  await expect(submit).toBeEnabled();
 }
 expect(accepted,'the same cleanup request must receive durable confirmation within eight attempts').toBe(true);
 expect(submissions.length).toBeGreaterThanOrEqual(2);expect(submissions[0]!.key).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
 for(const request of submissions)expect(request).toEqual(submissions[0]);
 await expect(dialog.getByTestId('cleanup-job-status')).toHaveText('已完成',{timeout:30000});await page.screenshot({path:'.run/cleanup-completed.png',fullPage:true,animations:'disabled'});
 await expect.poll(()=>currentList(true),{timeout:60000}).toEqual({total:1,source,prompts:2});
 await dialog.locator('.cleanup-history summary').click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);const listed=await page.request.get(`/api/v1/admin/cleanup/jobs?user_id=${user}`);expect(listed.ok()).toBe(true);const jobId=(await listed.json()).data.items[0].job_id;
 await dialog.getByRole('button',{name:'刷新任务列表',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新任务列表',exact:true})).toBeEnabled();await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);await expect(dialog.locator('.cleanup-progress')).toContainText(jobId);await expect(dialog.getByTestId('cleanup-job-status')).toHaveText('已完成');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
});
