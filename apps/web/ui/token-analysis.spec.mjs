import {URL} from 'node:url';
import {Buffer} from 'node:buffer';
import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
import {zipSync,strToU8} from 'fflate';
for(const scope of ['my','all'])test(`${scope} detail exports current and cross-day selections across pages`,async({page})=>{
 await mockPage(page);const listPath=scope==='all'?'admin':'me';const third='55555555-5555-4555-8555-555555555555';let submitted;
 await page.route(`**/api/v1/${listPath}/sessions?*`,route=>{
  const u=new URL(route.request().url()),body=response(route.request().url()).body;
  if(scope==='all')expect(u.searchParams.get('user_id')).toBe(ids.user);else expect(u.searchParams.has('user_id')).toBe(false);
  const item=body.data.items[0];const next=!!u.searchParams.get('cursor');
  body.data.items=[{...item,id:next?third:ids.second,title:next?'上周第二会话':'昨日第一会话',first_at:new Date(Date.now()-(next?7:1)*86400000).toISOString()}];body.data.next_cursor=next?null:'synthetic-next';body.data.has_more=!next;
  return route.fulfill({status:200,json:body});
 });
 await page.route('**/api/v1/sessions/analysis-package',async route=>{
  submitted=route.request().postDataJSON();return route.fulfill({status:200,contentType:'application/zip',headers:{'Content-Disposition':'attachment; filename="token-efficiency-analysis.zip"'},body:Buffer.from(zipSync({'prompt.md':strToU8('synthetic')}))});
 });
 await page.goto(`/${scope}/sessions/${ids.session}`);const row=page.locator('.detail-return-row');
 await expect(row.getByRole('button',{name:'Token能效分析',exact:true})).toBeEnabled();
 const labels=await row.getByRole('button').allTextContents();expect(labels.at(-2).trim()).toBe('重新加载');expect(labels.at(-1).trim()).toBe('Token能效分析');
 await row.getByRole('button',{name:'Token能效分析',exact:true}).click();const dialog=page.getByRole('dialog');
 await dialog.getByText('关联其他会话',{exact:true}).click();await dialog.getByRole('checkbox',{name:'选择会话 昨日第一会话'}).press('Space');await expect(dialog.getByRole('checkbox',{name:'选择会话 昨日第一会话'})).toBeChecked();
 await dialog.getByRole('button',{name:'下一页',exact:true}).click();await dialog.getByRole('checkbox',{name:'选择会话 上周第二会话'}).press('Space');await expect(dialog.getByRole('checkbox',{name:'选择会话 上周第二会话'})).toBeChecked();await expect(dialog.getByText('已选 3 个会话（跨页保留）')).toBeVisible();
 await page.screenshot({path:`.run/token-efficiency-${scope}-dialog.png`,fullPage:false});
 const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'下载分析包',exact:true}).click();expect((await downloaded).suggestedFilename()).toBe('token-efficiency-analysis.zip');expect(submitted.session_ids).toEqual([ids.session,ids.second,third]);
 await expect(dialog).toHaveCount(0);
});
test('turning association off returns to current session; download rejection remains a visible error',async({page})=>{
 await mockPage(page);await page.route('**/api/v1/sessions/analysis-package',r=>r.fulfill({status:413,json:{error:{code:'analysis_too_large',message:'所选材料过大，请减少会话后重试'}}}));
 await page.goto('/my/sessions/'+ids.session);await page.getByRole('button',{name:'Token能效分析',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByText('关联其他会话',{exact:true}).click();await dialog.getByText('关联其他会话',{exact:true}).click();await dialog.getByRole('button',{name:'下载分析包',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('材料过大');await expect(dialog).toBeVisible();
});
test('export authorization rejection closes sensitive selection and rechecks main detail',async({page})=>{
 await mockPage(page);let reads=0;
 await page.route('**/api/v1/sessions/'+ids.session,route=>{if(++reads===1)return route.fulfill({status:200,json:response(route.request().url()).body});return route.fulfill({status:403,json:{error:{code:'forbidden',message:'无权读取此会话'}}});});
 await page.route('**/api/v1/sessions/analysis-package',route=>route.fulfill({status:403,json:{error:{code:'forbidden',message:'权限已变化'}}}));
 await page.goto('/my/sessions/'+ids.session);await page.getByRole('button',{name:'Token能效分析',exact:true}).click();await page.getByRole('button',{name:'下载分析包',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('无权读取此会话');expect(reads).toBeGreaterThan(1);
});
for(const viewport of [{width:1440,height:900},{width:390,height:844}])test(`long session content keeps dialog actions visible at ${viewport.width}px`,async({page})=>{
 await page.setViewportSize(viewport);await mockPage(page);
 await page.route('**/api/v1/me/sessions?*',route=>{
  const body=response(route.request().url()).body,item=body.data.items[0];
  body.data.items=Array.from({length:6},(_,i)=>({...item,id:`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`,title:'长提示与现有系统组件保持一致，核对需求边界、实现步骤和验证证据。'.repeat(5),model:'custom_openai_compatible/volc/deepseek-v4-1-flash'}));body.data.next_cursor=null;body.data.has_more=false;
  return route.fulfill({status:200,json:body});
 });
 await page.goto('/my/sessions/'+ids.session);await page.getByRole('button',{name:'Token能效分析',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByText('关联其他会话',{exact:true}).click();await expect(dialog.getByText('24,680').first()).toBeVisible();
 const box=await dialog.boundingBox(),action=await dialog.getByRole('button',{name:'下载分析包',exact:true}).boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+1);expect(action.y+action.height).toBeLessThanOrEqual(viewport.height);await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeVisible();
 await page.screenshot({path:`.run/token-efficiency-dialog-${viewport.width}.png`,fullPage:false});await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
