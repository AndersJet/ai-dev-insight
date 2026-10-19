import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
import {URL} from 'node:url';

const endpoint=`**/api/v1/code-flow/${ids.session}/sessions?*`;
function associations(url){
  const body=response(url).body,second=new URL(url).searchParams.has('cursor');
  Object.assign(body.data,{total:21,items:[{...body.data.items[0],hook_session_id:second?'关联尾页会话':'关联首页会话'}],next_cursor:second?null:'associations-next'});return body;
}

test('an empty association tail restores only that dialog page and keeps the project query',async({page})=>{
  await mockPage(page);let empty=false;const calls=[];
  await page.route(endpoint,route=>{const url=new URL(route.request().url());calls.push(url);const body=associations(url.href);if(empty&&url.searchParams.has('cursor'))Object.assign(body.data,{items:[],total:20});return route.fulfill({status:200,json:body});});
  await page.goto(`/code-flow?search=applied&cursor=project-page-2&page=2&project=${ids.session}&assoc_cursor=associations-next&assoc_page=2`);
  const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText('关联尾页会话');empty=true;await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();
  await expect(dialog).toContainText('关联首页会话');await expect(dialog).toContainText('第 1 页');await expect(dialog.getByRole('alert')).toContainText('关联会话分页已更新');
  const url=new URL(page.url());expect(url.searchParams.get('cursor')).toBe('project-page-2');expect(url.searchParams.get('page')).toBe('2');expect(url.searchParams.get('search')).toBe('applied');expect(url.searchParams.get('project')).toBe(ids.session);expect(url.searchParams.has('assoc_cursor')).toBe(false);
  expect(calls.map(url=>url.searchParams.get('cursor'))).toEqual(['associations-next','associations-next',null]);
});

test('recovery quarantine from an association read withdraws the containing project list',async({page})=>{
  await mockPage(page);let quarantined=false;
  await page.route(endpoint,route=>quarantined?route.fulfill({status:503,json:{error:{code:'recovery_quarantined',message:'数据恢复隔离中',request_id:'synthetic'}}}):route.fulfill({status:200,json:associations(route.request().url())}));
  await page.goto(`/code-flow?project=${ids.session}`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText('关联首页会话');quarantined=true;await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toHaveCount(0);await expect(page.getByRole('main').getByRole('alert')).toContainText('数据恢复隔离中');
});

test('a failed initial association query is not shown as an empty result',async({page})=>{
  await mockPage(page);await page.route(endpoint,route=>route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'关联读取暂不可用',request_id:'synthetic'}}}));
  await page.goto(`/code-flow?project=${ids.session}`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog.getByRole('alert')).toContainText('关联读取暂不可用');await expect(dialog).not.toContainText('当前没有有效关联会话');await expect(dialog).toContainText('关联会话尚未读取');
});

test('association refresh retains its page during a slow temporary failure',async({page})=>{
  await mockPage(page);let calls=0,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(endpoint,async route=>{if(++calls===2){started();await gate;await route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'关联刷新暂不可用',request_id:'synthetic'}}});return;}await route.fulfill({status:200,json:associations(route.request().url())});});
  await page.goto(`/code-flow?project=${ids.session}&assoc_cursor=associations-next&assoc_page=2`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText('关联尾页会话');
  try{await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();await pending;await expect(dialog).toContainText('关联尾页会话');await expect(dialog).toContainText('第 2 页');}finally{release();}
  await expect(dialog.getByRole('alert')).toContainText('上次结果');await expect(dialog).toContainText('关联尾页会话');await expect(dialog).toContainText('第 2 页');
});

for(const outcome of ['success','not_found']){
  test(`a late ${outcome} association response cannot affect a different selected project`,async({page})=>{
    await mockPage(page);let calls=0,started,release;
    const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/v1/code-flow?*',route=>{const body=response(route.request().url()).body;body.data.items.push({...body.data.items[0],id:ids.user,workspace:'/workspace/second-project'});body.data.total=2;return route.fulfill({status:200,json:body});});
    await page.route(endpoint,async route=>{if(++calls===2){started();await gate;if(outcome==='not_found'){await route.fulfill({status:404,json:{error:{code:'not_found',message:'旧项目已失效'}}});return;}}await route.fulfill({status:200,json:associations(route.request().url())});});
    await page.route(`**/api/v1/code-flow/${ids.user}/sessions?*`,route=>{const body=associations(route.request().url());body.data.project_id=ids.user;body.data.items[0].hook_session_id='新项目的会话';return route.fulfill({status:200,json:body});});
    await page.goto(`/code-flow?project=${ids.session}`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText('关联首页会话');
    try{await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();await pending;await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(dialog).not.toBeVisible();await page.getByRole('row').filter({hasText:'/workspace/second-project'}).getByRole('button',{name:'关联会话',exact:true}).click();await expect(dialog).toContainText('新项目的会话');}finally{release();}
    await page.waitForLoadState('networkidle');await expect(dialog).toContainText('新项目的会话');await expect(dialog).not.toContainText('关联首页会话');await expect(page.getByRole('row').filter({hasText:'/workspace/second-project'})).toBeVisible();expect(new URL(page.url()).searchParams.get('project')).toBe(ids.user);
  });
}

test('leaving for session details during association refresh is not undone by cursor recovery',async({page})=>{
  await mockPage(page);let calls=0,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(endpoint,async route=>{if(++calls===2){started();await gate;await route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'旧关联游标失效'}}});return;}await route.fulfill({status:200,json:associations(route.request().url())});});
  await page.goto(`/code-flow?project=${ids.session}&assoc_cursor=associations-next&assoc_page=2`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText('关联尾页会话');
  try{await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();await pending;await dialog.getByRole('link',{name:'查看近期内容',exact:true}).click();await expect(page.getByRole('heading',{name:'会话详情',exact:true})).toBeVisible();}finally{release();}
  await page.waitForLoadState('networkidle');await expect(page).toHaveURL(new RegExp(`/all/sessions/${ids.session}`));await expect(dialog).not.toBeVisible();await expect(page.getByRole('heading',{name:'会话详情',exact:true})).toBeVisible();
});
