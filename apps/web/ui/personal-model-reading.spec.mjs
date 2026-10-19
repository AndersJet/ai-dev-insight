import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
const api='**/api/v1/sessions/'+ids.session+'/personal-models';
async function open(page){
  await page.goto('/my/sessions/'+ids.session);await page.getByRole('tab',{name:'官方用量',exact:true}).click();return page.getByTestId('personal-models-panel');
}
test('failed initial personal-model read is unknown instead of a claim that no models were confirmed',async({page})=>{
  await mockPage(page);let failure=true;
  await page.route(api,route=>route.fulfill(failure?{status:503,json:{error:{code:'unavailable',message:'本人确认暂不可用',request_id:'synthetic'}}}:{status:200,json:response(route.request().url()).body}));
  const panel=await open(page);await expect(panel).toContainText('本人确认暂不可用');await expect(panel).toContainText('本人确认尚未读取');await expect(panel).not.toContainText('尚无本人确认的个人自配模型');
  failure=false;await panel.getByRole('button',{name:'重新读取',exact:true}).click();await expect(panel).toContainText('Claude Sonnet 4.5');await expect(panel).not.toContainText('本人确认暂不可用');
});

test('a version conflict can reread metadata in the editor without replacing its unsaved models',async({page})=>{
  await mockPage(page);let reads=0;const writes=[];
  await page.route(api,route=>{
    if(route.request().method()==='PUT'){writes.push(route.request().postDataJSON());return route.fulfill(writes.length===1?{status:409,json:{error:{code:'version_conflict',message:'本人确认版本已改变',request_id:'synthetic'}}}:{status:200,json:{data:{...response(route.request().url()).body.data,version:3,models:['保留的新模型草稿']}}});}
    const value=response(route.request().url()).body;if(++reads>1){value.data.version=2;value.data.models=['另一已保存模型'];}return route.fulfill({status:200,json:value});
  });
  const panel=await open(page);await panel.getByRole('button',{name:'修改本人确认',exact:true}).click();const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});await dialog.getByLabel('模型名称',{exact:true}).fill('保留的新模型草稿');
  await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();await expect(dialog).toContainText('本人确认版本已改变');
  await dialog.getByRole('button',{name:'重读本人确认',exact:true}).click();await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('保留的新模型草稿');
  await expect(dialog.getByRole('button',{name:'保存本人确认',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();await expect(dialog).not.toBeVisible();expect(writes).toHaveLength(2);expect(writes[1].version).toBe(2);expect(writes[1].models).toEqual(['保留的新模型草稿']);
});

test('personal model drafts survive temporary write failure and retry only through another explicit save',async({page})=>{
  await mockPage(page);const writes=[];
  await page.route(api,route=>{
    if(route.request().method()==='PUT'){writes.push(route.request().postDataJSON());const value=response(route.request().url()).body;value.data.models=['已保存个人模型'];value.data.version=2;return route.fulfill(writes.length===1?{status:503,json:{error:{code:'unavailable',message:'确认保存暂不可用',request_id:'synthetic'}}}:{status:200,json:value});}
    return route.fulfill({status:200,json:response(route.request().url()).body});
  });
  const panel=await open(page);await panel.getByRole('button',{name:'修改本人确认',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});await dialog.getByLabel('模型名称',{exact:true}).fill('已保存个人模型');await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();
  await expect(dialog).toContainText('确认保存暂不可用');await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('已保存个人模型');expect(writes).toHaveLength(1);
  await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(panel).toContainText('已保存个人模型');expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
});

test('a late personal-model reply cannot change another session or repeat the write',async({page})=>{
  await mockPage(page);let started,release;const writes=[];
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(api,async route=>{
    if(route.request().method()==='PUT'){writes.push(route.request().postDataJSON());started();await gate;const value=response(route.request().url()).body;value.data.models=['旧会话迟到模型'];await route.fulfill({status:200,json:value});}
    else await route.fulfill({status:200,json:response(route.request().url()).body});
  });
  await page.route('**/api/v1/sessions/'+ids.second+'/personal-models',route=>{const value=response(route.request().url()).body;value.data.models=['另一会话模型'];return route.fulfill({status:200,json:value});});
  await page.goto('/my/sessions/'+ids.second);await page.goto('/my/sessions/'+ids.session);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  const panel=page.getByTestId('personal-models-panel');await panel.getByRole('button',{name:'修改本人确认',exact:true}).click();
  try{
    const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});await dialog.getByLabel('模型名称',{exact:true}).fill('旧会话迟到模型');await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();await pending;
    await page.goBack();await page.getByRole('tab',{name:'官方用量',exact:true}).click();await expect(panel).toContainText('另一会话模型');
  }finally{release();}
  await page.waitForLoadState('networkidle');await expect(panel).toContainText('另一会话模型');await expect(panel).not.toContainText('旧会话迟到模型');expect(writes).toHaveLength(1);
});

test('personal confirmation write denial withdraws the editor and old declared models',async({page})=>{
  await mockPage(page);const writes=[];
  await page.route(api,route=>{if(route.request().method()==='PUT'){writes.push(route.request().postDataJSON());return route.fulfill({status:403,json:{error:{code:'forbidden',message:'本人确认保存权限已失效',request_id:'synthetic'}}});}return route.fulfill({status:200,json:response(route.request().url()).body});});
  const panel=await open(page);await panel.getByRole('button',{name:'修改本人确认',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});await dialog.getByLabel('模型名称',{exact:true}).fill('个人模型草稿');await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(panel).toContainText('本人确认保存权限已失效');await expect(panel).not.toContainText('Claude Sonnet 4.5');expect(writes).toHaveLength(1);
});

test('personal confirmation reread retains visible models during a temporary failure and removes them on denial',async({page})=>{
  await mockPage(page);let failure=0,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(api,async route=>{if(failure===503){started();await gate;}await route.fulfill(failure?{status:failure,json:{error:{code:failure===403?'forbidden':'unavailable',message:failure===403?'本人确认读取已失效':'本人确认读取暂不可用',request_id:'synthetic'}}}:{status:200,json:response(route.request().url()).body});});
  const panel=await open(page);await expect(panel).toContainText('Claude Sonnet 4.5');failure=503;
  try{
    await page.getByRole('button',{name:'重新加载',exact:true}).click();await pending;await expect(panel).toContainText('Claude Sonnet 4.5');
  }finally{release();}
  await expect(panel).toContainText('上次本人确认结果');await expect(panel).toContainText('Claude Sonnet 4.5');
  failure=403;await panel.getByRole('button',{name:'重新读取',exact:true}).click();await expect(panel).toContainText('本人确认读取已失效');await expect(panel).not.toContainText('Claude Sonnet 4.5');await expect(panel.getByRole('button',{name:'修改本人确认',exact:true})).toHaveCount(0);
});

test('main detail reload rereads the current personal confirmation',async({page})=>{
  await mockPage(page);let calls=0;
  await page.route(api,route=>{const value=response(route.request().url());if(++calls>1){value.body.data.models=['最新本人模型'];value.body.data.version=2;}return route.fulfill({status:200,json:value.body});});
  const panel=await open(page);await expect(panel).toContainText('Claude Sonnet 4.5');await panel.getByRole('button',{name:'修改本人确认',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});await dialog.getByLabel('模型名称',{exact:true}).fill('尚未保存的模型草稿');
  // Close the editor to use the parent reload, then reopen with the loaded
  // current confirmation. A new explicit edit starts from the current result.
  await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await expect(panel).toContainText('最新本人模型');expect(calls).toBeGreaterThan(1);
});
