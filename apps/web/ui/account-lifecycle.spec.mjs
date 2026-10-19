import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
import {URL} from 'node:url';
const path='/organization-management/'+ids.department+'/members';
const accountApi='**/api/v1/admin/users/'+ids.second;
async function setup(page){
  await mockPage(page);
  await page.route('**/api/v1/departments/'+ids.department+'/members?*',route=>{const value=response(route.request().url());value.body.data.items[0].user_id=ids.second;value.body.data.items[0].display_name='目标人员';return route.fulfill({status:200,json:value.body});});
  await page.route('**/api/v1/members?*',route=>{const value=response(route.request().url());value.body.data.items[0].user_id=ids.second;value.body.data.items[0].display_name='目标人员';return route.fulfill({status:200,json:value.body});});
  await page.route(accountApi,route=>{const value=response(route.request().url());value.body.data.id=ids.second;value.body.data.display_name='目标人员';value.body.data.management_source='system';return route.fulfill({status:200,json:value.body});});
  await page.goto(path);
}
async function action(page,name){await page.getByRole('row').filter({hasText:'目标人员'}).getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('menuitem',{name,exact:true}).click();}
test('denied account writes remove loaded account details and prevent another protected save',async({page})=>{
  await setup(page);
  await page.route('**/api/v1/admin/users/'+ids.second+'/email',route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'账号维护授权失效',request_id:'synthetic'}}}));
  await action(page,'更正邮箱身份');const dialog=page.getByRole('dialog',{name:'更正邮箱身份',exact:true});
  await dialog.getByLabel('新工作邮箱',{exact:true}).fill('corrected@example.invalid');await dialog.getByLabel('身份核验说明',{exact:true}).fill('合成核验说明');await dialog.getByRole('button',{name:'确认更正邮箱',exact:true}).click();
  await expect(dialog).toContainText('账号维护授权失效');await expect(dialog.getByLabel('新工作邮箱',{exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'确认更正邮箱',exact:true})).toBeDisabled();
});

test('temporary account correction failure keeps the draft and only retries on an explicit save',async({page})=>{
  await setup(page);const writes=[];
  await page.route('**/api/v1/admin/users/'+ids.second+'/email',route=>{writes.push(route.request().postDataJSON());return route.fulfill(writes.length===1?{status:503,json:{error:{code:'unavailable',message:'账号服务暂不可用',request_id:'synthetic'}}}:{status:200,json:{data:{}}});});
  await action(page,'更正邮箱身份');const dialog=page.getByRole('dialog',{name:'更正邮箱身份',exact:true});
  await dialog.getByLabel('新工作邮箱',{exact:true}).fill('corrected@example.invalid');await dialog.getByLabel('身份核验说明',{exact:true}).fill('保留核验草稿');
  await dialog.getByRole('button',{name:'确认更正邮箱',exact:true}).click();await expect(dialog).toContainText('账号服务暂不可用');await expect(dialog.getByLabel('新工作邮箱',{exact:true})).toHaveValue('corrected@example.invalid');await expect(dialog.getByLabel('身份核验说明',{exact:true})).toHaveValue('保留核验草稿');
  expect(writes).toHaveLength(1);await dialog.getByRole('button',{name:'确认更正邮箱',exact:true}).click();await expect(dialog).not.toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
});

test('account save fields stay locked until the single write finishes',async({page})=>{
  await setup(page);let started,release;const writes=[];
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/admin/users/'+ids.second+'/email',async route=>{writes.push(route.request().postDataJSON());started();await gate;await route.fulfill({status:503,json:{error:{code:'unavailable',message:'合成保存失败',request_id:'synthetic'}}});});
  await action(page,'更正邮箱身份');const dialog=page.getByRole('dialog',{name:'更正邮箱身份',exact:true});
  await dialog.getByLabel('新工作邮箱',{exact:true}).fill('captured@example.invalid');await dialog.getByLabel('身份核验说明',{exact:true}).fill('提交的核验说明');
  try{
    await dialog.getByRole('button',{name:'确认更正邮箱',exact:true}).click();await pending;
    await expect(dialog.getByLabel('新工作邮箱',{exact:true})).toBeDisabled();await expect(dialog.getByLabel('身份核验说明',{exact:true})).toBeDisabled();
  }finally{release();}
  await expect(dialog).toContainText('合成保存失败');await expect(dialog.getByLabel('新工作邮箱',{exact:true})).toBeEnabled();expect(writes).toHaveLength(1);
});

for(const outcome of ['password','forbidden']){
  test('a late '+outcome+' reset reply cannot change an account dialog after browser navigation',async({page})=>{
    await setup(page);let started,release;const calls=[];
    const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/v1/admin/users/'+ids.second+'/reset-password',async route=>{
      calls.push(route.request().url());started();await gate;
      await route.fulfill(outcome==='password'?{status:200,json:{data:{temporary_password:'SYNTHETIC-OLD-PASSWORD',version:2}}}:{status:403,json:{error:{code:'forbidden',message:'旧账号授权失效',request_id:'synthetic'}}});
    });
    await page.getByRole('complementary').getByRole('link',{name:'全部部门成员',exact:true}).click();
    await action(page,'发放 / 重置密码');const old=page.getByRole('dialog',{name:'发放 / 重置临时密码',exact:true});
    const delivered=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/v1/admin/users/'+ids.second+'/reset-password');
    try{
      await old.getByRole('button',{name:'生成临时密码',exact:true}).click();await pending;
      await page.goBack();await expect(page).toHaveURL(new RegExp('/organization-management/'+ids.department+'/members$'));
      await action(page,'更正邮箱身份');const next=page.getByRole('dialog',{name:'更正邮箱身份',exact:true});
      await next.getByLabel('新工作邮箱',{exact:true}).fill('new-context@example.invalid');await next.getByLabel('身份核验说明',{exact:true}).fill('新窗口草稿');
    }finally{release();}
    await (await delivered).finished();await page.evaluate(()=>new Promise(resolve=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolve))));
    const next=page.getByRole('dialog',{name:'更正邮箱身份',exact:true});await expect(next).toBeVisible();await expect(next.getByLabel('新工作邮箱',{exact:true})).toHaveValue('new-context@example.invalid');
    await expect(next.getByRole('button',{name:'确认更正邮箱',exact:true})).toBeVisible();await expect(next).not.toContainText('旧账号授权失效');await expect(next.getByLabel('临时密码',{exact:true})).toHaveCount(0);await expect(next.getByRole('button',{name:'复制临时密码',exact:true})).toHaveCount(0);expect(calls).toHaveLength(1);
  });
}
