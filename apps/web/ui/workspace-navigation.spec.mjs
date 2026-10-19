import { test, expect } from '../e2e/helpers/browser.js';
import { mockPage, response, ids } from './fixtures.mjs';

for (const role of ['super', 'anc_admin', 'department_admin', 'employee']) {
  test(`${role} sees ordered workspace navigation and a disabled history entry`, async ({ page }) => {
    await mockPage(page, role);
    await page.route('**/api/v1/me', route => {
      const result = response(route.request().url(), 'GET', role);
      result.body.data.roles = [role];
      return route.fulfill({ status: 200, json: result.body });
    });
    await page.goto(role === 'employee' ? '/my/overview' : '/organization');
    const navigation = page.getByRole('navigation', { name: '一级导航', exact: true });
    await expect(navigation.getByRole('link')).toHaveText(role === 'employee' ? ['我的空间'] : role === 'super' ? ['我的空间', '组织分析', '组织管理', '系统运营'] : ['我的空间', '组织分析', '组织管理']);
    await expect(navigation.getByRole('button', { name: '历史查询 暂未开放', exact: true })).toBeDisabled();
    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByRole('link', { name: 'Token使用分析', exact: true })).toHaveCount(role === 'super' ? 1 : 0);
    await expect(sidebar.getByRole('link', { name: '代码流向追踪', exact: true })).toHaveCount(role === 'super' ? 1 : 0);
    await page.goto('/history');
    await expect(page.getByRole('main').getByRole('heading', { name: '历史查询暂未开放', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: '返回我的空间', exact: true })).toHaveAttribute('href', '/my/overview');
  });
}

test('legacy session links select the organization feature and keep department scope between features', async ({ page }) => {
  await mockPage(page);
  await page.goto(`/all/sessions?dept=${ids.department}`);
  const navigation = page.getByRole('navigation', { name: '一级导航', exact: true });
  const sidebar = page.getByRole('complementary');
  await expect(navigation.getByRole('link', { name: '组织分析', exact: true })).toHaveClass(/selected/);
  await expect(sidebar.getByRole('link', { name: 'Token使用分析', exact: true })).toHaveClass(/selected/);
  await sidebar.getByRole('link', { name: /产品体验部/ }).click();
  await expect(page).toHaveURL(new RegExp(`/all/sessions\\?[^#]*dept=${ids.second}`));
  await sidebar.getByRole('link', { name: '统计概览', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/organization/${ids.second}(?:\\?|$)`));
  await sidebar.getByRole('link', { name: '代码流向追踪', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/code-flow\\?dept=${ids.second}$`));
  await expect(sidebar.getByRole('link', { name: '代码流向追踪', exact: true })).toHaveClass(/selected/);
  await page.goto(`/all/sessions/${ids.session}?dept=${ids.department}`);
  await expect(navigation.getByRole('link', { name: '组织分析', exact: true })).toHaveClass(/selected/);
  await expect(sidebar.getByRole('link', { name: 'Token使用分析', exact: true })).toHaveClass(/selected/);
});
