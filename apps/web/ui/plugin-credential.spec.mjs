/* global window, navigator, localStorage, sessionStorage, document */
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids} from './fixtures.mjs';

const token='synthetic-demo-do-not-use-shared-plugin-code';
const created='2026-10-09T01:00:00.000Z';
const source=(collector_id,platform)=>({collector_id,source_config_id:ids.second,platform,plugin_version:'0.2.0',created_at:created,last_seen:created});
async function credentialPage(page){
  await mockPage(page,'employee');
  await page.route('**/api/v1/me/plugin-credential',route=>route.fulfill({status:200,json:{data:route.request().method()==='POST'?{api_token:token,user_id:ids.user,email:'lin.xiao@example.invalid',created_at:created}:{credential:{created_at:created},sources:[source(ids.user,'windows'),source(ids.second,'macos')]}}}));
}

test('normal web login shows a masked shared plugin code and distinct source records without installer controls',async({page})=>{
  await credentialPage(page);let secrets=0;page.on('request',request=>{if(request.url().endsWith('/me/plugin-credential')&&request.method()==='POST')secrets++;});
  await page.goto('/my/installations');
  await expect(page.getByRole('heading',{name:'账号共用插件 API 码',exact:true})).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(token);expect(secrets).toBe(0);
  await expect(page.getByRole('row').filter({hasText:'Windows'})).toBeVisible();
  await expect(page.getByRole('row').filter({hasText:'macOS'})).toBeVisible();
  await expect(page.getByRole('main')).toContainText('不代表当前在线');
  for(const name of ['下载个人安装包','生成在线安装命令','撤销采集凭据','重置采集凭据'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'显示 API 码',exact:true}).click();await expect(page.getByLabel('插件 API 码',{exact:true})).toHaveText(token);expect(secrets).toBe(1);
  await page.getByRole('button',{name:'隐藏 API 码',exact:true}).click();await expect(page.getByRole('main')).not.toContainText(token);
});

test('the first explicit retrieval updates the credential state without claiming a source has bound',async({page})=>{
  await mockPage(page,'employee');
  await page.route('**/api/v1/me/plugin-credential',route=>route.fulfill({status:200,json:{data:route.request().method()==='POST'?{api_token:token,user_id:ids.user,email:'lin.xiao@example.invalid',created_at:created}:{credential:null,sources:[]}}}));
  await page.goto('/my/installations');await expect(page.getByRole('main')).toContainText('尚未领取');
  await page.getByRole('button',{name:'显示 API 码',exact:true}).click();await expect(page.getByLabel('插件 API 码',{exact:true})).toHaveText(token);
  await expect(page.getByRole('main')).toContainText('账号共用码：已建立');await expect(page.getByRole('main')).toContainText('暂无采集来源绑定');
});

test('copying uses a newly authenticated retrieval and never puts the shared code in browser storage',async({page})=>{
  await page.addInitScript(()=>{window.__copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__copied=value;}}});});
  await credentialPage(page);await page.goto('/my/installations');
  await page.getByRole('button',{name:'复制 API 码',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'API 码已复制'})).toBeVisible();expect(await page.evaluate(()=>window.__copied)).toBe(token);
  await expect(page.getByRole('main')).not.toContainText(token);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(token);
  await page.reload();await expect(page.getByRole('main')).not.toContainText(token);
});

test('copy remains usable when the plain HTTP page has no secure clipboard API',async({page})=>{
  await page.addInitScript(()=>{window.__copied='';Object.defineProperty(navigator,'clipboard',{value:undefined});document.execCommand=command=>{if(command!=='copy')return false;const selected=document.activeElement;window.__copied=selected.value.slice(selected.selectionStart,selected.selectionEnd);return true;};});
  await credentialPage(page);await page.goto('/my/installations');await page.getByRole('button',{name:'复制 API 码',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'API 码已复制'})).toBeVisible();expect(await page.evaluate(()=>window.__copied)).toBe(token);await expect(page.getByRole('main')).not.toContainText(token);
});

for(const [status,code] of [[403,'forbidden'],[503,'recovery_quarantined']])test(`denied shared code retrieval ${code} clears visible secrets and does not copy the old value`,async({page})=>{
  await page.addInitScript(()=>{window.__copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__copied=value;}}});});
  await credentialPage(page);let denied=false;
  await page.route('**/api/v1/me/plugin-credential',route=>denied?route.fulfill({status,json:{error:{code,message:'本人采集接入已不可访问'}}}):route.fulfill({status:200,json:{data:route.request().method()==='POST'?{api_token:token,user_id:ids.user,email:'lin.xiao@example.invalid',created_at:created}:{credential:{created_at:created},sources:[source(ids.user,'windows')]}}}));
  await page.goto('/my/installations');await page.getByRole('button',{name:'显示 API 码',exact:true}).click();await expect(page.getByLabel('插件 API 码',{exact:true})).toHaveText(token);
  denied=true;await page.getByRole('button',{name:'复制 API 码',exact:true}).click();await expect(page.getByRole('alert')).toContainText('本人采集接入已不可访问');await expect(page.getByRole('main')).not.toContainText(token);await expect(page.getByRole('row').filter({hasText:ids.user})).toHaveCount(0);expect(await page.evaluate(()=>window.__copied)).toBe('');
});

test('a late shared code reply cannot expose the secret after leaving the page',async({page})=>{
  await credentialPage(page);let release,started;const gate=new Promise(resolve=>{release=resolve;}),read=new Promise(resolve=>{started=resolve;});
  await page.route('**/api/v1/me/plugin-credential',async route=>{if(route.request().method()==='POST'){started();await gate;return route.fulfill({status:200,json:{data:{api_token:token,user_id:ids.user,email:'lin.xiao@example.invalid',created_at:created}}});}return route.fulfill({status:200,json:{data:{credential:{created_at:created},sources:[]}}});});
  await page.goto('/my/installations');await page.getByRole('button',{name:'显示 API 码',exact:true}).click();await read;
  try{await page.getByRole('complementary').getByRole('link',{name:'我的概览',exact:true}).click();await expect(page).toHaveURL(/\/my\/overview$/);}finally{release();}
  await expect(page.getByRole('main')).not.toContainText(token);await expect(page.getByLabel('插件 API 码',{exact:true})).toHaveCount(0);
});

test('temporary status failure keeps source records as stale but withdraws the visible code before refresh',async({page})=>{
  await credentialPage(page);let failure=false;
  await page.route('**/api/v1/me/plugin-credential',route=>failure?route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'来源记录暂不可用'}}}):route.fulfill({status:200,json:{data:route.request().method()==='POST'?{api_token:token,user_id:ids.user,email:'lin.xiao@example.invalid',created_at:created}:{credential:{created_at:created},sources:[source(ids.user,'windows')]}}}));
  await page.goto('/my/installations');await page.getByRole('button',{name:'显示 API 码',exact:true}).click();await expect(page.getByLabel('插件 API 码',{exact:true})).toHaveText(token);failure=true;
  await page.getByRole('button',{name:'刷新采集状态',exact:true}).click();await expect(page.getByRole('alert')).toContainText('上次接入记录');await expect(page.getByRole('main')).not.toContainText(token);await expect(page.getByRole('row').filter({hasText:ids.user})).toBeVisible();
});
