import {URL} from 'node:url';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response} from './fixtures.mjs';

const snapshot={id:'synthetic-complete-list',as_of:'2026-10-09T06:15:00.000Z',expires_at:'2026-10-09T06:20:00.000Z',updating:true};

for(const width of [1440,390])test(`session list shows the result cutoff and update state at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await mockPage(page);
 await page.route('**/api/v1/me/sessions*',async route=>{const result=response(route.request().url());result.body.data.snapshot=snapshot;await route.fulfill({status:200,json:result.body});});
 await page.goto('/my/sessions');const freshness=page.getByTestId('session-list-freshness');
 await expect(freshness).toContainText('数据截至');await expect(freshness).toContainText('北京时间');await expect(freshness).toContainText('数据更新中');
 await expect(freshness.locator('time')).toHaveAttribute('datetime',snapshot.as_of);await expect(freshness).not.toContainText(snapshot.id);await expect(freshness).toBeVisible();
});

test('explicit refresh of a published later page reads the newest first page and keeps applied filters and the search draft',async({page})=>{
 await page.setViewportSize({width:1440,height:700});await mockPage(page);
 let release,reached;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{reached=resolve;});
 const requests=[];const updated={...snapshot,id:'synthetic-next-complete-list',as_of:'2026-10-09T06:16:00.000Z',updating:false};
 await page.route('**/api/v1/me/sessions*',async route=>{
  const query=new URL(route.request().url()).searchParams;requests.push({cursor:query.get('cursor'),search:query.get('search'),channel:query.get('channel')});
  const index=requests.length;if(index===2){reached();await gate;}
  const result=response(route.request().url()),item=result.body.data.items[0];
  result.body.data.snapshot=index===1?snapshot:updated;
  result.body.data.items=Array.from({length:20},(_,row)=>({...item,id:`33333333-3333-4333-8333-${String(row).padStart(12,'0')}`,title:`${index===1?'旧版本':'最新首页'}会话 ${row+1}`}));
  result.body.data.total=index===1?40:41;result.body.data.has_more=true;result.body.data.next_cursor=index===1?'old-page-3':'fresh-page-2';
  await route.fulfill({status:200,json:result.body});
 });
 await page.goto('/my/sessions?page=2&cursor=old-page-2&search=applied&channel=custom');
 await expect(page.getByText('第 2 页 · 每页 20 条',{exact:true})).toBeVisible();await expect(page.getByText('旧版本会话 15',{exact:true})).toBeVisible();
 const search=page.getByRole('textbox',{name:'搜索会话',exact:true});await search.fill('尚未提交的草稿');
 try{
  await page.getByRole('button',{name:'刷新列表',exact:true}).click();await started;
  await expect(page.getByText('旧版本会话 15',{exact:true})).toHaveCount(0);await expect(page.getByTestId('session-list-freshness')).toHaveCount(0);await expect(search).toHaveValue('尚未提交的草稿');
  expect(requests).toEqual([{cursor:'old-page-2',search:'applied',channel:'custom'},{cursor:null,search:'applied',channel:'custom'}]);
  const query=new URL(page.url()).searchParams;expect(query.get('page')).toBeNull();expect(query.get('cursor')).toBeNull();expect(query.get('search')).toBe('applied');expect(query.get('channel')).toBe('custom');
  release();await expect(page.getByText('第 1 页 · 每页 20 条',{exact:true})).toBeVisible();await expect(page.getByText('最新首页会话 15',{exact:true})).toBeVisible();
  await expect(search).toHaveValue('尚未提交的草稿');await expect(page.getByTestId('session-list-freshness').locator('time')).toHaveAttribute('datetime',updated.as_of);expect(requests).toHaveLength(2);
 }finally{release();}
});

test('expired list snapshot clears the old version and recovers once to a fresh first page',async({page})=>{
 await mockPage(page);let requests=0;
 await page.route('**/api/v1/me/sessions*',async route=>{
  if(++requests===2){await route.fulfill({status:409,json:{error:{code:'session_snapshot_expired',message:'当前列表版本已过期',request_id:'synthetic'}}});return;}
  const result=response(route.request().url());result.body.data.snapshot={...snapshot,id:requests===1?'old':'fresh',updating:false};result.body.data.has_more=requests===1;result.body.data.next_cursor=requests===1?'old-version-page-2':null;
  result.body.data.items[0].title=requests===1?'旧版本合成会话':'新版本合成会话';await route.fulfill({status:200,json:result.body});
 });
 await page.goto('/my/sessions');await expect(page.getByText('旧版本合成会话',{exact:true})).toBeVisible();await page.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('版本已过期');await expect(page.getByText('旧版本合成会话',{exact:true})).toHaveCount(0);await expect(page.getByText('新版本合成会话',{exact:true})).toBeVisible();
 await expect(page.getByText('第 1 页 · 每页 20 条',{exact:true})).toBeVisible();expect(requests).toBe(3);
});
