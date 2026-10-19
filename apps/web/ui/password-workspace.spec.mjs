import { test, expect } from '../e2e/helpers/browser.js';
import { URL } from 'node:url';
import { mockPage, response } from './fixtures.mjs';

async function passwordUser(page, { role = 'employee', forced = false, registered = true, source = 'system' } = {}) {
  await mockPage(page, role);
  const user = response('/api/v1/me', 'GET', role).body.data;
  Object.assign(user, { roles: [role], must_change_password: forced, registered, management_source: source, allowed_actions: source === 'environment' ? [] : ['self:password'] });
  await page.route('**/api/v1/me', route => route.fulfill({ status: 200, json: { data: user } }));
  return user;
}

for (const role of ['employee', 'department_admin', 'anc_admin', 'super']) {
test(`${role} voluntary password change is embedded and stays on the cleared form after success`, async ({ page }) => {
  const user = await passwordUser(page, {role});
  await page.goto('/my/overview');
  await page.getByRole('complementary').getByRole('link', { name: '修改密码', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '一级导航', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('link', { name: '修改密码', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
  await page.route('**/api/v1/auth/change-password', route => route.fulfill({ status: 200, json: { data: user } }));
  await page.getByLabel('当前密码', { exact: true }).fill('old-synthetic-password');
  await page.getByLabel('新密码', { exact: true }).fill('new-synthetic-password');
  await page.getByLabel('确认新密码', { exact: true }).fill('new-synthetic-password');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByRole('alert').filter({ hasText: '密码已修改' })).toBeVisible();
  for (const label of ['当前密码', '新密码', '确认新密码']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(page.getByRole('main').getByRole('link', { name: '返回我的概览', exact: true })).toHaveAttribute('href', '/my/overview');
});
}

test('forced password change locks business navigation and does not prefetch protected data', async ({ page }) => {
  await passwordUser(page, { role: 'department_admin', forced: true });
  const business = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/v1/me' && !path.startsWith('/api/v1/auth/')) business.push(path);
  });
  await page.goto('/organization');
  await expect(page).toHaveURL(/\/change-password\?/);
  await expect(page.getByRole('heading', { name: '请先设置新密码', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '一级导航', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('complementary').getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '操作手册', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存并继续', exact: true })).toBeVisible();
  await page.goto('/my/overview');
  await expect(page).toHaveURL(/\/change-password\?/);
  await expect(page.getByRole('heading', { name: '请先设置新密码', exact: true })).toBeVisible();
  expect(business).toEqual([]);
  await page.route('**/api/v1/auth/logout', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '登录工作空间', exact: true })).toBeVisible();
});

test('leaving a pending password change keeps the chosen page and does not retain password fields', async ({ page }) => {
  const user = await passwordUser(page);
  await page.goto('/change-password');
  let release, reached, submissions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/v1/auth/change-password', async route => {
    submissions++; reached(); await gate;
    await route.fulfill({ status: 200, json: { data: user } });
  });
  await page.getByLabel('当前密码', { exact: true }).fill('old-synthetic-password');
  await page.getByLabel('新密码', { exact: true }).fill('new-synthetic-password');
  await page.getByLabel('确认新密码', { exact: true }).fill('new-synthetic-password');
  try {
    await page.getByRole('button', { name: '保存修改', exact: true }).click(); await started;
    await page.getByLabel('确认新密码', { exact: true }).press('Enter');
    await page.getByRole('complementary').getByRole('link', { name: '我的Token使用分析', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的Token使用分析', exact: true })).toBeVisible();
    const chosen = page.url(); release(); await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(chosen); expect(submissions).toBe(1);
    await page.getByRole('complementary').getByRole('link', { name: '修改密码', exact: true }).click();
    for (const label of ['当前密码', '新密码', '确认新密码']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  } finally { release(); }
});

for (const registered of [true, false]) {
  test(`forced password success preserves ${registered ? 'the permitted deep link' : 'registration priority'}`, async ({ page }) => {
    const user=await passwordUser(page,{forced:true,registered});
    await page.route('**/api/v1/auth/change-password',route=>route.fulfill({status:200,json:{data:{...user,must_change_password:false}}}));
    await page.goto('/change-password?redirect=/my/sessions');
    await page.getByLabel('当前密码',{exact:true}).fill('synthetic-temporary-password');
    await page.getByLabel('新密码',{exact:true}).fill('new-synthetic-password');
    await page.getByLabel('确认新密码',{exact:true}).fill('new-synthetic-password');
    await page.getByRole('button',{name:'保存并继续',exact:true}).click();
    await expect(page).toHaveURL(registered ? /\/my\/sessions$/ : /\/register$/);
  });
}

test('configuration administrator cannot enter password change from the sidebar or direct address',async({page})=>{
  await passwordUser(page,{role:'super',source:'environment'});
  await page.goto('/my/overview');
  await expect(page.getByRole('complementary').getByRole('link',{name:'修改密码',exact:true})).toHaveCount(0);
  await page.goto('/change-password');
  await expect(page.getByRole('heading',{name:'组织 使用概览',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'当前密码',exact:true})).toHaveCount(0);
});

test('password validation and temporary failures allow retry in the same form',async({page})=>{
  const user=await passwordUser(page);let requests=0;
  await page.route('**/api/v1/auth/change-password',route=>{
    requests++;
    return route.fulfill(requests===1?{status:503,json:{error:{code:'unavailable',message:'合成暂时不可用'}}}:{status:200,json:{data:user}});
  });
  await page.goto('/change-password');
  await page.getByLabel('当前密码',{exact:true}).fill('old-synthetic-password');
  await page.getByLabel('新密码',{exact:true}).fill('new-synthetic-password');
  await page.getByLabel('确认新密码',{exact:true}).fill('different-synthetic-password');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');expect(requests).toBe(0);
  await page.getByLabel('确认新密码',{exact:true}).fill('new-synthetic-password');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'合成暂时不可用'}).first()).toBeVisible();
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByLabel('新密码',{exact:true})).toHaveValue('new-synthetic-password');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('密码已修改');expect(requests).toBe(2);
});

test('logout during password submission rejects a late response and its replacement session cookie',async({page,context,baseURL})=>{
  const user=await passwordUser(page,{forced:true});
  await context.addCookies([{name:'adi_session',value:'synthetic-current-session',url:baseURL}]);
  await page.route('**/api/v1/me',route=>route.fulfill(route.request().headers().cookie?.includes('adi_session=')?{status:200,json:{data:user}}:{status:401,json:{error:{code:'unauthorized',message:'请登录'}}}));
  await page.route('**/api/v1/auth/logout',route=>route.fulfill({status:204,headers:{'set-cookie':'adi_session=; Path=/; Max-Age=0; SameSite=Lax'}}));
  let release,reached;
  const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{reached=resolve;});
  await page.route('**/api/v1/auth/change-password',async route=>{
    reached();await gate;
    await route.fulfill({status:200,headers:{'set-cookie':'adi_session=synthetic-late-session; Path=/; SameSite=Lax'},json:{data:{...user,must_change_password:false}}});
  });
  await page.goto('/change-password');
  await page.getByLabel('当前密码',{exact:true}).fill('old-synthetic-password');
  await page.getByLabel('新密码',{exact:true}).fill('new-synthetic-password');
  await page.getByLabel('确认新密码',{exact:true}).fill('new-synthetic-password');
  try{
    await page.getByRole('button',{name:'保存并继续',exact:true}).click();await started;
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page).toHaveURL(/\/login$/);
    release();await page.waitForLoadState('networkidle');
    expect((await context.cookies()).some(cookie=>cookie.name==='adi_session')).toBe(false);
    await page.reload();await expect(page).toHaveURL(/\/login$/);await expect(page.getByRole('heading',{name:'登录工作空间',exact:true})).toBeVisible();
  }finally{release();}
});
