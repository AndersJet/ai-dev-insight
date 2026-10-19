import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import { test, expect } from './helpers/browser.js';
import { readFileSync } from 'node:fs';

test('voluntary embedded password change rotates the current session and revokes another real login', async ({ page, browser }) => {
  const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
  const account=fixture.roleNavigation.employee;
  const old=await browser.newContext({baseURL:e2eEnv.webURL});
  const replacement='changed-synthetic-employee-password';let changed=false;
  try{
    expect((await old.request.post('/api/v1/auth/login',{data:account})).status()).toBe(200);
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(account.email);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('navigation').getByRole('link',{name:'我的空间',exact:true}).click();
    await page.getByRole('complementary').getByRole('link',{name:'修改密码',exact:true}).click();
    await expect(page.getByRole('navigation',{name:'一级导航',exact:true})).toBeVisible();
    await page.getByLabel('当前密码',{exact:true}).fill(account.password);
    await page.getByLabel('新密码',{exact:true}).fill(replacement);await page.getByLabel('确认新密码',{exact:true}).fill(replacement);
    const result=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/auth/change-password');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();expect((await result).status()).toBe(200);changed=true;
    await expect(page).toHaveURL(/\/change-password$/);await expect(page.getByRole('alert')).toContainText('密码已修改');
    for(const field of ['当前密码','新密码','确认新密码'])await expect(page.getByLabel(field,{exact:true})).toHaveValue('');
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);
    expect((await old.request.get('/api/v1/me')).status()).toBe(401);
    await page.reload();await expect(page.getByRole('heading',{name:'修改密码',exact:true})).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link',{name:'修改密码',exact:true})).toHaveClass(/selected/);
  }finally{
    if(changed){
      const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='adi_csrf')!.value;
      expect((await page.request.post('/api/v1/auth/change-password',{headers:{'x-csrf-token':csrf},data:{current_password:replacement,new_password:account.password}})).status()).toBe(200);
    }
    await old.close();
  }
});
