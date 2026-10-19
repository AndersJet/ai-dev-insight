import { test, expect } from './helpers/browser.js';

test('department dialog and long table remain usable during capture and responsive resizing', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill('e2e-root@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'adi_csrf')!.value;
  const listed = await page.request.get('/api/v1/departments');
  expect(listed.status()).toBe(200);
  const names = new Set((await listed.json()).data.map((row: { name: string }) => row.name));
  // A short table does not reproduce the overflow/column-width feedback path.
  for (let index = 0; index < 8; index++) {
    const name = `Resize Fixture ${index}`;
    if (!names.has(name)) {
      const response = await page.request.post('/api/v1/departments', { headers: { 'x-csrf-token': csrf }, data: { name } });
      expect(response.status()).toBe(201);
    }
  }
  await page.goto('/organization-management/departments');
  const department = page.getByRole('row').filter({ hasText: 'E2E统计A部门' });
  await department.getByRole('button', { name: '官方部门关联', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '官方部门关联', exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: '.run/department-dialog-responsive.png', fullPage: true, animations: 'disabled' });
  for (const width of [1024, 1440, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await dialog.getByRole('button', { name: 'Close this dialog', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(department.getByRole('link', { name: 'E2E统计A部门', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: '一级部门列表', exact: true });
  for (const width of [1440, 1280, 1024, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => table.evaluate(element => {
      const panel = element.closest('section')!;
      const style = getComputedStyle(panel);
      const available = panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const rendered = element.getBoundingClientRect().width;
      const widthIsValid = innerWidth >= 1280 ? Math.abs(rendered - available) <= 2 : rendered >= available - 2;
      return widthIsValid && document.documentElement.scrollWidth <= innerWidth + 2;
    })).toBe(true);
    await department.getByRole('button', { name: '配置管理员', exact: true }).click({ trial: true });
  }
  await page.screenshot({ path: '.run/departments-responsive.png', animations: 'disabled' });
});
