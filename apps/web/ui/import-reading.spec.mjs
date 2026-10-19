import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,ids} from './fixtures.mjs';
import {URL} from 'node:url';
import {Buffer} from 'node:buffer';
const path='/organization-management/'+ids.department+'/members';
const historyApi='**/api/v1/member-imports?department_id=*';
const history=(name,id=ids.second)=>({data:[{id,source_name:name,status:'previewed',created_at:'2026-09-29T00:00:00Z',expires_at:'2030-01-01T00:00:00Z'}]});
const batch=(id=ids.second,count=21)=>({id,department_id:ids.department,mode:'insert_only',source_name:'已选任务.csv',preview_hash:'a'.repeat(64),status:'previewed',expires_at:'2030-01-01T00:00:00Z',can_submit:true,job_id:null,job:null,counts:{create:count,update:0,skip:0,unchanged:0,error:0},rows:Array.from({length:count},(_,i)=>({row:i+2,email:'import'+i+'@example.invalid',display_name:'导入人员'+i,eligible:true,eligibility_from:'2026-09-29',eligibility_to:null,action:'create',changes:[],errors:[],before:null}))});

test('reopening member import cannot be overwritten by the previous dialog history response',async({page})=>{
  await mockPage(page);let calls=0,started,release,finished;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{finished=resolve;});
  await page.route(historyApi,async route=>{
    if(++calls===1){started();await gate;await route.fulfill({status:200,json:history('旧窗口.csv')});finished();}
    else await route.fulfill({status:200,json:history('新窗口.csv')});
  });
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();await pending;
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  try{
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).not.toBeVisible();
    await page.getByRole('button',{name:'批量导入',exact:true}).click();await expect(dialog).toContainText('新窗口.csv');
  }finally{release();}
  await done;await expect(dialog).toContainText('新窗口.csv');await expect(dialog).not.toContainText('旧窗口.csv');
});

test('confirmed import success updates members without waiting for its independent history read',async({page})=>{
  await mockPage(page);let histories=0,started,release;const reads=[];
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/departments/'+ids.department+'/members?*',async route=>{reads.push(route.request().url());await route.fallback();});
  await page.route(historyApi,async route=>{if(++histories===2){started();await gate;}await route.fulfill({status:200,json:history('完成.csv')});});
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:{...batch(),status:'succeeded',can_submit:false}}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();const before=reads.length;
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  try{
    await dialog.getByRole('button',{name:'查看',exact:true}).click();await pending;await expect(dialog).toContainText('整批导入成功');
    await expect.poll(()=>reads.length).toBeGreaterThan(before);
  }finally{release();}
});

test('a late preview history reply cannot unlock an import submission still in flight',async({page})=>{
  await mockPage(page);let histories=0,historyStarted,historyRelease,historyFinished,commitStarted,commitRelease;
  const pendingHistory=new Promise(resolve=>{historyStarted=resolve;}),historyGate=new Promise(resolve=>{historyRelease=resolve;}),historyDone=new Promise(resolve=>{historyFinished=resolve;});
  const pendingCommit=new Promise(resolve=>{commitStarted=resolve;}),commitGate=new Promise(resolve=>{commitRelease=resolve;});
  await page.route(historyApi,async route=>{if(++histories===2){historyStarted();await historyGate;await route.fulfill({status:200,json:history('预览.csv')});historyFinished();}else await route.fulfill({status:200,json:history('预览.csv')});});
  await page.route('**/api/v1/member-imports/preview?*',route=>route.fulfill({status:200,json:{data:batch()}}));
  await page.route('**/api/v1/member-imports/'+ids.second+'/commit',async route=>{commitStarted();await commitGate;await route.fulfill({status:503,json:{error:{code:'unavailable',message:'合成提交失败',request_id:'synthetic'}}});});
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true}),confirm=dialog.getByRole('button',{name:'确认整批导入',exact:true});
  try{
    await dialog.getByLabel('选择成员文件',{exact:true}).setInputFiles({name:'预览.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nperson@example.invalid,合成人员')});await pendingHistory;await expect(confirm).toBeEnabled();
    await confirm.click();await pendingCommit;historyRelease();await historyDone;
    await expect(dialog.getByRole('button',{name:'刷新导入记录',exact:true})).toBeEnabled();await expect(confirm).toBeDisabled();
    await expect(dialog.getByRole('button',{name:'重新选择文件',exact:true})).toBeDisabled();
  }finally{historyRelease();commitRelease();}
  await expect(dialog).toContainText('合成提交失败');await expect(confirm).toBeEnabled();
});

test('temporary import submission failure retains the preview and reuses its key only on explicit retry',async({page})=>{
  await mockPage(page);const keys=[];
  await page.route(historyApi,route=>route.fulfill({status:200,json:history('预览.csv')}));
  await page.route('**/api/v1/member-imports/preview?*',route=>route.fulfill({status:200,json:{data:batch()}}));
  await page.route('**/api/v1/member-imports/'+ids.second+'/commit',route=>{
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill(keys.length===1?{status:503,json:{error:{code:'unavailable',message:'提交暂不可用',request_id:'synthetic'}}}:{status:202,json:{data:{job_id:ids.session}}});
  });
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:{...batch(),status:'queued',can_submit:false}}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  await dialog.getByLabel('选择成员文件',{exact:true}).setInputFiles({name:'预览.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nperson@example.invalid,合成人员')});
  const confirm=dialog.getByRole('button',{name:'确认整批导入',exact:true});await expect(confirm).toBeEnabled();
  await dialog.getByRole('button',{name:'下一页',exact:true}).click();await confirm.click();await expect(dialog).toContainText('提交暂不可用');await expect(confirm).toBeEnabled();await expect(dialog).toContainText('预览第 2 页');
  await dialog.getByRole('button',{name:'刷新导入记录',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新导入记录',exact:true})).toBeEnabled();expect(keys).toHaveLength(1);
  await confirm.click();await expect(dialog).toContainText('已提交，正在后台处理');expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
});

test('a late import commit reply cannot queue the preview in a reopened dialog',async({page})=>{
  await mockPage(page);let previews=0,started,release,finished;const taskReads=[];
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{finished=resolve;});
  await page.route(historyApi,route=>route.fulfill({status:200,json:history('历史.csv')}));
  await page.route('**/api/v1/member-imports/preview?*',route=>{const value=batch(++previews===1?ids.second:ids.session,1);value.rows[0].display_name=previews===1?'旧预览人员':'新预览人员';return route.fulfill({status:200,json:{data:value}});});
  await page.route('**/api/v1/member-imports/'+ids.second+'/commit',async route=>{started();await gate;await route.fulfill({status:202,json:{data:{job_id:ids.second}}});finished();});
  await page.route('**/api/v1/member-imports/'+ids.second,async route=>{taskReads.push(route.request().url());await route.fallback();});
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true}),file=dialog.getByLabel('选择成员文件',{exact:true});
  try{
    await file.setInputFiles({name:'旧.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nold@example.invalid,旧人员')});await expect(dialog).toContainText('旧预览人员');
    await dialog.getByRole('button',{name:'确认整批导入',exact:true}).click();await pending;
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).not.toBeVisible();await page.getByRole('button',{name:'批量导入',exact:true}).click();
    await file.setInputFiles({name:'新.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nnew@example.invalid,新人员')});await expect(dialog).toContainText('新预览人员');
  }finally{release();}
  await done;await expect(dialog.getByRole('button',{name:'确认整批导入',exact:true})).toBeEnabled();await expect(dialog).toContainText('新预览人员');await expect(dialog).not.toContainText('已提交，正在后台处理');expect(taskReads).toHaveLength(0);
});

test('a ready preview remains usable while its independent history refresh is still pending',async({page})=>{
  await mockPage(page);let historyCalls=0,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route(historyApi,async route=>{if(++historyCalls===2){started();await gate;}await route.fulfill({status:200,json:history('预览.csv')});});
  await page.route('**/api/v1/member-imports/preview?*',route=>route.fulfill({status:200,json:{data:batch()}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  try{
    await dialog.getByLabel('选择成员文件',{exact:true}).setInputFiles({name:'预览.csv',mimeType:'text/csv',buffer:Buffer.from('工作邮箱,姓名\nperson@example.invalid,合成人员')});await pending;
    await expect(dialog).toContainText('导入人员0');await expect(dialog.getByRole('button',{name:'确认整批导入',exact:true})).toBeEnabled();
    await expect(dialog.getByRole('button',{name:'重新选择文件',exact:true})).toBeEnabled();
    await dialog.getByRole('button',{name:'下一页',exact:true}).click();await expect(dialog).toContainText('预览第 2 页');
  }finally{release();}
  await expect(dialog).toContainText('预览第 2 页');await expect(dialog).toContainText('导入人员20');
});

test('a failed selected import refresh retains the preview page, labels it, and removes it when unavailable',async({page})=>{
  await mockPage(page);let failure=0;
  await page.route(historyApi,route=>route.fulfill({status:200,json:history('预览.csv')}));
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill(failure?{status:failure,json:{error:{code:failure===404?'not_found':'unavailable',message:failure===404?'导入记录已不可用':'任务暂不可用',request_id:'synthetic'}}}:{status:200,json:{data:batch()}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true}),view=dialog.getByRole('button',{name:'查看',exact:true});
  await view.click();await expect(dialog).toContainText('导入人员0');await dialog.getByRole('button',{name:'下一页',exact:true}).click();await expect(dialog).toContainText('预览第 2 页');await expect(dialog).toContainText('导入人员20');
  failure=503;await view.click();await expect(dialog).toContainText('任务暂不可用');await expect(dialog).toContainText('显示上次任务结果');
  await expect(dialog).toContainText('预览第 2 页');await expect(dialog).toContainText('导入人员20');
  failure=404;await view.click();await expect(dialog).toContainText('导入记录已不可用');await expect(dialog).not.toContainText('导入人员20');
  await expect(dialog.getByRole('button',{name:'确认整批导入',exact:true})).toBeDisabled();
  await expect(dialog).toContainText('预览.csv');
});

test('selecting another import withdraws the previous preview before the new task arrives',async({page})=>{
  await mockPage(page);let started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const records={data:[...history('原任务.csv').data,...history('另一个.csv',ids.session).data]};
  await page.route(historyApi,route=>route.fulfill({status:200,json:records}));
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:batch()}}));
  await page.route('**/api/v1/member-imports/'+ids.session,async route=>{started();await gate;const value=batch(ids.session,1);value.rows[0].display_name='新任务人员';await route.fulfill({status:200,json:{data:value}});});
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true}),confirm=dialog.getByRole('button',{name:'确认整批导入',exact:true});
  await dialog.locator('.history-row').filter({hasText:'原任务.csv'}).getByRole('button',{name:'查看',exact:true}).click();await expect(dialog).toContainText('导入人员0');await expect(confirm).toBeEnabled();
  try{
    await dialog.locator('.history-row').filter({hasText:'另一个.csv'}).getByRole('button',{name:'查看',exact:true}).click();await pending;
    await expect(confirm).toBeDisabled();await expect(dialog).not.toContainText('导入人员0');
  }finally{release();}
  await expect(dialog).toContainText('新任务人员');await expect(confirm).toBeEnabled();
});

test('closing an import while its success history read is pending cannot submit a later member search draft',async({page})=>{
  await mockPage(page);let calls=0,started,release,finished;const memberQueries=[];
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{finished=resolve;});
  await page.route('**/api/v1/departments/'+ids.department+'/members?*',async route=>{memberQueries.push(route.request().url());await route.fallback();});
  await page.route(historyApi,async route=>{
    if(++calls===2){started();await gate;await route.fulfill({status:200,json:history('旧成功.csv')});finished();}
    else await route.fulfill({status:200,json:history('当前历史.csv')});
  });
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:{...batch(),status:'succeeded',can_submit:false}}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  try{
    await dialog.getByRole('button',{name:'查看',exact:true}).click();await pending;await expect(dialog).toContainText('整批导入成功');
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).not.toBeVisible();
    await page.getByRole('textbox',{name:'搜索成员',exact:true}).fill('不应自动提交的草稿');
  }finally{release();}
  await done;await expect.poll(()=>memberQueries.some(url=>new URL(url).searchParams.get('search')==='不应自动提交的草稿')).toBe(false);
  await page.getByRole('button',{name:'批量导入',exact:true}).click();await expect(dialog).toContainText('当前历史.csv');
  await expect(page.getByRole('textbox',{name:'搜索成员',exact:true})).toHaveValue('不应自动提交的草稿');
  expect(memberQueries.some(url=>new URL(url).searchParams.get('search')==='不应自动提交的草稿')).toBe(false);
});

test('import history denial clears selected records and blocks stale preview submission',async({page})=>{
  await mockPage(page);let denied=false;
  await page.route(historyApi,route=>route.fulfill(denied?{status:403,json:{error:{code:'forbidden',message:'导入授权已失效',request_id:'synthetic'}}}:{status:200,json:history('已选任务.csv')}));
  await page.route('**/api/v1/member-imports/'+ids.second,route=>route.fulfill({status:200,json:{data:batch()}}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  await dialog.getByRole('button',{name:'查看',exact:true}).click();await expect(dialog).toContainText('导入人员0');
  denied=true;await dialog.getByRole('button',{name:'刷新导入记录',exact:true}).click();await expect(dialog).toContainText('导入授权已失效');
  await expect(dialog).not.toContainText('已选任务.csv');await expect(dialog).not.toContainText('导入人员0');
  await expect(dialog.getByRole('button',{name:'确认整批导入',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'选择文件',exact:true})).toBeDisabled();
});

test('a failed initial import history read is visible and can be retried independently',async({page})=>{
  await mockPage(page);let failing=true;
  await page.route(historyApi,route=>route.fulfill(failing?{status:503,json:{error:{code:'unavailable',message:'历史暂不可用',request_id:'synthetic'}}}:{status:200,json:history('重读历史.csv')}));
  await page.goto(path);await page.getByRole('button',{name:'批量导入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量导入成员',exact:true});
  await expect(dialog).toContainText('历史暂不可用');await expect(dialog).toContainText('导入历史尚未读取');
  failing=false;await dialog.getByRole('button',{name:'刷新导入记录',exact:true}).click();
  await expect(dialog).toContainText('重读历史.csv');await expect(dialog).not.toContainText('历史暂不可用');
});
