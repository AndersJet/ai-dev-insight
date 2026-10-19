import { test, expect } from './helpers/browser.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill('e2e-root@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
});

test('pending adoption remains readable and refreshable without a member-list link', async ({ page }) => {
  const progress = page.getByRole('region', { name: '采纳进度', exact: true });
  const pending = progress.getByText(/^待采纳\s*\d+$/);
  await expect(pending).toBeVisible();
  await expect(progress.getByRole('button', { name: /待采纳/ })).toHaveCount(0);
  await expect(progress.getByRole('link', { name: /待采纳/ })).toHaveCount(0);
  const before = page.url();
  await pending.click();
  await expect(page).toHaveURL(before);
  const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/adoption' && r.request().method() === 'GET');
  await progress.getByRole('button', { name: '刷新采纳状态', exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(pending).toBeVisible();
});

test('synchronization shows query-result person-days separately from complete usage', async ({ page }) => {
  await page.goto('/system/usage-sync');
  const main = page.getByRole('main');
  await expect(main.getByText('已有有效查询结果', { exact: true })).toBeVisible();
  await expect(main.getByText('缺少有效查询结果', { exact: true })).toBeVisible();
  await expect(main.getByText(/^统计范围 [\d,]+ 人日$/)).toBeVisible();
  await expect(main).toContainText('1人日＝1账号×1天');
  await expect(main).toContainText('不代表整日或会话用量完整');
  await main.getByRole('button', { name: '日期口径', exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText('按北京时间业务日期统计官方查询结果');
});

test('session refresh queries the latest first page and keeps its search draft and selected detail tab with real API data', async ({ page }) => {
  await page.goto('/my/sessions');
  const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
  await search.fill('分页读取示例'); await page.getByRole('button', { name: '查询', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: '分页读取示例' });
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows).toHaveCount(2);
  await search.fill('尚未提交的筛选');
  const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/me/sessions');
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  const response = await refreshed; expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.get('search')).toBe('分页读取示例');
  expect(new URL(response.url()).searchParams.has('cursor')).toBe(false);
  expect((await response.json()).data.snapshot.id).toEqual(expect.any(String));
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('第 1 页 · 每页 20 条', {exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  expect(new URL(page.url()).searchParams.get('search')).toBe('分页读取示例');
  await expect(search).toHaveValue('尚未提交的筛选');
  await rows.first().getByRole('button', { name: '查看详情', exact: true }).click();
  const infoTab = page.getByRole('tab', { name: '会话信息', exact: true });
  await infoTab.click(); await expect(page.getByTestId('session-info')).toBeVisible();
  const directory = page.waitForResponse(r => /\/sessions\/[^/]+\/turns$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  expect((await directory).ok()).toBe(true);
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeEnabled();
  await expect(infoTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('session-info')).toBeVisible();
});
