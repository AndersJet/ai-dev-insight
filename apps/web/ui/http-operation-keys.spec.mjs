import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids,period} from './fixtures.mjs';
import {environment} from './environment.mjs';
import {Buffer} from 'node:buffer';

const origin='http://adi-http-ui.test';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function prepareHttp(page){
  // Relay assets while retaining a real non-loopback HTTP browser origin.
  await page.route(origin+'/**',async route=>{
    const response=await route.fetch({url:route.request().url().replace(origin,environment.baseURL)});
    await route.fulfill({response});
  });
  await mockPage(page,'super');
}
async function openMembers(page){
  await page.goto(origin+`/organization-management/${ids.department}/members`);
  expect(await page.evaluate(()=>globalThis.isSecureContext)).toBe(false);
}
const failed=route=>route.fulfill({status:503,json:{error:{code:'cleanup_acceptance_unconfirmed',message:'提交未确认，请重试'}}});

test('HTTP cleanup preview completes and explicit submission retry retains one operation key',async({page})=>{
  await prepareHttp(page);
  const keys=[];let previews=0;
  await page.route('**/api/v1/admin/cleanup/previews',route=>{previews++;const input=route.request().postDataJSON();return route.fulfill({json:{data:{preview_id:ids.second,target:{id:ids.user,email:'lin.xiao@example.invalid',name:'林晓'},range:{from:input.from,to:input.to},counts:{hook_events:12,project_observations:7,hook_project_observations:3,plugin_project_observations:4,project_links:5,sessions:2,declared_sessions:1,official_days:1},expires_at:new Date(Date.now()+600000).toISOString(),can_submit:true}}});});
  await page.route('**/api/v1/admin/cleanup/jobs',route=>{keys.push(route.request().headers()['idempotency-key']);return keys.length===1?failed(route):route.fulfill({status:202,json:{data:{job_id:ids.second,status:'queued'}}});});
  await page.route(`**/api/v1/jobs/${ids.second}`,route=>route.fulfill({json:{data:{job_id:ids.second,status:'queued',phase:'journal',error_code:null,user_id:ids.user,target_email:'lin.xiao@example.invalid',current_email:'lin.xiao@example.invalid',current_name:'林晓',from_at:period.from,to_at:period.to,progress:{}}}}));
  await openMembers(page);
  await page.getByRole('button',{name:'更多',exact:true}).first().click();await page.getByRole('menuitem',{name:'清理使用数据',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'清理使用数据',exact:true}),generate=dialog.getByRole('button',{name:'生成清理预览',exact:true});
  await generate.click();await expect(dialog.getByRole('heading',{name:'确认目标与影响',exact:true})).toBeVisible();await expect(generate).toBeEnabled();expect(previews).toBe(1);
  await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');const submit=dialog.getByRole('button',{name:'确认清理并提交任务',exact:true});
  await submit.click();await expect(dialog.getByRole('alert')).toContainText('提交未确认');await expect(submit).toBeEnabled();
  await submit.click();await expect(dialog.locator('.cleanup-progress')).toContainText('排队中');expect(keys).toHaveLength(2);expect(keys[0]).toMatch(uuid);expect(keys[1]).toBe(keys[0]);
});

const batch=()=>({id:ids.second,department_id:ids.department,mode:'insert_only',source_name:'预览.csv',preview_hash:'a'.repeat(64),status:'previewed',expires_at:'2030-01-01T00:00:00Z',can_submit:true,job_id:null,job:null,counts:{create:1,update:0,skip:0,unchanged:0,error:0},rows:[{row:2,email:'import@example.invalid',display_name:'HTTP合成人员',eligible:true,eligibility_from:'2026-09-29',eligibility_to:null,action:'create',changes:[],errors:[],before:null}]});
test('HTTP member import preview completes and retries reuse the original operation key',async({page})=>{
  await prepareHttp(page);const keys=[];
  await page.route('**/api/v1/member-imports/preview?*',route=>route.fulfill({json:{data:batch()}}));
  await page.route('**/api/v1/member-imports/*/commit',route=>{keys.push(route.request().headers()['idempotency-key']);return keys.length===1?failed(route):route.fulfill({status:202,json:{data:{job_id:ids.session,status:'queued'}}});});
  await page.route(`**/api/v1/member-imports/${ids.second}`,route=>route.fulfill({json:{data:{...batch(),status:keys.length>1?'succeeded':'previewed',can_submit:keys.length<2}}}));
  await openMembers(page);await page.getByRole('button',{name:'批量导入',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  await dialog.getByLabel('选择成员文件',{exact:true}).setInputFiles({name:'预览.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nimport@example.invalid,HTTP合成人员')});
  const submit=dialog.getByRole('button',{name:'确认整批导入',exact:true});await expect(submit).toBeEnabled();await expect(dialog).toContainText('HTTP合成人员');
  await submit.click();await expect(dialog).toContainText('提交未确认');await expect(submit).toBeEnabled();await submit.click();
  await expect.poll(()=>keys.length).toBe(2);expect(keys[0]).toMatch(uuid);expect(keys[1]).toBe(keys[0]);
});

test('HTTP cleanup restores the preview button and displays a failure if random generation fails',async({page})=>{
  await page.addInitScript(()=>{Object.defineProperty(globalThis.crypto,'getRandomValues',{value(){throw new Error('random generation unavailable');}});});
  await prepareHttp(page);let previews=0;
  await page.route('**/api/v1/admin/cleanup/previews',route=>{previews++;return route.abort();});
  await openMembers(page);await page.getByRole('button',{name:'更多',exact:true}).first().click();await page.getByRole('menuitem',{name:'清理使用数据',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'清理使用数据',exact:true}),generate=dialog.getByRole('button',{name:'生成清理预览',exact:true});await generate.click();
  await expect(dialog.getByRole('alert')).toContainText('无法生成操作标识');await expect(generate).toBeEnabled();expect(previews).toBe(0);
});
