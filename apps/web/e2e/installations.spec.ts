import {environment as e2eEnv} from './helpers/environment.mjs';
import { test, expect } from './helpers/browser.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { registeredFixture } from './helpers/registered-fixture.js';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login'); await page.getByLabel('邮箱', { exact: true }).fill('e2e-root@example.invalid'); await page.getByLabel('密码', { exact: true }).fill('e2e-admin-test-password'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  const me = (await (await page.request.get('/api/v1/me')).json()).data;
  if (!me.registered) { await registeredFixture(me.user_id); await page.reload(); }
  return me;
}

test('normal web login retrieves one shared plugin code and lists distinct sources without retired installer controls', async ({ page }) => {
  await login(page); await page.goto('/my/installations');
  await expect(page.getByRole('heading', { name: '账号共用插件 API 码', exact: true })).toBeVisible();
  const retrieved = page.waitForResponse(response => response.url().endsWith('/api/v1/me/plugin-credential') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '显示 API 码', exact: true }).click();
  const issued = (await (await retrieved).json()).data;
  await expect(page.getByLabel('插件 API 码', { exact: true })).toHaveText(issued.api_token);
  await page.getByRole('button', { name: '隐藏 API 码', exact: true }).click();
  await expect(page.getByRole('main')).not.toContainText(issued.api_token);
  const again = page.waitForResponse(response => response.url().endsWith('/api/v1/me/plugin-credential') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '显示 API 码', exact: true }).click();
  expect((await (await again).json()).data.api_token).toBe(issued.api_token);
  await page.getByRole('button', { name: '隐藏 API 码', exact: true }).click();
  const sources = [];
  for (const platform of ['windows', 'macos']) {
    const source = await page.request.post('/api/v1/plugin/sources', { headers: { authorization: `Bearer ${issued.api_token}` }, data: { source_secret: randomBytes(32).toString('base64url'), source_config_id: randomUUID(), platform, plugin_version: '0.3.0' } });
    expect(source.status()).toBe(200); sources.push((await source.json()).data.collector_id);
  }
  await page.getByRole('button', { name: '刷新采集状态', exact: true }).click();
  for (const id of sources) await expect(page.getByRole('row').filter({ hasText: id })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('不代表当前在线');
  for (const name of ['下载个人安装包', '生成在线安装命令', '撤销采集凭据', '重置采集凭据']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  const summary = (await (await page.request.get('/api/v1/me/plugin-credential')).json()).data; expect(summary).not.toHaveProperty('api_token');
  expect((await page.request.post('/api/v1/me/collection-install-command', { data: {} })).status()).not.toBe(200);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(issued.api_token);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('superadmin collection management is a read-only Hook summary and cannot show another user plugin code', async ({ page }) => {
  await login(page);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'adi_csrf')!.value;
  const department = await page.request.post('/api/v1/departments', { headers: { 'x-csrf-token': csrf }, data: { name: `采集摘要部门-${randomUUID()}` } }), departmentId = (await department.json()).data.id;
  const { openDatabase } = await import('../../../packages/storage/src/index.js');
  const db = openDatabase({ connectionString: e2eEnv.databaseURL, schema: e2eEnv.schema });
  const userId = randomUUID();
  try {
    await db.query('INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,$2,$3,now())', [userId, `${userId}@example.invalid`, '采集摘要员工']);
    await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,now())', [userId, departmentId]);
  } finally { await db.close(); }
  await page.goto(`/organization-management/${departmentId}/members`);
  await page.getByRole('row').filter({ hasText: '采集摘要员工' }).getByRole('button', { name: '更多', exact: true }).click(); await page.getByText('采集安装管理', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '采集摘要员工 · 采集安装' }); await expect(dialog.getByRole('heading', { name: '共用 Hook 凭据摘要', exact: true })).toBeVisible();
  for (const name of ['显示 API 码', '复制 API 码', '撤销采集凭据', '重置采集凭据']) await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/admin/users/${userId}/plugin-credential`)).status()).not.toBe(200);
});
