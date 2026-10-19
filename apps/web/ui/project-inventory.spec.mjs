import {test,expect} from '../e2e/helpers/browser.js';
import {URL} from 'node:url';
/* global document, innerWidth */
import {mockPage,response,ids} from './fixtures.mjs';

const firstAddress='https://git.example.com/team/project.git',secondAddress='https://git.example.com/fork/project.git';
const repositoryCases=[
  {name:'matching legacy fetch and push addresses',remotes:[{name:'origin',direction:'fetch',address:firstAddress},{name:'origin',direction:'push',address:firstAddress}],addresses:[firstAddress]},
  {name:'multiple legacy repository addresses',remotes:[{name:'origin',direction:'fetch',address:firstAddress},{name:'origin',direction:'push',address:secondAddress}],addresses:[firstAddress,secondAddress]},
  {name:'shared legacy remote names',remotes:[{name:'origin',direction:'push',address:firstAddress},{name:'upstream',direction:'fetch',address:firstAddress}],addresses:[firstAddress]},
  {name:'unknown legacy addresses',remotes:[{name:'origin',direction:'fetch',address:null},{name:'upstream',direction:'push',address:null}],addresses:[null]},
  {name:'address-only repository records',remotes:[{address:firstAddress},{address:firstAddress},{address:secondAddress}],addresses:[firstAddress,secondAddress]},
];
for(const scenario of repositoryCases)test(`project Git association lists ${scenario.name} once per address`,async({page})=>{
  await mockPage(page);await page.route('**/api/v1/code-flow?*',route=>{
    const result=response(route.request().url()),remote=result.body.data.items[0].remotes[0];
    result.body.data.items[0].remotes=scenario.remotes.map(value=>({host:remote.host,source_tag:value.address===null?null:'department',reason:null,...value}));
    return route.fulfill({status:200,json:result.body});
  });
  await page.goto('/code-flow');const row=page.getByRole('row').filter({hasText:'/workspace/demo-project'});
  await expect(row).toHaveCount(1);const association=row.getByRole('cell').nth(2),addresses=association.locator('.remote');
  await expect(addresses).toHaveCount(scenario.addresses.length);
  for(const [index,address] of scenario.addresses.entries())await expect(addresses.nth(index).getByText(address??'地址未识别',{exact:true})).toHaveCount(1);
  await expect(association).not.toContainText(/origin|upstream|fetch|push/);
  await expect(association.getByText('部门',{exact:true})).toHaveCount(scenario.addresses.filter(address=>address!==null).length);
});

test('project queries and department changes ignore dates without overwriting the analytics period',async({page})=>{
  await mockPage(page);
  await page.route('**/api/v1/analytics/overview?*',route=>{const result=response(route.request().url()),query=new URL(route.request().url()).searchParams;if(query.has('from'))result.body.data.period={from:query.get('from'),to:query.get('to')};return route.fulfill({status:200,json:result.body});});
  const requests=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/v1/code-flow')requests.push(url);});
  await page.goto('/organization');await page.getByRole('radio',{name:'近30天',exact:true}).click();
  await expect(page.getByRole('radio',{name:'近30天',exact:true})).toHaveAttribute('aria-checked','true');const period=new URL(page.url()).searchParams;
  const sidebar=page.getByRole('complementary');await sidebar.getByRole('link',{name:'代码流向追踪',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();await expect(page.getByRole('radiogroup',{name:'日期范围',exact:true})).toHaveCount(0);
  await sidebar.getByRole('link',{name:/产品体验部/}).click();await expect(page.getByRole('button',{name:'刷新项目',exact:true})).toBeEnabled();
  expect(requests.length).toBeGreaterThanOrEqual(2);expect(requests.every(url=>!url.searchParams.has('from')&&!url.searchParams.has('to'))).toBe(true);
  await sidebar.getByRole('link',{name:'统计概览',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/organization/${ids.second}`));
  expect(new URL(page.url()).searchParams.get('from')).toBe(period.get('from'));expect(new URL(page.url()).searchParams.get('to')).toBe(period.get('to'));
});

test('project refresh retains temporary failures and draft search but removes denied content',async({page})=>{
  await mockPage(page);await page.goto('/code-flow');const row=page.getByRole('row').filter({hasText:'/workspace/demo-project'});await expect(row).toBeVisible();
  const search=page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true});await search.fill('未提交的草稿');
  await page.route('**/api/v1/code-flow?*',route=>route.fulfill({status:503,json:{error:{code:'unavailable',message:'项目暂不可用'}}}),{times:1});
  await page.getByRole('button',{name:'刷新项目',exact:true}).click();await expect(page.getByRole('main').getByRole('alert')).toContainText('当前为上次结果');await expect(row).toBeVisible();await expect(search).toHaveValue('未提交的草稿');
  await page.route('**/api/v1/code-flow?*',route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'项目读取权限已撤销'}}}),{times:1});
  await page.getByRole('button',{name:'刷新项目',exact:true}).click();await expect(page.getByRole('main').getByRole('alert')).toContainText('项目读取权限已撤销');await expect(row).toHaveCount(0);
});

test('submitting the same project query reads fresh data even when the URL does not change',async({page})=>{
  await mockPage(page);let reads=0;
  await page.route('**/api/v1/code-flow?*',route=>{const body=response(route.request().url()).body;body.data.items[0].name=++reads===1?'初始人员名称':'更新后的人员名称';return route.fulfill({status:200,json:body});});
  await page.goto('/code-flow?search=workspace');await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toContainText('初始人员名称');const url=page.url();await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toContainText('更新后的人员名称');await expect(page).toHaveURL(url);expect(reads).toBe(2);
});

test('project cursor recovery preserves applied search and its unapplied draft',async({page})=>{
  await mockPage(page);let count=0;const searches=[];
  await page.route('**/api/v1/code-flow?*',route=>{
    const url=new URL(route.request().url());searches.push(url.searchParams.get('search'));count++;
    if(count===2)return route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'分页过期'}}});
    const result=response(route.request().url());result.body.data.total=21;return route.fulfill({status:200,json:result.body});
  });
  await page.goto('/code-flow?search=applied&cursor=expired&page=2');await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();
  const search=page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true});await search.fill('保留草稿');await page.getByRole('button',{name:'刷新项目',exact:true}).click();
  await expect(page.getByText('第 1 页 · 每页20个项目',{exact:true})).toBeVisible();await expect(page.getByRole('alert')).toContainText('项目分页已更新');await expect(search).toHaveValue('保留草稿');expect(searches).toEqual(['applied','applied','applied']);
});

test('refreshing an empty project tail returns to the first page without submitting the search draft',async({page})=>{
  await mockPage(page);let gone=false;const calls=[];
  await page.route('**/api/v1/code-flow?*',route=>{
    const url=new URL(route.request().url());calls.push({search:url.searchParams.get('search'),cursor:url.searchParams.get('cursor')});const result=response(url.href),row=result.body.data.items[0];
    result.body.data.total=gone?20:21;result.body.data.items=url.searchParams.has('cursor')?(gone?[]:[{...row,workspace:'/workspace/tail-project'}]):[{...row,id:ids.user,workspace:'/workspace/first-project'}];return route.fulfill({status:200,json:result.body});
  });
  await page.goto('/code-flow?search=applied&cursor=tail&page=2');await expect(page.getByRole('row').filter({hasText:'/workspace/tail-project'})).toBeVisible();
  const search=page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true});await search.fill('未提交草稿');gone=true;await page.getByRole('button',{name:'刷新项目',exact:true}).click();
  await expect(page.getByText('第 1 页 · 每页20个项目',{exact:true})).toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/first-project'})).toBeVisible();await expect(page.getByRole('alert')).toContainText('项目分页已更新');await expect(search).toHaveValue('未提交草稿');expect(calls).toEqual([{search:'applied',cursor:'tail'},{search:'applied',cursor:'tail'},{search:'applied',cursor:null}]);
});

test('failed Git probes show dated prior confirmation without inventing personal ownership',async({page})=>{
  await mockPage(page);await page.route('**/api/v1/code-flow?*',route=>{const result=response(route.request().url());Object.assign(result.body.data.items[0],{state:'failed',reason:'timeout',unconfirmed:true,confirmed_state:'no_remote',remotes:[]});return route.fulfill({status:200,json:result.body});});
  await page.goto('/code-flow');const row=page.getByRole('row').filter({hasText:'/workspace/demo-project'});await expect(row).toContainText('探测失败');await expect(row).toContainText('上次成功观测，本次未确认');await expect(row).toContainText('Git无远端');await expect(row.getByText('个人',{exact:true})).toHaveCount(0);
});

test('an unavailable selected project is withdrawn without clearing unrelated project rows',async({page})=>{
  await mockPage(page);await page.route('**/api/v1/code-flow?*',route=>{const result=response(route.request().url()),first=result.body.data.items[0];result.body.data.items.push({...first,id:ids.user,workspace:'/workspace/retained-project',git_root:'/workspace/retained-project'});result.body.data.total=2;return route.fulfill({status:200,json:result.body});});
  await page.route(`**/api/v1/code-flow/${ids.session}/sessions?*`,route=>route.fulfill({status:404,json:{error:{code:'not_found',message:'项目观测已不可用'}}}));
  await page.goto('/code-flow');await page.getByRole('row').filter({hasText:'/workspace/demo-project'}).getByRole('button',{name:'关联会话',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText:'/workspace/retained-project'})).toBeVisible();
  await expect(page.getByRole('dialog',{name:'项目关联会话',exact:true})).not.toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('项目观测已不可用');
});

test('an unavailable last project on a tail page restores the first page and preserves its department and draft',async({page})=>{
  await mockPage(page);const calls=[];
  await page.route('**/api/v1/code-flow?*',route=>{const url=new URL(route.request().url());calls.push(url);const result=response(url.href),row=result.body.data.items[0];result.body.data.total=url.searchParams.has('cursor')?21:20;result.body.data.items=[{...row,id:url.searchParams.has('cursor')?ids.session:ids.user,workspace:url.searchParams.has('cursor')?'/workspace/tail-project':'/workspace/first-project'}];return route.fulfill({status:200,json:result.body});});
  await page.route(`**/api/v1/code-flow/${ids.session}/sessions?*`,route=>route.fulfill({status:404,json:{error:{code:'not_found',message:'项目观测已不可用'}}}));
  await page.goto(`/code-flow?dept=${ids.department}&search=applied&cursor=tail&page=2`);await expect(page.getByRole('row').filter({hasText:'/workspace/tail-project'})).toBeVisible();const search=page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true});await search.fill('未提交的尾页草稿');
  await page.getByRole('row').filter({hasText:'/workspace/tail-project'}).getByRole('button',{name:'关联会话',exact:true}).click();await expect(page.getByText('第 1 页 · 每页20个项目',{exact:true})).toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/first-project'})).toBeVisible();await expect(page.getByRole('dialog',{name:'项目关联会话',exact:true})).not.toBeVisible();
  await expect(search).toHaveValue('未提交的尾页草稿');await expect(page.getByRole('main').getByRole('alert')).toContainText('项目观测已不可用');expect(new URL(page.url()).searchParams.get('dept')).toBe(ids.department);expect(calls.map(url=>url.searchParams.get('search'))).toEqual(['applied','applied']);expect(calls.at(-1).searchParams.has('cursor')).toBe(false);
});

test('project details remain usable at narrow widths without expanding the whole document',async({page})=>{
  await mockPage(page);await page.goto('/code-flow');await expect(page.getByRole('button',{name:'关联会话',exact:true})).toBeVisible();
  for(const width of [1440,1024,768]){
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    const button=page.getByRole('button',{name:'关联会话',exact:true});await button.scrollIntoViewIfNeeded();await button.click();
    const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog.getByRole('link',{name:'查看近期内容',exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(dialog).not.toBeVisible();
  }
});
