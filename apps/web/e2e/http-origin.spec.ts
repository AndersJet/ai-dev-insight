import {environment as e2eEnv} from './helpers/environment.mjs';
import { test, expect } from './helpers/browser.js';
import { registeredFixture } from './helpers/registered-fixture.js';

test('plain HTTP hostname supports normal web login and explicit shared code viewing', async ({ page }) => {
  test.skip(process.env.ADI_E2E_HTTP !== 'true', 'Run the dedicated HTTP-origin profile');
  await page.goto(e2eEnv.httpWebURL+'/manual'); await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.getByLabel('邮箱', { exact: true }).fill('e2e-root@example.invalid'); await page.getByLabel('密码', { exact: true }).fill('e2e-admin-test-password'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  const cookie = (await page.context().cookies()).find(item => item.name === 'adi_session'); expect(cookie).toBeDefined(); expect(cookie!.secure).toBe(false); expect(cookie!.httpOnly).toBe(true);
  const me = await page.evaluate(async () => (await (await fetch('/api/v1/me')).json()).data);
  if (!me.registered) { await registeredFixture(me.user_id); await page.reload(); }
  await expect(page).toHaveURL(/\/my\/installations$/);
  await expect(page.getByLabel('插件 API 码', { exact: true })).not.toHaveText(/adi_api_v2/);
  await page.getByRole('button', { name: '显示 API 码', exact: true }).click();
  await expect(page.getByLabel('插件 API 码', { exact: true })).toHaveText(/^adi_api_v2\.[A-Za-z0-9_-]{43}$/);
  await page.screenshot({ path: '.run/http-origin-shared-code.png', fullPage: true, mask: [page.getByLabel('插件 API 码', { exact: true })] });
  await page.getByRole('button', { name: '隐藏 API 码', exact: true }).click(); await expect(page.getByLabel('插件 API 码', { exact: true })).not.toHaveText(/adi_api_v2/);
  await expect(page.getByRole('button', { name: '下载个人安装包', exact: true })).toHaveCount(0);
});
