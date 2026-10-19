/* global getComputedStyle */
import { test, expect } from '../e2e/helpers/browser.js';
import { mockPage, ids, response } from './fixtures.mjs';
const members = `/organization-management/${ids.department}/members`;
test.beforeEach(async ({page}) => { await mockPage(page); });
async function action(page, name) {
  await page.getByRole('button', {name:'更多',exact:true}).first().click();
  await page.getByRole('menuitem', {name,exact:true}).click();
}

test('suspension names the destructive action and requires its reason', async ({page}) => {
  await page.goto(members);await action(page,'停用账号');
  const dialog=page.getByRole('dialog',{name:'停用账号',exact:true});
  const submit=dialog.getByRole('button',{name:'确认停用',exact:true});
  await expect(submit).toBeDisabled();await dialog.getByLabel('操作原因',{exact:true}).fill('调整账号访问');
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole('button',{name:'确认保存',exact:true})).toHaveCount(0);
});

test('chart axis labels remain legible through desktop and narrow layout changes', async ({page}) => {
  await page.goto('/organization');
  const chart=page.getByRole('img',{name:'每日观测人数趋势'});await expect(chart).toBeVisible();
  for(const width of [1440,1024,390]){
    await page.setViewportSize({width,height:1000});
    await expect.poll(()=>chart.locator('text').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)*e.getScreenCTM().a)).toBeGreaterThanOrEqual(11);
  }
});

test('member form uses matching control heights and the department selector is localized',async({page})=>{
  await page.goto(members);await page.getByRole('button',{name:'添加成员',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'添加成员',exact:true});
  const textbox=dialog.getByRole('textbox',{name:'姓名',exact:true});
  const inputHeight=await textbox.evaluate(e=>e.closest('.el-input').getBoundingClientRect().height);
  expect(inputHeight).toBe(40);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();await action(page,'跨部门调动');
  const select=page.getByRole('dialog').getByRole('combobox').first();
  const selectHeight=await select.evaluate(e=>e.closest('.el-select').getBoundingClientRect().height);
  expect(selectHeight).toBe(40);
  await expect(page.getByRole('dialog').getByText('请选择调入部门',{exact:true})).toBeVisible();
});

test('filled model confirmation keeps its multiline instructions visible',async({page})=>{
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  await page.getByRole('button',{name:'修改本人确认',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});
  await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('Claude Sonnet 4.5');
  await expect(dialog.getByText('每行一个模型，最多 10 个；仅填写你确认使用过的个人自配模型。',{exact:true})).toBeVisible();
});

test('cleanup preview exposes reachable confirmation and never enables submission for a different email',async({page})=>{
  await page.goto(members);await action(page,'清理使用数据');
  const dialog=page.getByRole('dialog',{name:'清理使用数据',exact:true});
  await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();
  const submit=dialog.getByRole('button',{name:'确认清理并提交任务',exact:true});
  await expect(submit).toBeDisabled();await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('wrong@example.invalid');
  await expect(submit).toBeDisabled();await dialog.getByLabel('确认目标邮箱',{exact:true}).fill('lin.xiao@example.invalid');
  await expect(submit).toBeEnabled();await submit.scrollIntoViewIfNeeded();await expect(submit).toBeInViewport();
});

test('cleanup preview exposes project evidence even when its carrying Hooks are outside the selected range',async({page})=>{
  await page.route('**/api/v1/admin/cleanup/previews',route=>{
    const result=response(route.request().url(),'POST');Object.assign(result.body.data.counts,{hook_events:0,project_observations:3,project_links:1});
    return route.fulfill({status:200,json:result.body});
  });
  await page.goto(members);await action(page,'清理使用数据');const dialog=page.getByRole('dialog',{name:'清理使用数据',exact:true});
  await dialog.getByRole('button',{name:'生成清理预览',exact:true}).click();
  await expect(dialog.getByTestId('cleanup-event-count')).toHaveText('0');
  await expect(dialog.getByTestId('cleanup-project-observation-count')).toHaveText('3');
  await expect(dialog.getByTestId('cleanup-project-link-count')).toHaveText('1');
  await expect(dialog).toContainText('Hook观测按原探测时间或首次来源Hook时间清理');
});

test('department dialog remains contained and enabled primary text has adequate contrast',async({page})=>{
  await page.goto('/organization-management/departments');await page.getByRole('button',{name:'新增部门',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'新增部门',exact:true});
  await dialog.getByLabel('部门名称',{exact:true}).fill('设计验证部');
  const submit=dialog.getByRole('button',{name:'保存',exact:true});await expect(submit).toBeEnabled();
  const contrast=await submit.evaluate(e=>{
    const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
    const s=getComputedStyle(e),a=luminance(s.color),b=luminance(s.backgroundColor);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.setViewportSize({width:390,height:844});
  const box=await dialog.locator('.el-dialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(16);expect(box.x+box.width).toBeLessThanOrEqual(374);
});
