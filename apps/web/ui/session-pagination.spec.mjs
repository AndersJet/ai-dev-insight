import {URL} from 'node:url';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';

async function pagingFixture(page){
  await mockPage(page);let expired='',recoveryAlsoFails=false;const calls=[];
  await page.route('**/api/v1/sessions/*/turns?*',async route=>{
    const url=new URL(route.request().url()),cursor=url.searchParams.get('cursor');calls.push({section:'turns',cursor});
    if(expired==='turns'&&cursor){await route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'目录游标失效',request_id:'synthetic'}}});return;}
    const result=response(url.href);Object.assign(result.body.data,{items:[{...result.body.data.items[0],turn_index:cursor?21:1,prompt_preview:cursor?'第二组提示':'第一组提示'}],snapshot:cursor?'signed-21':'signed-1',snapshot_version:'a'.repeat(64),has_more:!cursor,next_cursor:cursor?null:'turns-next'});
    await route.fulfill({status:200,json:result.body});
  });
  await page.route('**/api/v1/sessions/*/fragments?*',async route=>{
    const url=new URL(route.request().url()),section=url.searchParams.get('mode')==='raw'?'raw':'trace',cursor=url.searchParams.get('cursor');calls.push({section,cursor});
    if(expired===section&&(cursor||recoveryAlsoFails)){await route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'内容游标失效',request_id:'synthetic'}}});return;}
    const result=response(url.href),tail=section==='raw'?(cursor?'22':'21'):(cursor?'12':'11');
    Object.assign(result.body.data,{items:[{...result.body.data.items[0],event_id:`aaaaaaaa-aaaa-4aaa-8aaa-0000000000${tail}`,turn_index:Number(url.searchParams.get('turn')??1)}],has_more:!cursor,next_cursor:cursor?null:`${section}-next`});
    await route.fulfill({status:200,json:result.body});
  });
  await page.route('**/api/v1/sessions/*/events/*/content?*',route=>{
    const url=new URL(route.request().url()),event=url.pathname.split('/').at(-2),result=response(url.href),text=JSON.stringify({source_event:event});
    Object.assign(result.body.data,{event_id:event,text,total_chars:text.length,returned_chars:text.length,next_offset:null});
    return route.fulfill({status:200,json:result.body});
  });
  return {expire:(section,alsoFails=false)=>{expired=section;recoveryAlsoFails=alsoFails;},calls};
}

test('a failed raw paging recovery stops showing a loading state and leaves the trace available',async({page})=>{
  const fixture=await pagingFixture(page);await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');
  await page.getByRole('tab',{name:'原始事件',exact:true}).click();await expect(page.locator('.raw-event')).toHaveCount(1);const before=fixture.calls.length;fixture.expire('raw',true);
  await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'原始事件分页暂无法恢复'})).toBeVisible();await expect(page.getByText('正在读取事件…',{exact:true})).toHaveCount(0);await expect(page.getByRole('main')).toContainText('原始事件尚未读取');
  expect(fixture.calls.slice(before).filter(call=>call.section==='raw')).toHaveLength(2);
  await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');
});

test('a failed trace recovery is unavailable rather than evidence of an empty trace',async({page})=>{
  const fixture=await pagingFixture(page);await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');fixture.expire('trace',true);
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'轨迹分页暂无法恢复'})).toBeVisible();await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeEnabled();
  await expect(page.getByTestId('session-trace')).not.toContainText('当前未观测到可展示的轨迹');await expect(page.getByTestId('session-trace')).toContainText('轨迹尚未读取');await expect(page.getByTestId('session-trace')).not.toContainText('正在读取轨迹');
});

for(const section of ['turns','trace','raw']){
  test(`${section} refresh expiry only resets the dependent detail sections in the browser`,async({page})=>{
    const fixture=await pagingFixture(page);await page.goto(`/my/sessions/${ids.session}`);
    await page.getByRole('button',{name:'下一组',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');
    await page.getByRole('tab',{name:'原始事件',exact:true}).click();await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');
    await page.locator('.raw-event summary').click();await expect(page.locator('.raw-event')).toHaveJSProperty('open',true);await expect(page.locator('.raw-event')).toContainText('000000000022');
    fixture.expire(section);await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeEnabled();
    await expect(page.getByRole('tab',{name:'原始事件',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('main')).toContainText(`原始事件第 ${section==='raw'?1:2} 页`);
    await expect(page.locator('.raw-event')).toHaveJSProperty('open',section!=='raw');await expect(page.getByRole('main')).toContainText('分页已更新');
    await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:section==='turns'?'第 1 轮':'第 21 轮',exact:true})).toBeVisible();await expect(page.getByTestId('session-trace')).toContainText(`轨迹第 ${section==='raw'?2:1} 页`);
  });
}

for(const section of ['turns','trace','raw']){
  test(`${section} normal paging expiry preserves the independent reading state`,async({page})=>{
    const fixture=await pagingFixture(page);await page.goto(`/my/sessions/${ids.session}`);
    if(section!=='turns'){await page.getByRole('button',{name:'下一组',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();}
    if(section!=='trace'){await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');}
    await page.getByRole('tab',{name:'原始事件',exact:true}).click();
    if(section!=='raw'){await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');await page.locator('.raw-event summary').click();await expect(page.locator('.raw-event')).toHaveJSProperty('open',true);await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();}
    fixture.expire(section);await page.getByRole('button',{name:section==='turns'?'下一组':section==='trace'?'后段轨迹':'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('分页已更新');
    await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeEnabled();await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:section==='turns'?'第 1 轮':'第 21 轮',exact:true})).toBeVisible();await expect(page.getByTestId('session-trace')).toContainText(`轨迹第 ${section==='raw'?2:1} 页`);
    await page.getByRole('tab',{name:'原始事件',exact:true}).click();await expect(page.getByRole('main')).toContainText(`原始事件第 ${section==='raw'?1:2} 页`);if(section!=='raw')await expect(page.locator('.raw-event')).toHaveJSProperty('open',true);
  });
}

test('raw paging keeps an expanded payload and page number through a slow temporary failure',async({page})=>{
  await pagingFixture(page);let failing=false,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/sessions/*/fragments?*',async route=>{
    const url=new URL(route.request().url());if(failing&&url.searchParams.get('mode')==='raw'&&url.searchParams.has('cursor')){started();await gate;await route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'原始分页暂不可用',request_id:'synthetic'}}});return;}await route.fallback();
  });
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'原始事件',exact:true}).click();await page.locator('.raw-event summary').click();await expect(page.locator('.raw-event')).toContainText('000000000021');failing=true;
  try{
    await page.getByRole('button',{name:'下一页事件',exact:true}).click();await pending;await expect(page.getByRole('main')).toContainText('原始事件第 1 页');await expect(page.locator('.raw-event')).toHaveJSProperty('open',true);await expect(page.locator('.raw-event')).toContainText('000000000021');
  }finally{release();}
  await expect(page.getByRole('alert').filter({hasText:'原始分页暂不可用'})).toContainText('上次结果');await expect(page.getByRole('main')).toContainText('原始事件第 1 页');await expect(page.locator('.raw-event')).toHaveJSProperty('open',true);
  failing=false;await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');await expect(page.getByRole('alert').filter({hasText:'原始分页暂不可用'})).toHaveCount(0);
});

test('selecting raw events during the initial directory load finishes the chosen tab without another click',async({page})=>{
  const fixture=await pagingFixture(page);let started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/sessions/*/turns?*',async route=>{started();await gate;await route.fallback();},{times:1});
  try{
    await page.goto(`/my/sessions/${ids.session}`);await pending;await page.getByRole('tab',{name:'原始事件',exact:true}).click();await expect(page.getByText('正在读取事件…',{exact:true})).toBeVisible();
  }finally{release();}
  await expect(page.locator('.raw-event')).toHaveCount(1);await expect(page.getByRole('tab',{name:'原始事件',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText('正在读取事件…',{exact:true})).toHaveCount(0);expect(fixture.calls.filter(call=>call.section==='raw')).toHaveLength(1);
});
