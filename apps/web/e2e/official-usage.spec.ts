import {e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';import {readFileSync} from 'node:fs';
test('D official summaries separate IDE Chat from CUE and allow global managers to review and restore department associations',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('complementary').getByRole('link',{name:/E2E统计A部门/}).click();
 await expect(page.getByTestId('official-chat-tokens')).toHaveText('2,200');
 await expect(page.getByRole('heading',{name:'官方用量',exact:true})).toBeVisible();await expect(page.getByTestId('official-usage-panel')).toContainText('CUE');await expect(page.getByTestId('official-usage-panel')).toContainText('企业统一接入');await expect(page.getByTestId('official-usage-panel')).toContainText('0.123456');await expect(page.getByTestId('official-usage-panel')).toContainText('来源标记未计价');
 await expect(page.getByTestId('usage-reconciliation')).toContainText('数量守恒不代表会话完整');await expect(page.getByTestId('reconciliation-total')).toHaveText('2,500');await expect(page.getByTestId('reconciliation-attributed')).toHaveText('2,500');
 await page.getByTestId('usage-reconciliation').getByText('查看按日缺口与重查计划',{exact:true}).click();await expect(page.getByTestId('usage-gap-days')).toContainText('超过24小时');await expect(page.getByTestId('usage-gap-days')).toContainText('可执行时间');await page.getByTestId('usage-gap-days').screenshot({path:'.run/usage-gap-days.png'});
 await page.getByRole('radio',{name:'今日',exact:true}).click();await expect(page.getByTestId('official-chat-tokens')).toHaveText('1,700');
 await page.screenshot({path:'.run/official-usage-summary.png',fullPage:true});
 await page.getByRole('navigation').getByRole('link',{name:'组织管理',exact:true}).click();await page.getByRole('complementary').getByRole('link',{name:'部门配置',exact:true}).click();
 const row=page.getByRole('row').filter({hasText:'E2E统计A部门'});await row.getByRole('button',{name:'官方部门关联',exact:true}).click();const dialog=page.getByRole('dialog',{name:'官方部门关联',exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText('e2e-source-a');
 await dialog.getByRole('button',{name:'移除关联',exact:true}).click();await page.getByRole('button',{name:'确认移除',exact:true}).click();await expect(dialog.getByText('暂无关联',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog',{name:'移除官方部门关联',exact:true})).toBeHidden();
 await dialog.getByText('选择已观测的官方部门',{exact:true}).click();await page.getByRole('option',{name:/TRAE A部门/}).click();await expect(page.getByRole('option',{name:/TRAE A部门/})).toBeHidden();await dialog.getByLabel('生效日期',{exact:true}).fill(fixture.official.fromDate);await dialog.getByRole('button',{name:'添加关联',exact:true}).click();await expect(dialog.getByRole('row').filter({hasText:'e2e-source-a'}).getByRole('button',{name:'移除关联',exact:true})).toBeVisible();await page.screenshot({path:'.run/official-department-mapping.png',fullPage:true});
 await dialog.getByRole('button',{name:'Close this dialog',exact:true}).click();
 await page.getByRole('navigation').getByRole('link',{name:'组织分析',exact:true}).click();await page.getByRole('complementary').getByRole('link',{name:/E2E统计A部门/}).click();await page.getByRole('radio',{name:'今日',exact:true}).click();await expect(page.getByTestId('official-chat-tokens')).toHaveText('1,700');
});

test('a delayed department mapping failure cannot overwrite another department dialog',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('navigation').getByRole('link',{name:'组织管理',exact:true}).click();await page.getByRole('complementary').getByRole('link',{name:'部门配置',exact:true}).click();
 await page.getByRole('row').filter({hasText:'E2E统计A部门'}).getByRole('button',{name:'官方部门关联',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'官方部门关联',exact:true});await expect(dialog.getByRole('row').filter({hasText:'e2e-source-a'})).toBeVisible();
 await dialog.getByText('选择已观测的官方部门',{exact:true}).click();await page.getByRole('option',{name:/TRAE A部门/}).click();await dialog.getByLabel('生效日期',{exact:true}).fill(fixture.official.fromDate);
 let release!:()=>void;let received!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});const captured=new Promise<void>(resolve=>{received=resolve;});
 await page.route('**/api/v1/usage/department-mappings',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();expect(response.status()).toBe(409);received();await hold;await route.fulfill({response});});
 try{
  await dialog.getByRole('button',{name:'添加关联',exact:true}).click();await captured;
  await dialog.getByRole('button',{name:'Close this dialog',exact:true}).click();await expect(dialog).toBeHidden();
  await page.getByRole('row').filter({hasText:'E2E统计B部门'}).getByRole('button',{name:'官方部门关联',exact:true}).click();await expect(dialog.getByRole('row').filter({hasText:'e2e-source-b'})).toBeVisible();
  const response=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/api/v1/usage/department-mappings'));release();await (await response).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(dialog.getByRole('alert')).toBeHidden();await expect(dialog.getByRole('row').filter({hasText:'e2e-source-b'})).toBeVisible();
 }finally{release();}
});
