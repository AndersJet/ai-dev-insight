import {e2eArtifact} from './helpers/environment.mjs';
import { test, expect } from './helpers/browser.js';
import { readFileSync } from 'node:fs';

type Account = { email: string; password: string };
type Fixture = {
  admin: Account;
  roleNavigation: { anc_admin: Account; employee: Account };
  analytics: { departmentA: string; departmentB: string; managerEmail: string; managerPassword: string };
};
const fixture = (): Fixture => JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'), 'utf8'));

test('four real roles keep their D navigation and data scopes across logout, reload and direct routes', async ({ page }) => {
  test.setTimeout(60_000);
  const f = fixture();
  const roles = [
    { role: 'super', account: f.admin, home: '/organization', headings: '组织 使用概览', navigation: ['我的空间', '组织分析', '组织管理', '系统运营'] },
    { role: 'anc_admin', account: f.roleNavigation.anc_admin, home: '/organization', headings: '组织 使用概览', navigation: ['我的空间', '组织分析', '组织管理'] },
    { role: 'department_admin', account: { email: f.analytics.managerEmail, password: f.analytics.managerPassword }, home: `/organization/${f.analytics.departmentA}`, headings: 'E2E统计A部门 · 使用分析', navigation: ['我的空间', '组织分析', '组织管理'] },
    { role: 'employee', account: f.roleNavigation.employee, home: '/my/overview', headings: '我的使用概览', navigation: ['我的空间'] },
  ];
  for (const current of roles) {
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill(current.account.email);
    await page.getByLabel('密码', { exact: true }).fill(current.account.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: current.headings, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '一级导航' }).getByRole('link')).toHaveText(current.navigation);
    await expect(page.getByRole('navigation').getByRole('button',{name:'历史查询 暂未开放',exact:true})).toBeDisabled();
    const features=page.getByRole('complementary');
    await expect(features.getByRole('link',{name:'Token使用分析',exact:true})).toHaveCount(current.role==='super'?1:0);
    await expect(features.getByRole('link',{name:'代码流向追踪',exact:true})).toHaveCount(current.role==='super'?1:0);
    await page.reload();
    await expect(page.getByRole('heading', { name: current.headings, exact: true })).toBeVisible();
    if (current.role === 'anc_admin') {
      await page.getByRole('navigation').getByRole('link', { name: '组织管理', exact: true }).click();
      const sidebar = page.getByRole('complementary', { name: '当前工作区菜单' });
      await expect(sidebar.getByRole('link', { name: /E2E统计A部门/ })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: /E2E统计B部门/ })).toBeVisible();
      await sidebar.getByRole('link', { name: '部门配置', exact: true }).click();
      await expect(page.getByRole('button', { name: '新增部门', exact: true })).toBeVisible();
      await sidebar.getByRole('link', { name: /E2E统计A部门/ }).click();
      await expect(page.getByRole('main').getByRole('button', { name: '添加成员', exact: true })).toBeVisible();
      await expect(sidebar.getByRole('button', { name: '添加成员', exact: true })).toHaveCount(0);
      await expect(page.getByRole('main')).not.toContainText('PRIVATE_BROWSER_A');
    }
    if (current.role !== 'super') {
      expect((await page.request.get('/api/v1/admin/sessions')).status()).toBe(403);
      await page.goto('/all/sessions');
      await expect(page).toHaveURL(/\/my\/overview$/);
      await expect(page.getByRole('main')).not.toContainText('PRIVATE_BROWSER');
      expect((await page.request.get('/api/v1/code-flow')).status()).toBe(403);
      expect((await page.request.get(`/api/v1/code-flow/${f.analytics.departmentA}/sessions`)).status()).toBe(403);
      await page.goto('/code-flow');await expect(page).toHaveURL(/\/my\/overview$/);
      await page.goto('/system/health');
      await expect(page).toHaveURL(/\/my\/overview$/);
    }
    if (current.role === 'department_admin' || current.role === 'employee') {
      expect((await page.request.get(`/api/v1/analytics/overview?department_id=${f.analytics.departmentB}`)).status()).toBe(403);
    }
    if(current.role==='super'){
      await page.goto('/all/sessions');
      await expect(page.getByRole('navigation').getByRole('link',{name:'组织分析',exact:true})).toHaveClass(/selected/);
      await expect(page.getByRole('complementary').getByRole('link',{name:'Token使用分析',exact:true})).toHaveClass(/selected/);
      await page.goto('/code-flow');
      await expect(page.getByRole('navigation').getByRole('link',{name:'组织分析',exact:true})).toHaveClass(/selected/);
      await expect(page.getByRole('complementary').getByRole('link',{name:'代码流向追踪',exact:true})).toHaveClass(/selected/);
    }
    await page.goto('/history');await expect(page.getByRole('heading',{name:'历史查询暂未开放',exact:true})).toBeVisible();
    await page.goto(current.home);
    await expect(page.getByRole('heading', { name: current.headings, exact: true })).toBeVisible();
    if (current.role === 'super' || current.role === 'anc_admin') {
      await expect(page.getByRole('complementary').getByRole('link', { name: '组织概览', exact: true })).toHaveClass(/selected/);
      await expect(page.locator('.workspace-breadcrumb')).toContainText('全部一级部门');
    }
    await expect(page.getByRole('button', { name: '刷新统计', exact: true })).toBeEnabled();
    await expect(page.getByRole('main').getByText('正在读取统计…', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `.run/role-${current.role}.png`, fullPage: true });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('D department workspace keeps sidebar and content usable at narrow desktop widths', async ({ page }) => {
  const f = fixture();
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(f.roleNavigation.anc_admin.email);
  await page.getByLabel('密码', { exact: true }).fill(f.roleNavigation.anc_admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '组织 使用概览', exact: true })).toBeVisible();
  // Reproduce a slow lazy route: the previous workspace remains visible until
  // the real MembersView module arrives, so its department links are still old.
  let delayedModuleRequests = 0;
  await page.route('**/src/views/MembersView.vue*', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200); delayedModuleRequests++;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('navigation').getByRole('link', { name: '组织管理', exact: true }).click();
  await expect(page).toHaveURL(/\/organization-management\/all\/members(?:\?|$)/);
  await expect(page.getByRole('heading', { name: '组织与成员', exact: true })).toBeVisible();
  expect(delayedModuleRequests).toBe(1);
  const department = page.getByRole('complementary').getByRole('link', { name: /E2E统计A部门/ });
  await expect(department).toHaveAttribute('href', new RegExp(`/organization-management/${f.analytics.departmentA}/members`));
  await department.click();
  await expect(page).toHaveURL(new RegExp(`/organization-management/${f.analytics.departmentA}/members(?:\\?|$)`));
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('main').getByRole('button', { name: '添加成员', exact: true })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector('aside')!.getBoundingClientRect();
      const content = document.querySelector('main')!.getBoundingClientRect();
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, sideRight: sidebar.right, mainLeft: content.left };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.sideRight).toBeLessThanOrEqual(geometry.mainLeft + 1);
    await page.screenshot({ path: `.run/role-anc-members-${width}.png`, fullPage: true });
  }
});


test('D session list exposes in-flight loading, a real empty search and recovery to existing sessions', async ({ page }) => {
  const f = fixture();
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(f.admin.email);
  await page.getByLabel('密码', { exact: true }).fill(f.admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '组织 使用概览', exact: true })).toBeVisible();
  let release!: () => void; let received!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { received = resolve; });
  await page.route(/\/api\/v1\/me\/sessions(?:\?|$)/, async route => {
    const response = await route.fetch(); received(); await hold; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.goto('/my/sessions'); await pending;
    await expect(page.locator('.data-panel[aria-busy="true"]')).toBeVisible();
    await expect(page.getByText('正在加载…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('.data-panel[aria-busy="false"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeVisible();
  const search = 'NO_SYNTHETIC_SESSION_MATCH_20260926';
  const emptyResponse = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/v1/me/sessions' && url.searchParams.get('search') === search;
  });
  await page.getByLabel('搜索会话', { exact: true }).fill(search);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const empty = await emptyResponse; expect(empty.status()).toBe(200); expect((await empty.json()).data.total).toBe(0);
  await expect(page.getByText('当前范围没有符合筛选条件的会话', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0);
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
});
