import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids,period} from './fixtures.mjs';
import {URL} from 'node:url';

function job(id){return {job_id:id,status:'failed',phase:'verify',error_code:'storage_unavailable',user_id:ids.user,target_email:'lin.xiao@example.invalid',current_email:'lin.xiao@example.invalid',current_name:'林晓',from_at:period.from,to_at:period.to,created_at:period.from,progress:{deleted_events:0}};}
async function openCleanup(page){
  await page.goto(`/organization-management/${ids.department}/members`);await page.getByRole('button',{name:'更多',exact:true}).first().click();await page.getByRole('menuitem',{name:'清理使用数据',exact:true}).click();return page.getByRole('dialog',{name:'清理使用数据',exact:true});
}

test('cleanup preview separates both observation sources and treats sessions as affected rather than wholly deleted',async({page})=>{
  await mockPage(page);
  await page.route('**/api/v1/admin/cleanup/previews',route=>{
    const input=route.request().postDataJSON();
    return route.fulfill({status:200,json:{data:{preview_id:ids.second,target:{id:ids.user,email:'lin.xiao@example.invalid',name:'林晓'},range:{from:input.from,to:input.to},counts:{hook_events:12,project_observations:7,hook_project_observations:3,plugin_project_observations:4,project_links:5,sessions:2,declared_sessions:1,official_days:1},expires_at:new Date(Date.now()+600000).toISOString(),can_submit:true}}});
  });
  const dialog=await openCleanup(page);
  await dialog.getByLabel('开始时间（北京时间）',{exact:true}).fill('2024-01-01T00:00');
  await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();
  await expect(dialog.getByTestId('cleanup-hook-project-observation-count')).toHaveText('3');
  await expect(dialog.getByTestId('cleanup-plugin-project-observation-count')).toHaveText('4');
  await expect(dialog).toContainText('受影响会话');await expect(dialog).toContainText('不等于整会话删除');
  await expect(dialog).toContainText('所有采集来源');await expect(dialog).not.toContainText('滚动365天');
});

test('a late cleanup status reply cannot replace the task the user selected later',async({page})=>{
  await mockPage(page);let started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>route.fulfill({status:200,json:{data:{items:[job(ids.session),job(ids.second)],next_cursor:null}}}));
  await page.route(`**/api/v1/jobs/${ids.session}`,async route=>{started();await gate;await route.fulfill({status:200,json:{data:job(ids.session)}});});
  await page.route(`**/api/v1/jobs/${ids.second}`,route=>route.fulfill({status:200,json:{data:job(ids.second)}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(2);
  try{await dialog.locator('.cleanup-history li').nth(0).getByRole('button').click();await pending;await dialog.locator('.cleanup-history li').nth(1).getByRole('button').click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.second);}finally{release();}
  await page.waitForLoadState('networkidle');await expect(dialog.locator('.cleanup-progress')).toContainText(ids.second);await expect(dialog.locator('.cleanup-progress')).not.toContainText(ids.session);
});

test('selecting a different cleanup task clears the previous task confirmation while the new read is pending',async({page})=>{
  await mockPage(page);let started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>route.fulfill({status:200,json:{data:{items:[job(ids.session),job(ids.second)],next_cursor:null}}}));
  await page.route(`**/api/v1/jobs/${ids.session}`,route=>route.fulfill({status:200,json:{data:job(ids.session)}}));
  await page.route(`**/api/v1/jobs/${ids.second}`,async route=>{started();await gate;await route.fulfill({status:200,json:{data:job(ids.second)}});});
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await dialog.locator('.cleanup-history li').nth(0).getByRole('button').click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');await expect(dialog.getByRole('button',{name:'重新授权并继续',exact:true})).toBeEnabled();
  try{await dialog.locator('.cleanup-history li').nth(1).getByRole('button').click();await pending;await expect(dialog.locator('.cleanup-progress')).toHaveCount(0);await expect(dialog).toContainText('正在读取任务');}finally{release();}
  await expect(dialog.locator('.cleanup-progress')).toContainText(ids.second);await expect(dialog.getByLabel('确认目标邮箱',{exact:true})).toHaveValue('');await expect(dialog.getByRole('button',{name:'重新授权并继续',exact:true})).toBeDisabled();
});

test('temporary status failure keeps the same cleanup task and its confirmation as explicitly stale progress',async({page})=>{
  await mockPage(page);let fail=false;
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>route.fulfill({status:200,json:{data:{items:[job(ids.session)],next_cursor:null}}}));
  await page.route(`**/api/v1/jobs/${ids.session}`,route=>fail?route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'任务状态暂不可用'}}}):route.fulfill({status:200,json:{data:job(ids.session)}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await dialog.locator('.cleanup-history li').getByRole('button').click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');fail=true;await dialog.locator('.cleanup-history li').getByRole('button').click();
  await expect(dialog.getByRole('alert')).toContainText('上次进度');await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await expect(dialog.getByLabel('确认目标邮箱',{exact:true})).toHaveValue('lin.xiao@example.invalid');
  fail=false;await dialog.locator('.cleanup-history li').getByRole('button').click();await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('an unavailable status read after submission retains the same preview and idempotency key for an explicit retry',async({page})=>{
  await mockPage(page);const keys=[];
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>route.fulfill({status:200,json:{data:{items:[],next_cursor:null}}}));
  await page.route('**/api/v1/admin/cleanup/jobs',route=>{keys.push(route.request().headers()['idempotency-key']);return route.fulfill({status:202,json:{data:{job_id:ids.second,status:'queued'}}});});
  await page.route(`**/api/v1/jobs/${ids.second}`,route=>keys.length===1?route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'已接收任务的状态暂不可用'}}}):route.fulfill({status:200,json:{data:{...job(ids.second),status:'queued'}}}));
  const dialog=await openCleanup(page);await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');await dialog.getByRole('button',{name:'确认清理并提交任务',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('状态暂不可用');await expect(dialog.getByLabel('确认目标邮箱',{exact:true})).toHaveValue('lin.xiao@example.invalid');expect(keys).toHaveLength(1);
  await dialog.getByRole('button',{name:'确认清理并提交任务',exact:true}).click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.second);expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
});

test('denied cleanup history withdraws task details and the prior confirmation',async({page})=>{
  await mockPage(page);let denied=false;
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>denied?route.fulfill({status:403,json:{error:{code:'forbidden',message:'清理权限已撤销'}}}):route.fulfill({status:200,json:{data:{items:[job(ids.session)],next_cursor:null}}}));
  await page.route(`**/api/v1/jobs/${ids.session}`,route=>route.fulfill({status:200,json:{data:job(ids.session)}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await dialog.locator('.cleanup-history li').getByRole('button').click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');denied=true;await dialog.getByRole('button',{name:'刷新任务列表',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('清理权限已撤销');await expect(dialog.locator('.cleanup-history li')).toHaveCount(0);await expect(dialog.locator('.cleanup-progress')).toHaveCount(0);await expect(dialog.getByLabel('确认目标邮箱',{exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'生成清理预览',exact:true})).toBeDisabled();
});

test('creating a preview does not discard a pending history read for the same user',async({page})=>{
  await mockPage(page);let started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/admin/cleanup/jobs?*',async route=>{started();await gate;await route.fulfill({status:200,json:{data:{items:[job(ids.session)],next_cursor:null}}});});
  const dialog=await openCleanup(page);
  try{await pending;await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();await expect(dialog.getByRole('heading',{name:'确认目标与影响',exact:true})).toBeVisible();}finally{release();}
  await dialog.locator('.cleanup-history summary').click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);await expect(dialog.getByRole('button',{name:'刷新任务列表',exact:true})).toBeEnabled();
});

test('history refresh updates the loaded window without collapsing its older page or changing range drafts',async({page})=>{
  await mockPage(page);let done=false;const calls=[];
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>{
    const url=new URL(route.request().url()),next=url.searchParams.has('cursor');calls.push(url.searchParams.get('cursor'));
    const items=Array.from({length:20},(_,i)=>({...job(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i+(next?20:0)).padStart(12,'0')}`),status:done?'succeeded':'failed',phase:done?'complete':'verify'}));
    return route.fulfill({status:200,json:{data:{items,next_cursor:next?null:'history-next'}}});
  });
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(20);await dialog.getByRole('button',{name:'更早的任务',exact:true}).click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(40);
  const input=dialog.getByLabel('开始时间（北京时间）',{exact:true});await input.fill('2026-09-20T00:00');done=true;await dialog.getByRole('button',{name:'刷新任务列表',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新任务列表',exact:true})).toBeEnabled();
  await expect(dialog.locator('.cleanup-history li')).toHaveCount(40);expect((await dialog.locator('.cleanup-history li').allTextContents()).every(text=>text.includes('已完成'))).toBe(true);await expect(input).toHaveValue('2026-09-20T00:00');expect(calls).toEqual([null,'history-next',null,'history-next']);
});

test('an expired history cursor resets only history while preserving the chosen task and confirmation',async({page})=>{
  await mockPage(page);let expired=false;
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>{
    const cursor=new URL(route.request().url()).searchParams.get('cursor');
    if(expired&&cursor)return route.fulfill({status:400,json:{error:{code:'invalid_cursor',message:'历史游标已失效'}}});
    return route.fulfill({status:200,json:{data:{items:[job(ids.session)],next_cursor:'history-next'}}});
  });
  await page.route(`**/api/v1/jobs/${ids.session}`,route=>route.fulfill({status:200,json:{data:job(ids.session)}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await dialog.locator('.cleanup-history li').getByRole('button').click();await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');await expect(dialog.getByRole('button',{name:'刷新任务列表',exact:true})).toBeEnabled();expired=true;await dialog.getByRole('button',{name:'更早的任务',exact:true}).click();
  await expect(dialog).toContainText('任务列表分页已更新');await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);await expect(dialog.locator('.cleanup-progress')).toContainText(ids.session);await expect(dialog.getByLabel('确认目标邮箱',{exact:true})).toHaveValue('lin.xiao@example.invalid');
});

test('temporary history failure keeps its last result and is cleared by a successful read',async({page})=>{
  await mockPage(page);let fail=false;
  await page.route('**/api/v1/admin/cleanup/jobs?*',route=>fail?route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'历史暂不可用'}}}):route.fulfill({status:200,json:{data:{items:[job(ids.session)],next_cursor:null}}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);fail=true;await dialog.getByRole('button',{name:'刷新任务列表',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('上次任务列表');await expect(dialog.locator('.cleanup-history li')).toHaveCount(1);
  fail=false;await dialog.getByRole('button',{name:'刷新任务列表',exact:true}).click();await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('a failed initial history read is unavailable rather than proof of no submitted tasks',async({page})=>{
  await mockPage(page);await page.route('**/api/v1/admin/cleanup/jobs?*',route=>route.fulfill({status:503,json:{error:{code:'source_unavailable',message:'历史初次读取失败'}}}));
  const dialog=await openCleanup(page);await dialog.locator('.cleanup-history summary').click();await expect(dialog.getByRole('alert')).toContainText('历史初次读取失败');await expect(dialog).toContainText('任务列表尚未读取');await expect(dialog).not.toContainText('暂无已提交任务');
});
