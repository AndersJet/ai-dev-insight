import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids} from './fixtures.mjs';
import {URL} from 'node:url';

function rules(url){
  const second=new URL(url).searchParams.has('cursor');return {data:{items:[{id:second?ids.second:ids.user,kind:'host',value:second?'tail.example.invalid':'first.example.invalid',version:1,created_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-30T00:00:00Z'}],total:21,next_cursor:second?null:'rules-next'}};
}
async function openRules(page){await page.goto('/code-flow');await page.getByRole('button',{name:'部门仓库白名单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});await expect(dialog).toContainText('first.example.invalid');return dialog;}

test('an empty allowlist tail recovers its first page without applying search or rule drafts',async({page})=>{
  await mockPage(page);let empty=false;const calls=[];
  await page.route('**/api/v1/repository-allowlist?*',route=>{const url=new URL(route.request().url());calls.push(url);const body=rules(url.href);if(empty&&url.searchParams.has('cursor'))Object.assign(body.data,{items:[],total:20});return route.fulfill({status:200,json:body});});
  const dialog=await openRules(page);await dialog.getByRole('textbox',{name:'搜索白名单',exact:true}).fill('applied');await dialog.getByRole('button',{name:'查询',exact:true}).click();await dialog.getByRole('button',{name:'下一页',exact:true}).click();await expect(dialog).toContainText('tail.example.invalid');
  await dialog.getByRole('textbox',{name:'搜索白名单',exact:true}).fill('未提交的搜索');await dialog.getByLabel('匹配地址',{exact:true}).fill('draft.example.invalid');empty=true;await dialog.getByRole('button',{name:'刷新白名单',exact:true}).click();
  await expect(dialog).toContainText('first.example.invalid');await expect(dialog).toContainText('第 1 页');await expect(dialog.getByRole('alert')).toContainText('白名单分页已更新');await expect(dialog.getByRole('textbox',{name:'搜索白名单',exact:true})).toHaveValue('未提交的搜索');await expect(dialog.getByLabel('匹配地址',{exact:true})).toHaveValue('draft.example.invalid');expect(calls.at(-1).searchParams.get('search')).toBe('applied');expect(calls.at(-1).searchParams.has('cursor')).toBe(false);
});

for(const [status,code] of [[403,'forbidden'],[503,'recovery_quarantined']]){
  test(`allowlist ${code} withdraws the protected parent project data and the editing form`,async({page})=>{
    await mockPage(page);let denied=false;
    await page.route('**/api/v1/repository-allowlist?*',route=>denied?route.fulfill({status,json:{error:{code,message:'当前配置与项目数据不可访问'}}}):route.fulfill({status:200,json:rules(route.request().url())}));
    const dialog=await openRules(page);await dialog.getByRole('row').filter({hasText:'first.example.invalid'}).getByRole('button',{name:'编辑',exact:true}).click();await expect(dialog.getByLabel('匹配地址',{exact:true})).toHaveValue('first.example.invalid');denied=true;await dialog.getByRole('button',{name:'刷新白名单',exact:true}).click();
    await expect(dialog).not.toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toHaveCount(0);await expect(page.getByRole('main').getByRole('alert')).toContainText('当前配置与项目数据不可访问');
  });
}

for(const action of ['save','remove']){
  test(`allowlist ${action} denial clears the protected editing scope`,async({page})=>{
    await mockPage(page);await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:200,json:rules(route.request().url())}));
    await page.route(action==='save'?'**/api/v1/repository-allowlist':`**/api/v1/repository-allowlist/${ids.user}`,route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'配置权限已撤销'}}}));
    const dialog=await openRules(page);
    if(action==='save'){await dialog.getByLabel('匹配地址',{exact:true}).fill('new.example.invalid');await dialog.getByRole('button',{name:'添加规则',exact:true}).click();}
    else{await dialog.getByRole('row').filter({hasText:'first.example.invalid'}).getByRole('button',{name:'移除',exact:true}).click();await page.getByRole('dialog',{name:'移除白名单规则',exact:true}).getByRole('button',{name:'确认移除',exact:true}).click();}
    await expect(dialog).not.toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toHaveCount(0);await expect(page.getByRole('main').getByRole('alert')).toContainText('配置权限已撤销');
  });
}

test('an unavailable initial allowlist read is not reported as no matching rules',async({page})=>{
  await mockPage(page);await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'白名单读取暂不可用'}}}));
  await page.goto('/code-flow');await page.getByRole('button',{name:'部门仓库白名单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});await expect(dialog.getByRole('alert')).toContainText('白名单读取暂不可用');await expect(dialog).not.toContainText('暂无匹配规则');await expect(dialog).toContainText('白名单尚未读取');
});

test('a temporary allowlist refresh failure preserves the current page and both drafts',async({page})=>{
  await mockPage(page);let fail=false;
  await page.route('**/api/v1/repository-allowlist?*',route=>fail?route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'配置暂不可用'}}}):route.fulfill({status:200,json:rules(route.request().url())}));
  const dialog=await openRules(page);await dialog.getByRole('button',{name:'下一页',exact:true}).click();await expect(dialog).toContainText('tail.example.invalid');await dialog.getByRole('textbox',{name:'搜索白名单',exact:true}).fill('搜索草稿');await dialog.getByLabel('匹配地址',{exact:true}).fill('draft.example.invalid');fail=true;
  await dialog.getByRole('button',{name:'刷新白名单',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('上次结果');await expect(dialog).toContainText('tail.example.invalid');await expect(dialog).toContainText('第 2 页');await expect(dialog.getByRole('textbox',{name:'搜索白名单',exact:true})).toHaveValue('搜索草稿');await expect(dialog.getByLabel('匹配地址',{exact:true})).toHaveValue('draft.example.invalid');
});

for(const outcome of ['success','forbidden']){
  test(`a late ${outcome} save reply cannot modify a reopened allowlist form or retry the write`,async({page})=>{
    await mockPage(page);let writes=0,started,release;
    const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:200,json:rules(route.request().url())}));
    await page.route('**/api/v1/repository-allowlist',async route=>{writes++;started();await gate;await route.fulfill(outcome==='success'?{status:201,json:{data:{...rules('http://test.invalid').data.items[0],value:'old.example.invalid'}}}:{status:403,json:{error:{code:'forbidden',message:'旧操作被拒绝'}}});});
    const dialog=await openRules(page);await dialog.getByLabel('匹配地址',{exact:true}).fill('old.example.invalid');
    try{await dialog.getByRole('button',{name:'添加规则',exact:true}).click();await pending;await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(dialog).not.toBeVisible();await page.getByRole('button',{name:'部门仓库白名单',exact:true}).click();await expect(dialog).toContainText('first.example.invalid');await dialog.getByLabel('匹配地址',{exact:true}).fill('new-draft.example.invalid');}finally{release();}
    await page.waitForLoadState('networkidle');await expect(dialog).toBeVisible();await expect(dialog.getByLabel('匹配地址',{exact:true})).toHaveValue('new-draft.example.invalid');await expect(dialog.getByRole('alert')).toHaveCount(0);await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();expect(writes).toBe(1);
  });
}
