import {test,expect} from '../e2e/helpers/browser.js';
import {URL} from 'node:url';
import {mockPage,ids} from './fixtures.mjs';
const stable={version:'1.0.5',build_id:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1024,channel:'stable',download_path:'/api/v1/plugin-releases/builds/'+'a'.repeat(64)+'/download'};
test('未登录也能在登录页下载正式插件并看到插件内注册指引',async({page})=>{
 await mockPage(page,'anonymous');await page.route('**/api/v1/plugin-releases/current',r=>r.fulfill({json:{data:stable,meta:{request_id:'synthetic'}}}));
 await page.goto('/login');await expect(page.getByRole('link',{name:'下载正式版插件 1.0.5'})).toHaveAttribute('href',stable.download_path);await expect(page.getByText('只需下载并安装主插件，在插件中注册或登录。',{exact:true})).toBeVisible();
 await expect(page.getByText('使用 Remote SSH 时，主插件侧栏会提供“一键安装配套助手”；助手已包含在主插件中，无需另外下载。',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:/下载.*助手/})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('link',{name:'下载正式版插件 1.0.5'})).toBeVisible();await page.locator('.plugin-download').scrollIntoViewIfNeeded();await page.locator('.plugin-download').screenshot({path:test.info().outputPath('web-download-mobile.png')});
});
test('旧正式版不误称包含远端助手，仍保留统一主插件下载',async({page})=>{
 await mockPage(page,'anonymous');await page.route('**/api/v1/plugin-releases/current',r=>r.fulfill({json:{data:{...stable,version:'1.0.4'},meta:{request_id:'synthetic'}}}));await page.goto('/login');await expect(page.getByRole('link',{name:'下载正式版插件 1.0.4'})).toBeVisible();await expect(page.getByText('Remote SSH 支持需要 1.0.5 及以上版本。当前正式版尚未包含远端助手，请等待管理员发布新版。',{exact:true})).toBeVisible();await expect(page.getByText(/助手已包含在主插件中/)).toHaveCount(0);
});
test('管理员在系统运营管理试用构建并明确确认不可撤回的正式发布',async({page})=>{
 await mockPage(page,'super');let published=false;
 const pilot={...stable,id:ids.second,version:'1.1.0',build_id:'c'.repeat(64),state:'pilot',uploaded_at:new Date().toISOString(),published_at:null,pilot_user_ids:[ids.user],current_stable:false,current_pilot:true};delete pilot.channel;
 await page.route('**/api/v1/system/plugin-releases',r=>r.fulfill({json:{data:{items:[{...pilot,state:published?'released':'pilot',current_stable:published,current_pilot:!published,published_at:published?new Date().toISOString():null}]},meta:{request_id:'synthetic'}}}));
 await page.route('**/api/v1/system/plugin-releases/*/publish',async r=>{expect(r.request().postDataJSON()).toEqual({build_id:pilot.build_id});published=true;await r.fulfill({json:{data:{...pilot,state:'released'},meta:{request_id:'synthetic'}}});});
 await page.goto('/system/plugin-releases');await expect(page.getByRole('heading',{name:'插件版本管理',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'正式发布',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'正式发布',exact:true}).click();await page.getByRole('button',{name:'确认发布',exact:true}).click();await expect(page.getByText('当前正式版',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'正式发布',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/撤回/})).toHaveCount(0);
});

for(const failure of [{status:403,code:'forbidden',message:'无权执行该操作'},{status:503,code:'recovery_quarantined',message:'恢复校验未完成'}]){
 test(`试用弹窗遇到 ${failure.code} 后清除人员信息，迟到搜索不能恢复`,async({page})=>{
  await mockPage(page,'super');let revoked=false,finish;let requested;const lateStarted=new Promise(r=>requested=r),lateResult=new Promise(r=>finish=r);const person={user_id:ids.user,display_name:'合成试用人员',email:'synthetic.trial@example.invalid'};
  const draft={...stable,id:ids.second,state:'draft',uploaded_at:new Date().toISOString(),published_at:null,pilot_user_ids:[],current_stable:false,current_pilot:false};delete draft.channel;
  const denied=r=>r.fulfill({status:failure.status,json:{error:{code:failure.code,message:failure.message,request_id:'synthetic'}}});
  await page.route('**/api/v1/system/plugin-releases',r=>revoked?denied(r):r.fulfill({json:{data:{items:[draft]},meta:{request_id:'synthetic'}}}));
  await page.route('**/api/v1/system/plugin-releases/testers?**',async r=>{if(new URL(r.request().url()).searchParams.get('search')==='late'){requested();await lateResult;}await r.fulfill({json:{data:[person],meta:{request_id:'synthetic'}}}).catch(()=>{});});
  await page.route('**/api/v1/system/plugin-releases/*/pilot',r=>{revoked=true;return denied(r);});
  await page.goto('/system/plugin-releases');await page.getByRole('button',{name:'指定试用',exact:true}).click();const input=page.getByRole('combobox',{name:'选择试用人员'});await input.fill('synthetic');await page.getByRole('option',{name:'合成试用人员 · synthetic.trial@example.invalid',exact:true}).click();await input.fill('late');await lateStarted;await page.getByRole('heading',{name:'指定插件试用',exact:true}).click();await page.getByRole('button',{name:'保存指定试用',exact:true}).click();await expect(page.getByRole('dialog',{name:'指定插件试用',exact:true})).toBeHidden();await expect(page.getByText(failure.message,{exact:true})).toBeVisible();finish();await page.getByRole('button',{name:'刷新列表',exact:true}).click();await expect(page.getByText('合成试用人员 · synthetic.trial@example.invalid',{exact:true})).toHaveCount(0);await expect(page.getByRole('dialog',{name:'指定插件试用',exact:true})).toBeHidden();
 });
}
