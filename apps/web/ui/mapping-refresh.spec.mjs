import {URL} from 'node:url';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids} from './fixtures.mjs';
const api='**/api/v1/usage/department-mappings?*';
function mappings(url){
  const query=new URL(url).searchParams,tail=query.has('after_mapping'),candidates=query.has('after');
  return {data:{configured:true,version:1,items:[{id:tail?ids.session:ids.user,external_department_id:tail?'tail-mapping':'first-mapping',department_id:ids.department,valid_from:'2026-09-29T00:00:00Z',valid_to:null}],candidates:[{external_department_id:candidates?'source-tail':'source-first',name:candidates?'来源尾页':'来源首页',full_path:'示例'}],next_cursor:candidates?null:'candidate-next',next_mapping_cursor:tail?null:ids.second}};
}
async function open(page){
  await page.goto('/organization-management/departments');await page.getByRole('row').filter({hasText:'平台研发部'}).getByRole('button',{name:'官方部门关联',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'官方部门关联',exact:true});await expect(dialog).toContainText('first-mapping');return dialog;
}
test('mapping refresh preserves both loaded windows, the applied search and unsent form drafts',async({page})=>{
  await mockPage(page);const calls=[];
  await page.route(api,route=>{calls.push(new URL(route.request().url()));return route.fulfill({status:200,json:mappings(route.request().url())});});
  const dialog=await open(page);const search=dialog.getByRole('textbox',{name:'搜索官方部门',exact:true});
  await search.fill('已查询');await dialog.getByRole('button',{name:'查询',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'加载更多关联',exact:true}).click();await expect(dialog).toContainText('tail-mapping');
  await dialog.getByRole('button',{name:'加载更多来源部门',exact:true}).click();await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源尾页 · source-tail',exact:true}).click();
  await dialog.getByLabel('生效日期',{exact:true}).fill('2030-01-02');await dialog.getByLabel('结束日期',{exact:true}).fill('2030-03-04');await search.fill('未提交搜索草稿');
  const before=calls.length;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(dialog).toContainText('tail-mapping');await expect(dialog).toContainText('来源尾页');await expect(search).toHaveValue('未提交搜索草稿');await expect(dialog.getByLabel('生效日期',{exact:true})).toHaveValue('2030-01-02');await expect(dialog.getByLabel('结束日期',{exact:true})).toHaveValue('2030-03-04');
  expect(calls.slice(before).every(url=>url.searchParams.get('search')==='已查询')).toBe(true);
});

test('loading source candidates cannot re-label old mapping records with a new configuration version',async({page})=>{
  await mockPage(page);let sourceRead=false;const writes=[];
  await page.route(api,route=>{const url=new URL(route.request().url()),body=mappings(url.href);if(url.searchParams.has('after')){sourceRead=true;body.data.version=2;}else if(sourceRead){body.data.version=2;body.data.items[0].external_department_id='current-config-record';}return route.fulfill({status:200,json:body});});
  await page.route('**/api/v1/usage/department-mappings',route=>{writes.push(route.request().postDataJSON());return route.fulfill({status:201,json:{data:{id:ids.session,version:3}}});});
  const dialog=await open(page);await dialog.getByRole('button',{name:'加载更多来源部门',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(dialog).toContainText('current-config-record');await expect(dialog).not.toContainText('first-mapping');
  await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源尾页 · source-tail',exact:true}).click();await dialog.getByRole('button',{name:'添加关联',exact:true}).click();await expect.poll(()=>writes.length).toBe(1);expect(writes[0].version).toBe(2);
});

for(const status of [201,403]){
  test('closing and reopening mapping ignores a late '+status+' write reply',async({page})=>{
    await mockPage(page);let started,release;const writes=[];
    const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route(api,route=>route.fulfill({status:200,json:mappings(route.request().url())}));
    await page.route('**/api/v1/usage/department-mappings',async route=>{writes.push(route.request().postDataJSON());started();await gate;await route.fulfill(status===201?{status,json:{data:{id:ids.session,version:2}}}:{status,json:{error:{code:'forbidden',message:'旧关联写入被拒绝',request_id:'synthetic'}}});});
    const dialog=await open(page);await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源首页 · source-first',exact:true}).click();
    const reply=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/v1/usage/department-mappings');
    try{
      await dialog.getByRole('button',{name:'添加关联',exact:true}).click();await pending;
      await dialog.getByRole('button',{name:'Close this dialog',exact:true}).click();await expect(dialog).not.toBeVisible();
      await page.getByRole('row').filter({hasText:'平台研发部'}).getByRole('button',{name:'官方部门关联',exact:true}).click();await expect(dialog).toContainText('first-mapping');await dialog.getByLabel('生效日期',{exact:true}).fill('2030-12-15');
    }finally{release();}
    await (await reply).finished();await page.evaluate(()=>new Promise(resolve=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolve))));
    await expect(dialog.getByLabel('生效日期',{exact:true})).toHaveValue('2030-12-15');await expect(dialog).toContainText('first-mapping');await expect(dialog).not.toContainText('旧关联写入被拒绝');expect(writes).toHaveLength(1);
  });
}

test('a changed mapping version during load-more resets only the mapping window once',async({page})=>{
  await mockPage(page);let changed=false;const calls=[];
  await page.route(api,route=>{
    const url=new URL(route.request().url()),body=mappings(url.href);calls.push(url);
    if(changed){body.data.version=2;body.data.items[0].external_department_id=url.searchParams.has('after_mapping')?'mixed-tail':'updated-first';}
    return route.fulfill({status:200,json:body});
  });
  const dialog=await open(page);await dialog.getByRole('button',{name:'加载更多来源部门',exact:true}).click();
  await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源尾页 · source-tail',exact:true}).click();changed=true;
  await dialog.getByRole('button',{name:'加载更多关联',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(dialog).toContainText('updated-first');await expect(dialog).not.toContainText('mixed-tail');await expect(dialog).toContainText('来源尾页');await expect(dialog).toContainText('关联配置已更新');
  expect(calls.filter(url=>url.searchParams.has('after_mapping'))).toHaveLength(1);
});

test('mapping refresh never combines pages returned for different configuration versions',async({page})=>{
  await mockPage(page);let changed=false;
  await page.route(api,route=>{
    const url=new URL(route.request().url()),body=mappings(url.href);
    if(changed){body.data.version=url.searchParams.has('after_mapping')?3:2;body.data.items[0].external_department_id=url.searchParams.has('after_mapping')?'mixed-version-row':'fresh-first';}
    return route.fulfill({status:200,json:body});
  });
  const dialog=await open(page);await dialog.getByRole('button',{name:'加载更多关联',exact:true}).click();await expect(dialog).toContainText('tail-mapping');
  await dialog.getByLabel('生效日期',{exact:true}).fill('2030-01-02');changed=true;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(dialog).not.toContainText('mixed-version-row');await expect(dialog).toContainText('fresh-first');await expect(dialog).toContainText('关联配置已更新');await expect(dialog.getByLabel('生效日期',{exact:true})).toHaveValue('2030-01-02');
});

test('a successful mapping write refreshes the loaded windows without submitting the search draft',async({page})=>{
  await mockPage(page);const calls=[];let written=false;
  await page.route(api,route=>{const url=new URL(route.request().url());calls.push(url);const body=mappings(url.href);if(written)body.data.version=2;return route.fulfill({status:200,json:body});});
  await page.route('**/api/v1/usage/department-mappings',route=>{written=true;return route.fulfill({status:201,json:{data:{id:ids.session,version:2}}});});
  const dialog=await open(page);await dialog.getByRole('button',{name:'加载更多关联',exact:true}).click();await expect(dialog).toContainText('tail-mapping');
  await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源首页 · source-first',exact:true}).click();await dialog.getByRole('textbox',{name:'搜索官方部门',exact:true}).fill('未提交草稿');
  const before=calls.length;await dialog.getByRole('button',{name:'添加关联',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();await expect(dialog).toContainText('tail-mapping');
  await expect(dialog.getByRole('textbox',{name:'搜索官方部门',exact:true})).toHaveValue('未提交草稿');expect(calls.slice(before).every(url=>!url.searchParams.get('search'))).toBe(true);
});

for(const remove of [false,true]){
  test((remove?'removing':'adding')+' a mapping denial clears the old records and write draft',async({page})=>{
    await mockPage(page);await page.route(api,route=>route.fulfill({status:200,json:mappings(route.request().url())}));
    await page.route(remove?'**/api/v1/usage/department-mappings/'+ids.user:'**/api/v1/usage/department-mappings',route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'关联写入权限失效',request_id:'synthetic'}}}));
    const dialog=await open(page);
    if(remove){await dialog.getByRole('row').filter({hasText:'first-mapping'}).getByRole('button',{name:'移除关联',exact:true}).click();await page.getByRole('button',{name:'确认移除',exact:true}).click();}
    else{await dialog.getByRole('combobox',{name:'官方部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'来源首页 · source-first',exact:true}).click();await dialog.getByRole('button',{name:'添加关联',exact:true}).click();}
    await expect(dialog).toContainText('关联写入权限失效');await expect(dialog).not.toContainText('first-mapping');await expect(dialog.getByRole('button',{name:'添加关联',exact:true})).toHaveCount(0);
  });
}

test('failed initial mapping read is unknown and can be retried in the same dialog',async({page})=>{
  await mockPage(page);let failing=true;
  await page.route(api,route=>route.fulfill(failing?{status:503,json:{error:{code:'unavailable',message:'初次关联读取失败',request_id:'synthetic'}}}:{status:200,json:mappings(route.request().url())}));
  await page.goto('/organization-management/departments');await page.getByRole('row').filter({hasText:'平台研发部'}).getByRole('button',{name:'官方部门关联',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'官方部门关联',exact:true});await expect(dialog).toContainText('初次关联读取失败');await expect(dialog).toContainText('官方关联尚未读取');await expect(dialog).not.toContainText('尚未配置官方用量来源');
  failing=false;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await expect(dialog).toContainText('first-mapping');await expect(dialog).not.toContainText('初次关联读取失败');
});

test('temporary mapping refresh failure labels retained records while denial withdraws the form',async({page})=>{
  await mockPage(page);let status=0;
  await page.route(api,route=>route.fulfill(status?{status,json:{error:{code:status===403?'forbidden':'unavailable',message:status===403?'关联权限已撤销':'关联暂不可用',request_id:'synthetic'}}}:{status:200,json:mappings(route.request().url())}));
  const dialog=await open(page);await dialog.getByLabel('生效日期',{exact:true}).fill('2030-01-02');
  status=503;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await expect(dialog).toContainText('关联暂不可用');await expect(dialog).toContainText('上次关联结果');await expect(dialog).toContainText('first-mapping');await expect(dialog.getByLabel('生效日期',{exact:true})).toHaveValue('2030-01-02');
  status=403;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await expect(dialog).toContainText('关联权限已撤销');await expect(dialog).not.toContainText('first-mapping');await expect(dialog.getByLabel('生效日期',{exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'添加关联',exact:true})).toHaveCount(0);
});
