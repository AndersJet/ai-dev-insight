import {URL} from 'node:url';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';

const membersPath=`/organization-management/${ids.department}/members`;
const membersApi=`**/api/v1/departments/${ids.department}/members?*`;

function memberResult(url){
  const result=response(url),second=new URL(url).searchParams.has('cursor');
  result.body.data={...result.body.data,items:[{...result.body.data.items[0],display_name:second?'第二页已查询成员':'第一页已查询成员'}],total:9,has_more:!second,next_cursor:second?null:'members-second-page'};
  return result;
}

test('member refresh preserves the applied search, current page and unsent search draft',async({page})=>{
  await mockPage(page);const calls=[];let hold=false,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(membersApi,async route=>{const url=route.request().url();calls.push(new URL(url));if(hold){started();await gate;}await route.fulfill({status:200,json:memberResult(url).body});});
  await page.goto(membersPath);const search=page.getByRole('textbox',{name:'搜索成员',exact:true});await search.fill('已查询');await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('main')).toContainText('第二页已查询成员');
  await search.fill('未提交草稿');hold=true;
  try{
    await page.getByRole('button',{name:'刷新',exact:true}).click();await pending;
    expect(calls.at(-1).searchParams.get('search')).toBe('已查询');expect(calls.at(-1).searchParams.get('cursor')).toBe('members-second-page');
    await expect(page.getByRole('main')).toContainText('第二页已查询成员');await expect(page.getByRole('main')).toContainText('第 2 页');await expect(search).toHaveValue('未提交草稿');
  }finally{release();}
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();await expect(page.getByRole('main')).toContainText('第 2 页');await expect(search).toHaveValue('未提交草稿');
});

test('member refresh labels retained results on temporary failure and removes them when access is denied',async({page})=>{
  await mockPage(page);let failure=0;
  await page.route(membersApi,route=>failure?route.fulfill({status:failure,json:{error:{code:failure===403?'forbidden':'unavailable',message:failure===403?'无权读取此部门':'服务暂时不可用',request_id:'synthetic'}}}):route.fulfill({status:200,json:memberResult(route.request().url()).body}));
  await page.goto(membersPath);await expect(page.getByRole('main')).toContainText('第一页已查询成员');
  failure=503;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('main')).toContainText('显示上次结果');await expect(page.getByRole('main')).toContainText('第一页已查询成员');
  failure=403;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('main')).toContainText('无权读取此部门');await expect(page.getByRole('main')).not.toContainText('第一页已查询成员');await expect(page.getByRole('main')).not.toContainText('显示上次结果');
});

test('an expired member cursor recovers only the member list and keeps the search draft',async({page})=>{
  await mockPage(page);let expired=false;const calls=[];
  await page.route(membersApi,route=>{const url=new URL(route.request().url());calls.push(url);return expired&&url.searchParams.has('cursor')?route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'游标已失效',request_id:'synthetic'}}}):route.fulfill({status:200,json:memberResult(url.href).body});});
  await page.goto(membersPath);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('main')).toContainText('第 2 页');
  const search=page.getByRole('textbox',{name:'搜索成员',exact:true});await search.fill('保留的草稿');expired=true;
  await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('main')).toContainText('已恢复第一页');
  await expect(page.getByRole('main')).toContainText('第一页已查询成员');await expect(page.getByRole('main')).toContainText('第 1 页');await expect(search).toHaveValue('保留的草稿');
  expect(calls.at(-1).searchParams.has('cursor')).toBe(false);expect(calls.at(-1).searchParams.has('search')).toBe(false);
  await expect(page.getByRole('region',{name:'采纳进度',exact:true})).toContainText('累计采纳率');
});

test('a failed member page request keeps the displayed page number aligned with its retained rows',async({page})=>{
  await mockPage(page);let failing=true;
  await page.route(membersApi,route=>failing&&new URL(route.request().url()).searchParams.has('cursor')?route.fulfill({status:503,json:{error:{code:'unavailable',message:'分页暂不可用',request_id:'synthetic'}}}):route.fulfill({status:200,json:memberResult(route.request().url()).body}));
  await page.goto(membersPath);await expect(page.getByRole('main')).toContainText('第一页已查询成员');await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('main')).toContainText('分页暂不可用');await expect(page.getByRole('main')).toContainText('显示上次结果');await expect(page.getByRole('main')).toContainText('第 1 页');await expect(page.getByRole('main')).toContainText('第一页已查询成员');
  failing=false;await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('main')).toContainText('第 2 页');await expect(page.getByRole('main')).toContainText('第二页已查询成员');
});

test('a new member query clears the old query and cannot be overwritten by its late refresh',async({page})=>{
  await mockPage(page);let hold=false,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(membersApi,async route=>{
    const url=route.request().url();
    if(new URL(url).searchParams.get('search')==='新的查询'){await route.fulfill({status:503,json:{error:{code:'unavailable',message:'新查询暂不可用',request_id:'synthetic'}}});return;}
    if(hold){started();await gate;}
    await route.fulfill({status:200,json:memberResult(url).body});
  });
  await page.goto(membersPath);await expect(page.getByRole('main')).toContainText('第一页已查询成员');hold=true;
  try{
    await page.getByRole('button',{name:'刷新',exact:true}).click();await pending;
    await page.getByRole('textbox',{name:'搜索成员',exact:true}).fill('新的查询');await page.getByRole('button',{name:'查询',exact:true}).click();
    await expect(page.getByRole('main')).toContainText('新查询暂不可用');await expect(page.getByRole('main')).not.toContainText('第一页已查询成员');await expect(page.getByRole('main')).not.toContainText('显示上次结果');
  }finally{release();}
  await expect(page.getByRole('main')).toContainText('新查询暂不可用');await expect(page.getByRole('main')).not.toContainText('第一页已查询成员');
});

test('member refresh recovers an emptied tail page without applying the search draft',async({page})=>{
  await mockPage(page);let removed=false;
  await page.route(membersApi,route=>{const result=memberResult(route.request().url());if(removed){Object.assign(result.body.data,{total:1,has_more:false,next_cursor:null});if(new URL(route.request().url()).searchParams.has('cursor'))result.body.data.items=[];}return route.fulfill({status:200,json:result.body});});
  await page.goto(membersPath);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('main')).toContainText('第二页已查询成员');
  await page.getByRole('textbox',{name:'搜索成员',exact:true}).fill('未提交尾页草稿');removed=true;await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('main')).toContainText('已恢复第一页');await expect(page.getByRole('main')).toContainText('第一页已查询成员');await expect(page.getByRole('main')).toContainText('共 1 项 · 第 1 页');await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('未提交尾页草稿');
});

test('department directory refresh labels stale data and clears both table and sidebar after denial',async({page})=>{
  await mockPage(page);let failure=0;
  await page.route('**/api/v1/departments',route=>failure?route.fulfill({status:failure,json:{error:{code:failure===403?'forbidden':'unavailable',message:failure===403?'部门目录已不可访问':'目录暂不可用',request_id:'synthetic'}}}):route.fulfill({status:200,json:response(route.request().url()).body}));
  await page.goto('/organization-management/departments');const table=page.getByRole('table',{name:'一级部门列表',exact:true});await expect(table.getByRole('link',{name:'平台研发部',exact:true})).toBeVisible();
  failure=503;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('main')).toContainText('显示上次结果');await expect(table.getByRole('link',{name:'平台研发部',exact:true})).toBeVisible();
  failure=403;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('main')).toContainText('部门目录已不可访问');await expect(table.getByRole('link',{name:'平台研发部',exact:true})).toHaveCount(0);await expect(page.getByRole('complementary').getByRole('link',{name:'平台研发部',exact:true})).toHaveCount(0);await expect(page.getByRole('main')).not.toContainText('显示上次结果');
});
