import {test,expect} from './helpers/browser.js';
import {randomUUID} from 'node:crypto';

test('superadmin maintains exact host and repository rules through the project page',async({page})=>{
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('complementary').getByRole('link',{name:'代码流向追踪',exact:true}).click();
  await page.getByRole('button',{name:'部门仓库白名单',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});
  await expect(dialog).toContainText('不绑定具体部门');
  const host=`git-${randomUUID()}.example.invalid`;
  await dialog.getByLabel('匹配地址',{exact:true}).fill(host.toUpperCase());
  await dialog.getByRole('button',{name:'添加规则',exact:true}).click();
  const row=dialog.getByRole('row').filter({hasText:host});await expect(row).toBeVisible();
  await row.getByRole('button',{name:'编辑',exact:true}).click();
  await dialog.getByRole('combobox',{name:'规则类型',exact:true}).press('ArrowDown');
  await page.getByRole('option',{name:'完整仓库地址',exact:true}).click();
  await dialog.getByLabel('匹配地址',{exact:true}).fill(`https://user:synthetic-browser-secret@${host}/team/App.git?token=synthetic-browser-secret`);
  await dialog.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(row).toContainText(`https://${host}/team/App.git`);
  await expect(dialog).not.toContainText('synthetic-browser-secret');
  await expect(dialog.getByLabel('匹配地址',{exact:true})).toHaveValue('');
  await row.getByRole('button',{name:'移除',exact:true}).click();
  await page.getByRole('dialog',{name:'移除白名单规则',exact:true}).getByRole('button',{name:'确认移除',exact:true}).click();
  await expect(row).toHaveCount(0);
  await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();
  await expect(page.getByRole('heading',{name:'代码流向追踪',exact:true})).toBeVisible();
});
