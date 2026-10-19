/* global document, window */
import { test, expect } from '@playwright/test';
import { mockPage, ids, response } from './fixtures.mjs';

test('个人概览移除估算与说明，三个模块在宽屏同一行等高且窄屏不溢出', async ({ page }) => {
  const estimates = [];
  page.on('request', request => { if (request.url().includes('/analytics/content-estimate')) estimates.push(request.url()); });
  await mockPage(page, 'employee');
  await page.goto('/my/overview');
  const panels = page.locator('.personal-analysis-grid .data-panel');
  await expect(panels).toHaveCount(3);
  await expect(panels.locator('h2')).toHaveText(['我的使用复盘', '使用趋势', '工作用途']);
  await expect(page.getByRole('heading', { name: '内容量估算', exact: true })).toHaveCount(0);
  await expect(page.getByText('如何理解这些数据', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: '每日提示轮次趋势' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => panels.evaluateAll(elements => {
      const boxes = elements.map(element => element.getBoundingClientRect());
      return Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top))
        + Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height));
    })).toBeLessThanOrEqual(2);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: test.info().outputPath('personal-desktop.png'), fullPage: true });
  await page.locator('.personal-analysis-grid').screenshot({ path: test.info().outputPath('personal-three-cards.png') });
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    const boxes = await panels.evaluateAll(elements => elements.map(element => {
      const { top, bottom } = element.getBoundingClientRect(); return { top, bottom };
    }));
    expect(boxes[1].top).toBeGreaterThanOrEqual(boxes[0].bottom);
    expect(boxes[2].top).toBeGreaterThanOrEqual(boxes[1].bottom);
  }
  await page.screenshot({ path: test.info().outputPath('personal-mobile.png'), fullPage: true });
  expect(estimates).toEqual([]);
});

test('组织统计概览与部门概览不显示或请求估算模块，保留统计和趋势', async ({ page }) => {
  const estimates = [];
  page.on('request', request => { if (request.url().includes('/analytics/content-estimate')) estimates.push(request.url()); });
  await mockPage(page);
  for (const path of ['/organization', `/organization/${ids.department}`]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: path === '/organization' ? '一级部门对比' : '成员使用统计', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '内容量估算', exact: true })).toHaveCount(0);
    await expect(page.getByText('如何理解这些数据', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '使用趋势', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作用途', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath('organization-desktop.png'), fullPage: true });
  expect(estimates).toEqual([]);
});

test('未配置官方来源时不再提示查看已移除的内容估算', async ({ page }) => {
  await mockPage(page, 'employee');
  await page.route('**/api/v1/analytics/official-usage*', route => {
    const result = response(route.request().url(), 'GET', 'employee'); result.body.data.configured = false;
    return route.fulfill({ status: 200, json: result.body });
  });
  await page.goto('/my/overview');
  await expect(page.getByTestId('official-usage-panel')).toContainText('当前仍可查看 Hook 观测统计');
  await expect(page.getByTestId('official-usage-panel')).not.toContainText('内容量估算');
});

test('成员统计详情保留原有估算和数据说明', async ({ page }) => {
  await mockPage(page);
  await page.goto(`/organization/${ids.department}/members/${ids.user}`);
  await expect(page.getByRole('heading', { name: '成员使用概览', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '内容量估算', exact: true })).toBeVisible();
  await expect(page.getByText('如何理解这些数据', { exact: true })).toBeVisible();
});

test('九类工作用途在卡片内部滚动，三卡高度受限且键盘可到达最后一类', async ({ page }) => {
  await mockPage(page, 'employee');
  const categories = ['feature', 'bugfix', 'refactor', 'test', 'docs', 'ops', 'learning', 'chat', 'unknown'];
  await page.route('**/api/v1/analytics/purposes*', route => {
    const result = response(route.request().url(), 'GET', 'employee');
    const sample = result.body.data.items[0];
    result.body.data.total_sessions = 45;
    result.body.data.items = categories.map((purpose, index) => ({ ...sample, purpose, sessions: 9 - index, ratio: (9 - index) / 45 }));
    return route.fulfill({ status: 200, json: result.body });
  });
  await page.goto('/my/overview');
  const panels = page.locator('.personal-analysis-grid .data-panel');
  const list = page.getByRole('region', { name: '工作用途分类列表', exact: true });
  await expect(list.locator('.purpose-row')).toHaveCount(9);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => panels.evaluateAll(elements => Math.max(...elements.map(element => element.getBoundingClientRect().height)))).toBeLessThanOrEqual(361);
    if (width > 1200) {
      const boxes = await panels.evaluateAll(elements => elements.map(element => {
        const { top, height } = element.getBoundingClientRect(); return { top, height };
      }));
      expect(Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top))).toBeLessThanOrEqual(1);
      expect(Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height))).toBeLessThanOrEqual(1);
    }
    await list.evaluate(element => { element.scrollTop = 0; });
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
    await list.scrollIntoViewIfNeeded();
    await list.hover();
    const pageTop = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 180);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - pageTop)).toBeLessThanOrEqual(1);
    await list.evaluate(element => { element.scrollTop = 0; });
    await list.focus();
    const footer = panels.last().locator('.panel-footer');
    const footerTop = (await footer.boundingBox()).y;
    await page.keyboard.press('End');
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(list.locator('[data-purpose="unknown"]')).toBeInViewport();
    expect(Math.abs((await footer.boundingBox()).y - footerTop)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    if (width === 1440) await page.locator('.personal-analysis-grid').screenshot({ path: test.info().outputPath('personal-many-categories.png') });
    if (width === 390) await panels.last().screenshot({ path: test.info().outputPath('purpose-many-categories-mobile.png') });
  }
});
