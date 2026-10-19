import {URL} from 'node:url';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
const path='/organization-management/'+ids.department+'/members';
const membersApi='**/api/v1/departments/'+ids.department+'/members?*';
function members(url){
  const result=response(url),second=new URL(url).searchParams.has('cursor');
  Object.assign(result.body.data,{items:[{...result.body.data.items[0],display_name:second?'第二页已查询成员':'第一页已查询成员'}],total:9,has_more:!second,next_cursor:second?null:'members-second-page'});
  return result.body;
}
async function tail(page){
  await page.goto(path);await page.getByRole('textbox',{name:'搜索成员',exact:true}).fill('已查询');await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('main')).toContainText('第 2 页');
  await page.getByRole('textbox',{name:'搜索成员',exact:true}).fill('未提交草稿');
}
test('saving a member keeps its applied query, page and unsent search draft',async({page})=>{
  await mockPage(page);const calls=[];
  await page.route(membersApi,route=>{calls.push(new URL(route.request().url()));return route.fulfill({status:200,json:members(route.request().url())});});
  await page.route('**/api/v1/departments/'+ids.department+'/members/'+ids.user,route=>route.fulfill({status:200,json:{data:{}}}));
  await tail(page);await page.getByRole('row').filter({hasText:'第二页已查询成员'}).getByRole('button',{name:'编辑',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'编辑成员',exact:true});await dialog.getByLabel('姓名',{exact:true}).fill('第二页已查询成员更新');await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(page.getByRole('main')).toContainText('第 2 页');await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('未提交草稿');
  expect(calls.at(-1).searchParams.get('search')).toBe('已查询');expect(calls.at(-1).searchParams.get('cursor')).toBe('members-second-page');
});

test('a denied member write withdraws the protected form and invalidates older list reads',async({page})=>{
  await mockPage(page);
  await page.route(membersApi,route=>route.fulfill({status:200,json:members(route.request().url())}));
  await page.route('**/api/v1/departments/'+ids.department+'/members/'+ids.user,route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'成员维护授权失效',request_id:'synthetic'}}}));
  await page.goto(path);await page.getByRole('row').filter({hasText:'第一页已查询成员'}).getByRole('button',{name:'编辑',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'编辑成员',exact:true});await dialog.getByLabel('姓名',{exact:true}).fill('不能提交的草稿');await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.getByRole('main')).toContainText('成员维护授权失效');await expect(page.getByRole('main')).not.toContainText('第一页已查询成员');
});

for(const cancel of [false,true]){
  test((cancel?'cancelling':'creating')+' a transfer refreshes the valid member page without applying the draft',async({page})=>{
    await mockPage(page);const calls=[];let written=false;
    await page.route(membersApi,route=>{
      const url=new URL(route.request().url()),result=members(url.href);calls.push(url);
      if(cancel&&!written)result.data.items[0].scheduled_transfer={department_id:ids.second,department_name:'产品体验部',effective_at:'2030-01-01T00:00:00Z'};
      return route.fulfill({status:200,json:result});
    });
    await page.route('**/api/v1/members/'+ids.user+'/transfers',route=>{written=true;return route.fulfill({status:200,json:{data:{}}});});
    await tail(page);await page.getByRole('row').filter({hasText:'第二页已查询成员'}).getByRole('button',{name:'更多',exact:true}).click();
    if(cancel){await page.getByRole('menuitem',{name:'取消待生效调动',exact:true}).click();await page.getByRole('button',{name:'确认取消',exact:true}).click();}
    else{
      await page.getByRole('menuitem',{name:'跨部门调动',exact:true}).click();const dialog=page.getByRole('dialog',{name:'跨部门调动',exact:true});
      await dialog.getByRole('combobox',{name:'调入部门',exact:true}).press('ArrowDown');await page.getByRole('option',{name:'产品体验部',exact:true}).click();await dialog.getByRole('button',{name:'确认调动',exact:true}).click();await expect(dialog).not.toBeVisible();
    }
    await expect.poll(()=>written).toBe(true);await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
    expect(calls.at(-1).searchParams.get('search')).toBe('已查询');expect(calls.at(-1).searchParams.get('cursor')).toBe('members-second-page');
    await expect(page.getByRole('main')).toContainText('第 2 页');await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('未提交草稿');
  });
}

for(const outcome of ['success','forbidden']){
  test('a late member save '+outcome+' cannot close or replace the form in another department',async({page})=>{
    await mockPage(page);let started,release,finished;
    const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{finished=resolve;});
    await page.route('**/api/v1/departments',route=>{const result=response(route.request().url());result.body.data=result.body.data.map(item=>item.id===ids.second?{...item,name:'第二部门'}:item);return route.fulfill({status:200,json:result.body});});
    await page.route(membersApi,route=>route.fulfill({status:200,json:members(route.request().url())}));
    await page.route('**/api/v1/departments/'+ids.second+'/members?*',route=>{const result=members(route.request().url());result.data.items[0].department_id=ids.second;result.data.items[0].display_name='第二部门人员';return route.fulfill({status:200,json:result});});
    await page.route('**/api/v1/departments/'+ids.department+'/members/'+ids.user,async route=>{started();await gate;await route.fulfill(outcome==='success'?{status:200,json:{data:{}}}:{status:403,json:{error:{code:'forbidden',message:'旧部门授权失效',request_id:'synthetic'}}});finished();});
    await page.goto('/organization-management/'+ids.second+'/members');
    await page.getByRole('complementary').getByRole('link',{name:/^平台研发部/}).click();
    await page.getByRole('row').filter({hasText:'第一页已查询成员'}).getByRole('button',{name:'编辑',exact:true}).click();
    const delivered=page.waitForResponse(value=>value.request().method()==='PATCH'&&new URL(value.url()).pathname==='/api/v1/departments/'+ids.department+'/members/'+ids.user);
    try{
      const edit=page.getByRole('dialog',{name:'编辑成员',exact:true});await edit.getByLabel('姓名',{exact:true}).fill('旧部门提交');await edit.getByRole('button',{name:'保存',exact:true}).click();await pending;
      await page.goBack();await expect(page.getByRole('main')).toContainText('第二部门人员');await page.getByRole('button',{name:'添加成员',exact:true}).click();
      const form=page.getByRole('dialog',{name:'添加成员',exact:true});await form.getByLabel('姓名',{exact:true}).fill('新部门草稿');
    }finally{release();}
    await done;await (await delivered).finished();await page.evaluate(()=>new Promise(resolve=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolve))));const form=page.getByRole('dialog',{name:'添加成员',exact:true});await expect(form).toBeVisible();await expect(form.getByLabel('姓名',{exact:true})).toHaveValue('新部门草稿');await expect(page.getByRole('main')).not.toContainText('旧部门授权失效');
  });
}

test('confirmed import completion refreshes members without submitting the draft or resetting the valid page',async({page})=>{
  await mockPage(page);const calls=[];
  await page.route(membersApi,route=>{calls.push(new URL(route.request().url()));return route.fulfill({status:200,json:members(route.request().url())});});
  await page.route('**/api/v1/member-imports?department_id=*',route=>route.fulfill({status:200,json:{data:[{id:ids.second,source_name:'完成.csv',status:'succeeded',created_at:'2026-09-29T00:00:00Z',expires_at:'2030-01-01T00:00:00Z'}]}}));
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:{id:ids.second,department_id:ids.department,mode:'insert_only',source_name:'完成.csv',preview_hash:'a'.repeat(64),status:'succeeded',expires_at:'2030-01-01T00:00:00Z',can_submit:false,job_id:null,job:null,rows:[],counts:{create:0,update:0,skip:0,unchanged:0,error:0}}}}));
  await tail(page);const before=calls.length;await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});await dialog.getByRole('button',{name:'查看',exact:true}).click();await expect(dialog).toContainText('整批导入成功');await expect.poll(()=>calls.length).toBeGreaterThan(before);
  expect(calls.at(-1).searchParams.get('search')).toBe('已查询');expect(calls.at(-1).searchParams.get('cursor')).toBe('members-second-page');
  await expect(page.getByRole('main')).toContainText('第 2 页');await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('未提交草稿');
});

test('removing a member refreshes the same valid page without applying the search draft',async({page})=>{
  await mockPage(page);const calls=[];let removed=false;
  await page.route(membersApi,route=>{
    const url=new URL(route.request().url()),result=members(url.href);calls.push(url);
    if(url.searchParams.has('cursor')){
      const other={...result.data.items[0],user_id:ids.second,display_name:'仍在第二页已查询成员'};
      result.data.items=removed?[other]:[result.data.items[0],other];result.data.total=removed?9:10;
    }
    return route.fulfill({status:200,json:result});
  });
  await page.route('**/api/v1/departments/'+ids.department+'/members/'+ids.user,route=>{removed=true;return route.fulfill({status:204});});
  await tail(page);const row=page.getByRole('row').filter({hasText:'第二页已查询成员'}).filter({hasNotText:'仍在'});
  await row.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('menuitem',{name:'移除成员',exact:true}).click();await page.getByRole('button',{name:'确认移除',exact:true}).click();
  await expect(row).toHaveCount(0);await expect(page.getByRole('main')).toContainText('仍在第二页已查询成员');await expect(page.getByRole('main')).toContainText('第 2 页');
  await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('未提交草稿');
  expect(calls.at(-1).searchParams.get('search')).toBe('已查询');expect(calls.at(-1).searchParams.get('cursor')).toBe('members-second-page');
});
