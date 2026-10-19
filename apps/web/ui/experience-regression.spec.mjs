/* global window, document, Node */
import { URL } from 'node:url';
import { test, expect } from '../e2e/helpers/browser.js';
import { mockPage, response, ids } from './fixtures.mjs';

test('pending adoption is a statistic rather than a navigation action', async ({ page }) => {
  await mockPage(page);
  await page.goto('/organization');
  const progress = page.getByRole('region', { name: '采纳进度', exact: true });
  await expect(progress.getByText(/待采纳\s*6/)).toBeVisible();
  await expect(progress.getByRole('button', { name: /待采纳/ })).toHaveCount(0);
  await expect(progress.getByRole('link', { name: /待采纳/ })).toHaveCount(0);
  const before = page.url();
  await progress.getByText(/待采纳\s*6/).click();
  await expect(page).toHaveURL(before);
  await expect(progress.getByRole('button', { name: '刷新采纳状态', exact: true })).toBeEnabled();
});

test('official query results explain person-day coverage without claiming complete usage', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/system/usage-sync*', async route => {
    const result = response(route.request().url());
    result.body.data.coverage = {
      expected_user_days: 6, verified_user_days: 3, missing_user_days: 3,
      invalidated_user_days: 0, refreshing_user_days: 0,
      oldest_verified_at: null, complete: false,
    };
    await route.fulfill({ status: result.status, json: result.body });
  });
  await page.goto('/system/usage-sync');
  const main = page.getByRole('main');
  await expect(main.getByText('已有有效查询结果', { exact: true })).toBeVisible();
  await expect(main.getByText('统计范围 6 人日', { exact: true })).toBeVisible();
  await expect(main.getByText('缺少有效查询结果', { exact: true })).toBeVisible();
  await expect(main.getByText('3 人日', { exact: true })).toHaveCount(2);
  await expect(main).toContainText('1人日＝1账号×1天');
  await expect(main).toContainText('不代表整日或会话用量完整');
  await main.getByRole('button', { name: '日期口径', exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText('按北京时间业务日期统计官方查询结果');
  await expect(page.getByRole('tooltip')).not.toContainText('客户端时钟');
});

test('official usage summaries use the same query-result terminology and keep missing coverage visible', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/analytics/official-usage*', async route => {
    const result = response(route.request().url());
    Object.assign(result.body.data.coverage, {
      expected_user_days: 6, verified_user_days: 3, missing_user_days: 3, complete: false,
    });
    await route.fulfill({ status: result.status, json: result.body });
  });
  await page.goto('/organization');
  const panel = page.getByTestId('official-usage-panel');
  await expect(panel).toContainText('已有有效查询结果 3 / 6 人日');
  await expect(panel).toContainText('3 人日缺少有效查询结果');
  await expect(panel).toContainText('不代表整日或会话用量完整');
});

test('department columns fill the available desktop panel instead of leaving unused space', async ({ page }) => {
  await mockPage(page);
  await page.goto('/organization-management/departments');
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '一级部门 / 编码', exact: true }) });
  await expect(table.getByRole('cell', { name: /平台研发部/ })).toBeVisible();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => table.evaluate(element => {
      const panel = element.closest('section');
      const style = window.getComputedStyle(panel);
      const available = panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(element.getBoundingClientRect().width - available);
    })).toBeLessThanOrEqual(2);
  }
});

test('department names, administrators and actions stay readable through narrow and wide layouts', async ({ page }) => {
  await mockPage(page);
  const departmentName = '合成部门名称'.repeat(26).slice(0, 128);
  const adminName = 'SyntheticAdministrator'.repeat(6).slice(0, 128);
  await page.route('**/api/v1/departments', async route => {
    const result = response(route.request().url());
    result.body.data[0].name = departmentName;
    result.body.data[0].admins = Array.from({ length: 6 }, (_, index) => ({
      user_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
      display_name: index ? `合成管理员${index}` : adminName,
    }));
    result.body.data[1].name = 'DepartmentWithoutBreaks'.repeat(6).slice(0, 128);
    await route.fulfill({ status: result.status, json: result.body });
  });
  await page.goto('/organization-management/departments');
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '一级部门 / 编码', exact: true }) });
  await expect(table.getByRole('link', { name: departmentName, exact: true })).toBeVisible();
  await expect(table.getByText(adminName, { exact: true })).toBeVisible();
  for (const width of [1440, 1024, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => table.evaluate(element => {
      const headers = [...element.querySelectorAll('thead th')].map(node => node.getBoundingClientRect());
      const rows = [...element.querySelectorAll('tbody tr')];
      const failures = [];
      rows.forEach((row, rowIndex) => [...row.children].forEach((cell, index) => {
        const box = cell.getBoundingClientRect();
        if (Math.abs(box.left - headers[index].left) > 2 || Math.abs(box.right - headers[index].right) > 2) failures.push(`column alignment ${rowIndex}/${index}`);
        if (cell.scrollWidth > cell.clientWidth + 2) failures.push(`cell overflow ${rowIndex}/${index}: ${cell.scrollWidth}/${cell.clientWidth}`);
        const text = document.createTreeWalker(cell, Node.SHOW_TEXT);
        let node;
        while ((node = text.nextNode())) {
          if (!node.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(rect => rect.width && (rect.left < box.left - 2 || rect.right > box.right + 2))) failures.push(`text overflow ${rowIndex}/${index}: ${node.textContent.slice(0, 24)}`);
        }
      }));
      if (document.documentElement.scrollWidth > window.innerWidth + 2) failures.push(`document overflow ${document.documentElement.scrollWidth}/${window.innerWidth}`);
      return failures;
    })).toEqual([]);
    for (const row of await table.getByRole('row').all()) {
      for (const button of await row.getByRole('button').all()) {
        if (await button.isEnabled()) await button.click({ trial: true });
      }
    }
    await table.getByRole('button', { name: '重命名', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '重命名部门', exact: true });
    await expect(dialog.getByLabel('部门名称', { exact: true })).toHaveValue(departmentName);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await page.screenshot({ path: '.run/department-layout-implemented.png', fullPage: true, animations: 'disabled' });
});

test('session usage presents official breakdown and never requests retired estimates or checks', async ({ page }) => {
  await mockPage(page); const retired=[];
  page.on('request', request=>{if(/\/(billing-simulation|token-check)(?:\?|$)/.test(request.url()))retired.push(request.url());});
  await page.goto(`/my/sessions/${ids.session}`); await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  await expect(page.getByTestId('session-official-tokens')).toHaveText('24,680');
  await expect(page.getByTestId('session-official-input')).toHaveText('23,000');
  await expect(page.getByTestId('session-official-output')).toHaveText('1,680');
  await expect(page.getByTestId('session-official-cache_read')).toHaveText('18,000');
  await expect(page.getByTestId('session-official-cache_creation')).toHaveText('0');
  await expect(page.getByTestId('session-official-calls')).toHaveText('12');
  await expect(page.getByTestId('session-official-cache-hit-rate')).toHaveText('78.26%');
  for(const id of ['observed-content-details','billing-simulation-details','token-check'])await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByRole('button',{name:'重新加载',exact:true}).click(); await expect(page.getByTestId('session-official-output')).toHaveText('1,680');
  expect(retired).toEqual([]);
  await page.screenshot({path:'.run/official-usage-detail-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.getByTestId('session-official-input')).toBeVisible();await page.screenshot({path:'.run/official-usage-detail-narrow.png',fullPage:true});
  await page.getByRole('tab',{name:'执行轨迹',exact:true}).click(); await expect(page.getByTestId('session-content').getByText('请统一部门表单样式，并检查窄屏显示。',{exact:true})).toBeVisible();
});

test('default session evidence stays legacy while explicit trial evidence selects the trial view', async ({ page }) => {
  await mockPage(page);
  await page.goto(`/my/sessions/${ids.session}`);
  await page.getByRole('tab', { name: '官方用量', exact: true }).click();
  const panel = page.getByTestId('session-official-usage');
  await expect(panel.getByText('官方总 Tokens', { exact: true })).toBeVisible();
  await expect(panel.getByText('查看关联依据与时间', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('session-query-status')).toHaveCount(0);
  await page.route('**/api/v1/sessions/*/official-usage*', async route => {
    const result = response(route.request().url());
    result.body.data.session_query = { state: 'ready', reasons: [], observed_at: new Date().toISOString(), billing_ids: ['synthetic-trial-billing'], revision: '1' };
    await route.fulfill({ status: result.status, json: result.body });
  }, { times: 1 });
  await panel.getByRole('button', { name: '刷新显示', exact: true }).click();
  await expect(panel.getByTestId('session-query-status')).toContainText('官方用量已获取');
  await expect(panel.locator('.usage-kpis').getByText('官方总 Tokens', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');
  await expect(panel.getByTestId('session-official-coverage')).toBeVisible();
  await expect(panel.getByText('查看关联依据与时间', { exact: true })).toHaveCount(0);
});

test('multi-model official breakdown keeps missing cache separate from known zero and known output', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/sessions/*/official-usage*',async route=>{
    const result=response(route.request().url());
    result.body.data.groups[0].token_breakdown.cache_read={tokens:null,known_tokens:'9000',missing_token_records:1};
    result.body.data.groups.push({...result.body.data.groups[0],model_name:'企业模型',model_source:'Custom',records:1,tokens:'100',known_tokens:'100',calls:'2',known_calls:'2',token_breakdown:{input:{tokens:'90',known_tokens:'90',missing_token_records:0},output:{tokens:'10',known_tokens:'10',missing_token_records:0},cache_read:{tokens:'5',known_tokens:'5',missing_token_records:0},cache_creation:{tokens:'0',known_tokens:'0',missing_token_records:0}}});
    await route.fulfill({status:200,json:result.body});
  });
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  await expect(page.getByTestId('session-official-cache_read')).toContainText('数据不完整');
  await expect(page.getByTestId('session-official-cache_read')).toContainText('9,005');
  await expect(page.getByTestId('session-official-cache_creation')).toHaveText('0');
  await expect(page.getByTestId('session-official-output')).toHaveText('1,690');await expect(page.getByTestId('session-official-input')).toHaveText('23,090');await expect(page.getByTestId('session-official-tokens')).toHaveText('24,780');await expect(page.getByTestId('session-official-calls')).toHaveText('14');
});

test('official session evidence keeps conflicts visible and technical explanation collapsed', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/sessions/*/official-usage*', async route => {
    const result = response(route.request().url());
    Object.assign(result.body.data.attribution, {
      conflicting_ids: 1, requested_at: '2026-09-29T08:00:00.000Z', probe_revision: 2,
    });
    await route.fulfill({ status: result.status, json: result.body });
  });
  await page.goto(`/my/sessions/${ids.session}`);
  await page.getByRole('tab', { name: '官方用量', exact: true }).click();
  const panel = page.getByTestId('session-official-usage');
  await expect(panel.getByTestId('session-official-coverage')).toBeVisible();
  await expect(panel.getByText('存在多会话归因冲突，相关用量暂不计入本会话。', { exact: true })).toBeVisible();
  const revision = panel.getByText(/探查版本 2/);
  await expect(revision).not.toBeVisible();
  await panel.locator('summary').filter({ hasText: '查看关联依据与时间' }).click();
  await expect(revision).toBeVisible();
});

test('detail refresh preserves official disclosure and reading position during the request', async ({ page }) => {
  await mockPage(page);await page.setViewportSize({width:1440,height:700});
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  const panel=page.getByTestId('session-official-usage'),summary=panel.getByText('查看关联依据与时间',{exact:true});
  await summary.click();await expect(page.getByTestId('session-official-tokens')).toHaveText('24,680');
  await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready.then(()=>undefined));
  let release,reached;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{reached=resolve;});
  await page.route(`**/api/v1/sessions/${ids.session}`,async route=>{reached();await gate;await route.fulfill({status:200,json:response(route.request().url()).body});},{times:1});
  try{
    await page.getByRole('button',{name:'重新加载',exact:true}).click();await started;
    await expect(page.getByRole('tab',{name:'官方用量',exact:true})).toHaveAttribute('aria-selected','true');
    await summary.scrollIntoViewIfNeeded();const before=await summary.boundingBox();release();
    await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeEnabled();
    await expect(summary.locator('..')).toHaveJSProperty('open',true);
    await expect.poll(async()=>Math.abs((await summary.boundingBox()).y-before.y)).toBeLessThanOrEqual(2);
  }finally{release();}
});

test('detail refresh keeps same-period official evidence mounted while its replacement query is pending',async({page})=>{
  await mockPage(page);let calls=0,started,release;
  const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/v1/sessions/*/official-usage?*',async route=>{if(++calls===2){started();await gate;}await route.fulfill({status:200,json:response(route.request().url()).body});});
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();const panel=page.getByTestId('session-official-usage');
  await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');await panel.getByText('查看关联依据与时间',{exact:true}).click();
  try{
    await page.getByRole('button',{name:'重新加载',exact:true}).click();await pending;
    await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');await expect(panel.getByTestId('session-official-coverage')).toBeVisible();await expect(panel.getByText('查看关联依据与时间',{exact:true}).locator('..')).toHaveJSProperty('open',true);
  }finally{release();}
  await expect(panel.getByRole('button',{name:'刷新显示',exact:true})).toBeEnabled();await expect(panel.getByText('查看关联依据与时间',{exact:true}).locator('..')).toHaveJSProperty('open',true);
});

test('legacy list refresh retains its page, unapplied search and reading position', async ({ page }) => {
  await mockPage(page); await page.setViewportSize({ width: 1440, height: 700 });
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  let requests = 0; const searches = [];
  await page.route('**/api/v1/me/sessions*', async route => {
    searches.push(new URL(route.request().url()).searchParams.get('search'));
    if (++requests === 2) { reached(); await gate; }
    // This compatibility scenario deliberately has no published snapshot metadata.
    const result = response(route.request().url()); delete result.body.data.snapshot;
    const item = result.body.data.items[0];
    result.body.data.items = Array.from({ length: 20 }, (_, index) => ({ ...item,
      id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, title: `读取位置会话 ${index + 1}`,
    }));
    result.body.data.total = 40;
    await route.fulfill({ status: 200, json: result.body });
  });
  await page.goto('/my/sessions?page=2&cursor=valid&search=applied');
  const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
  await expect(page.getByText('第 2 页 · 每页 20 条', { exact: true })).toBeVisible();
  await search.fill('尚未提交的草稿');
  try {
    await page.getByRole('button', { name: '刷新列表', exact: true }).click(); await started;
    const row = page.getByRole('row').filter({ hasText: '读取位置会话 15' });
    await row.scrollIntoViewIfNeeded(); const before = await row.boundingBox();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    release();
    await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
    await expect(search).toHaveValue('尚未提交的草稿');
    await expect(page).toHaveURL(/page=2&cursor=valid&search=applied/);
    expect(searches).toEqual(['applied', 'applied']);
    await expect.poll(async () => Math.abs((await row.boundingBox()).y - before.y)).toBeLessThanOrEqual(2);
  } finally { release(); }
});

test('legacy invalidated list content is removed without collapsing the reading region during recovery', async ({ page }) => {
  await mockPage(page); await page.setViewportSize({ width: 1440, height: 700 });
  let releaseInvalid, invalidReached, releaseFresh, freshReached;
  const invalidGate = new Promise(resolve => { releaseInvalid = resolve; });
  const invalidStarted = new Promise(resolve => { invalidReached = resolve; });
  const freshGate = new Promise(resolve => { releaseFresh = resolve; });
  const freshStarted = new Promise(resolve => { freshReached = resolve; });
  let requests = 0;
  await page.route('**/api/v1/me/sessions*', async route => {
    const index = ++requests;
    if (index === 2) {
      invalidReached(); await invalidGate;
      await route.fulfill({ status: 400, json: { error: { code: 'invalid_cursor', message: '分页已失效', request_id: 'synthetic' } } });
      return;
    }
    if (index === 3) { freshReached(); await freshGate; }
    // Cursor repair for legacy responses must keep the existing reading region.
    const result = response(route.request().url()); delete result.body.data.snapshot;
    const item = result.body.data.items[0];
    result.body.data.items = Array.from({ length: 20 }, (_, row) => ({ ...item,
      id: `33333333-3333-4333-8333-${String(row).padStart(12, '0')}`, title: `${index === 1 ? '旧页' : '首页'}会话 ${row + 1}`,
    }));
    result.body.data.total = 40;
    await route.fulfill({ status: 200, json: result.body });
  });
  await page.goto('/my/sessions?page=2&cursor=expired');
  await expect(page.getByText('旧页会话 15', { exact: true })).toBeVisible();
  try {
    await page.getByRole('button', { name: '刷新列表', exact: true }).click(); await invalidStarted;
    await page.getByRole('row').filter({ hasText: '旧页会话 15' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    releaseInvalid(); await freshStarted;
    await expect(page.getByText('旧页会话 15', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    releaseFresh();
    await expect(page.getByText('第 1 页 · 每页 20 条', { exact: true })).toBeVisible();
    await expect(page.getByText('首页会话 15', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('列表分页已更新');
  } finally { releaseInvalid(); releaseFresh(); }
});

test('official usage refresh retains its displayed result and disclosure through a transient failure', async ({ page }) => {
  await mockPage(page);
  await page.goto(`/my/sessions/${ids.session}`);
  await page.getByRole('tab', { name: '官方用量', exact: true }).click();
  const panel = page.getByTestId('session-official-usage');
  await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');
  await panel.getByText('查看关联依据与时间', { exact: true }).click();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/v1/sessions/*/official-usage?*', async route => {
    reached(); await gate;
    await route.fulfill({ status: 503, json: { error: { code: 'source_unavailable', message: '合成临时故障' } } });
  }, { times: 1 });
  try {
    await panel.getByRole('button', { name: '刷新显示', exact: true }).click(); await started;
    await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');
    await expect(panel.getByText('查看关联依据与时间', { exact: true }).locator('..')).toHaveJSProperty('open', true);
    release();
    await expect(panel.getByRole('alert')).toContainText('当前为上次结果');
    await expect(panel.getByTestId('session-official-tokens')).toHaveText('24,680');
    await panel.getByRole('button', { name: '刷新显示', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByText('查看关联依据与时间', { exact: true }).locator('..')).toHaveJSProperty('open', true);
  } finally { release(); }
});

test('older official response still shows total and calls with unavailable breakdown', async ({ page }) => {
  await mockPage(page);await page.route('**/api/v1/sessions/*/official-usage*',async route=>{
    const result=response(route.request().url());delete result.body.data.groups[0].token_breakdown;await route.fulfill({status:200,json:result.body});
  });
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  await expect(page.getByTestId('session-official-tokens')).toHaveText('24,680');await expect(page.getByTestId('session-official-calls')).toHaveText('12');
  await expect(page.getByTestId('session-official-input')).not.toBeVisible();
});

for (const endpoint of ['official-usage']) {
  test(`${endpoint} removes displayed results when refresh is forbidden`, async ({ page }) => {
    await mockPage(page); await page.goto(`/my/sessions/${ids.session}`);
    await page.getByRole('tab', { name: '官方用量', exact: true }).click();
    const official = endpoint === 'official-usage';
    const panel = page.getByTestId(official ? 'session-official-usage' : 'token-check');
    await expect(panel.getByText(official ? '查看关联依据与时间' : '查看原因与核查明细', { exact: true })).toBeVisible();
    await page.route(`**/api/v1/sessions/*/${endpoint}*`, route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '已失去读取权限' } } }), { times: 1 });
    await panel.getByRole('button', { name: official ? '刷新显示' : '刷新检查结果', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('已失去读取权限');
    await expect(panel.locator('details')).toHaveCount(0);
    if (official) await expect(panel.getByTestId('session-official-tokens')).not.toBeVisible();
    else await expect(panel.getByRole('status')).toHaveCount(0);
  });
}

test('adoption refresh keeps the last counts on a temporary failure and clears them on denial', async ({ page }) => {
  await mockPage(page); await page.goto('/organization');
  const panel = page.getByRole('region', { name: '采纳进度', exact: true });
  await expect(panel.getByText(/待采纳\s*6/)).toBeVisible();
  await page.route('**/api/v1/adoption?*', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '合成统计暂不可用' } } }), { times: 1 });
  await panel.getByRole('button', { name: '刷新采纳状态', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('当前为上次结果');
  await expect(panel.getByText(/待采纳\s*6/)).toBeVisible();
  await page.route('**/api/v1/adoption?*', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '合成权限已撤销' } } }), { times: 1 });
  await panel.getByRole('button', { name: '刷新采纳状态', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('合成权限已撤销');
  await expect(panel.getByText(/待采纳\s*6/)).toHaveCount(0);
});

test('operations refresh retains its last status snapshot on temporary failure', async ({ page }) => {
  await mockPage(page); await page.goto('/system/health');
  await page.getByText('可见页面每10秒刷新', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '可见页面每10秒刷新', exact: true })).not.toBeChecked();
  const count = page.getByTestId('operations-received');
  await expect(count).toBeVisible(); const previous = await count.innerText();
  const snapshot = page.getByText(/^状态快照：/); const asOf = await snapshot.innerText();
  await page.route('**/api/v1/system/health', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '合成运营暂不可用' } } }), { times: 1 });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert').filter({ hasText: '合成运营暂不可用' })).toContainText('当前为上次结果');
  await expect(count).toHaveText(previous); await expect(snapshot).toHaveText(asOf);
  await page.route('**/api/v1/system/health', route => route.fulfill({ status: 409, json: { error: { code: 'content_changed', message: '观测已失效' } } }), { times: 1 });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('观测已失效');
  await expect(count).toHaveCount(0);
});

test('analytics refresh preserves the comparison page, model choices and drafts while replacing results', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/analytics/departments?*', async route => {
    const result = response(route.request().url());
    result.body.data.total = 11;
    result.body.data.has_more = !new URL(route.request().url()).searchParams.has('cursor');
    result.body.data.next_cursor = result.body.data.has_more ? 'department-page-2' : null;
    await route.fulfill({ status: 200, json: result.body });
  });
  await page.goto('/organization');
  const comparison = page.locator('section').filter({ has: page.getByRole('heading', { name: '一级部门对比', exact: true }) });
  await comparison.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(comparison).toContainText('共 11 个部门 · 第 2 页');
  await page.getByRole('textbox', { name: '搜索统计部门', exact: true }).fill('部门草稿');
  const models = page.getByTestId('model-analysis');
  await models.getByRole('radio', { name: 'CUE 补全', exact: true }).click();
  await models.getByRole('textbox', { name: '搜索本人确认模型', exact: true }).fill('模型草稿');
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/v1/analytics/overview?*', async route => {
    reached(); await gate;
    const result = response(route.request().url()); result.body.data.prompt_turns = 999;
    await route.fulfill({ status: 200, json: result.body });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: '刷新统计', exact: true }).click(); await started;
    await expect(page.getByTestId('metric-prompts')).toContainText('324');
    await expect(comparison).toContainText('共 11 个部门 · 第 2 页');
    await expect(models.getByRole('textbox', { name: '搜索本人确认模型', exact: true })).toHaveValue('模型草稿');
    await models.scrollIntoViewIfNeeded(); const before = await models.boundingBox();
    release(); await expect(page.getByRole('button', { name: '刷新统计', exact: true })).toBeEnabled();
    await expect(page.getByTestId('metric-prompts')).toContainText('999');
    await expect(comparison).toContainText('共 11 个部门 · 第 2 页');
    await expect(page.getByRole('textbox', { name: '搜索统计部门', exact: true })).toHaveValue('部门草稿');
    await expect(models.getByRole('textbox', { name: '搜索本人确认模型', exact: true })).toHaveValue('模型草稿');
    await expect(models.getByRole('radio', { name: 'CUE 补全', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => Math.abs((await models.boundingBox()).y - before.y)).toBeLessThanOrEqual(2);
  } finally { release(); }
});

for (const endpoint of ['overview', 'official-usage']) {
  test(`analytics ${endpoint} refresh labels retained results and clears the scope on denial`, async ({ page }) => {
    await mockPage(page); await page.goto('/organization');
    await expect(page.getByTestId('metric-prompts')).toContainText('324');
    await expect(page.getByTestId('official-usage-panel')).toBeVisible();
    await page.route(`**/api/v1/analytics/${endpoint}?*`, route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '合成统计暂不可用' } } }), { times: 1 });
    await page.getByRole('button', { name: '刷新统计', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert').filter({ hasText: '合成统计暂不可用' })).toContainText('当前为上次结果');
    await expect(page.getByTestId('metric-prompts')).toContainText('324');
    await expect(page.getByTestId('official-usage-panel')).toBeVisible();
    await page.route(`**/api/v1/analytics/${endpoint}?*`, route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '该统计范围已撤销' } } }), { times: 1 });
    await page.getByRole('button', { name: '刷新统计', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('该统计范围已撤销');
    await expect(page.getByTestId('metric-prompts')).toHaveCount(0);
    await expect(page.getByTestId('model-analysis')).toHaveCount(0);
    await expect(page.getByTestId('official-usage-panel')).toHaveCount(0);
  });
}

test('model refresh and page refresh retain both model pages and unapplied model search', async ({ page }) => {
  await mockPage(page);
  const searches = []; let updated = false;
  for (const endpoint of ['models', 'declared-models']) {
    await page.route(`**/api/v1/analytics/${endpoint}?*`, async route => {
      const url = new URL(route.request().url());
      if (endpoint === 'declared-models') searches.push(url.searchParams.get('search'));
      const result = response(route.request().url());
      result.body.data.total = 11;
      result.body.data.has_more = !url.searchParams.has('cursor');
      result.body.data.next_cursor = result.body.data.has_more ? 'model-page-2' : null;
      if (updated && endpoint === 'models') result.body.data.items[0].tokens = '98765';
      await route.fulfill({ status: 200, json: result.body });
    });
  }
  await page.goto('/organization');
  const panel = page.getByTestId('model-analysis');
  await panel.getByRole('button', { name: '下一页', exact: true }).nth(0).click();
  await expect(panel).toContainText('共 11 个模型分组 · 第 2 页');
  await panel.getByRole('button', { name: '下一页', exact: true }).nth(1).click();
  await expect(panel).toContainText('共 11 个名称 · 第 2 页');
  const draft = panel.getByRole('textbox', { name: '搜索本人确认模型', exact: true }); await draft.fill('未应用的模型草稿');
  await panel.getByRole('button', { name: '刷新模型统计', exact: true }).click();
  await expect(panel.getByRole('button', { name: '刷新模型统计', exact: true })).toBeEnabled();
  await expect(panel).toContainText('共 11 个模型分组 · 第 2 页');
  await expect(panel).toContainText('共 11 个名称 · 第 2 页');
  updated = true;
  await page.getByRole('button', { name: '刷新统计', exact: true }).click();
  await expect(panel.getByTestId('official-model-table')).toContainText('98,765');
  await expect(panel).toContainText('共 11 个模型分组 · 第 2 页');
  await expect(panel).toContainText('共 11 个名称 · 第 2 页');
  await expect(draft).toHaveValue('未应用的模型草稿');
  expect(searches.every(value => value === '')).toBe(true);
});

for (const endpoint of ['models', 'declared-models']) {
  test(`${endpoint} refresh retains temporary failures but revokes the containing statistics on denial`, async ({ page }) => {
    await mockPage(page); await page.goto('/organization');
    const panel = page.getByTestId('model-analysis');
    const table = panel.getByTestId(endpoint === 'models' ? 'official-model-table' : 'declared-model-table');
    await expect(table).toBeVisible(); const value = await table.innerText();
    await page.route(`**/api/v1/analytics/${endpoint}?*`, route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '合成模型暂不可用' } } }), { times: 1 });
    await panel.getByRole('button', { name: '刷新模型统计', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('当前为上次结果');
    await expect(table).toHaveText(value, { useInnerText: true });
    await page.route(`**/api/v1/analytics/${endpoint}?*`, route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '模型统计范围已撤销' } } }), { times: 1 });
    await panel.getByRole('button', { name: '刷新模型统计', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('模型统计范围已撤销');
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('metric-prompts')).toHaveCount(0);
  });
}

for (const invalidated of ['departments', 'models', 'declared-models']) {
  test(`${invalidated} expired pagination recovers only its own statistics region`, async ({ page }) => {
    await mockPage(page); let expire = false;
    for (const endpoint of ['departments', 'models', 'declared-models']) {
      await page.route(`**/api/v1/analytics/${endpoint}?*`, async route => {
        const later = new URL(route.request().url()).searchParams.has('cursor');
        if (expire && later && endpoint === invalidated) {
          await route.fulfill({ status: 400, json: { error: { code: 'invalid_cursor', message: '合成分页已过期' } } }); return;
        }
        const result = response(route.request().url());
        result.body.data.total = 11; result.body.data.has_more = !later;
        result.body.data.next_cursor = later ? null : 'second-page';
        await route.fulfill({ status: 200, json: result.body });
      });
    }
    await page.goto('/organization');
    const comparison = page.locator('section').filter({ has: page.getByRole('heading', { name: '一级部门对比', exact: true }) });
    const models = page.getByTestId('model-analysis');
    await comparison.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(comparison).toContainText('共 11 个部门 · 第 2 页');
    await models.getByRole('button', { name: '下一页', exact: true }).nth(0).click();
    await expect(models).toContainText('共 11 个模型分组 · 第 2 页');
    await models.getByRole('button', { name: '下一页', exact: true }).nth(1).click();
    await expect(models).toContainText('共 11 个名称 · 第 2 页');
    await models.getByRole('textbox', { name: '搜索本人确认模型', exact: true }).fill('保留的草稿');
    expire = true;
    await page.getByRole('button', { name: '刷新统计', exact: true }).click();
    await expect(comparison).toContainText(`共 11 个部门 · 第 ${invalidated === 'departments' ? 1 : 2} 页`);
    await expect(models).toContainText(`共 11 个模型分组 · 第 ${invalidated === 'models' ? 1 : 2} 页`);
    await expect(models).toContainText(`共 11 个名称 · 第 ${invalidated === 'declared-models' ? 1 : 2} 页`);
    await expect(page.getByRole('main').getByRole('alert').filter({ hasText: '分页已更新' })).toContainText('已回到第一页');
    await expect(models.getByRole('textbox', { name: '搜索本人确认模型', exact: true })).toHaveValue('保留的草稿');
  });
}

test('a denied model read prevents a pending parent refresh from restoring the withdrawn statistics', async ({ page }) => {
  await mockPage(page); await page.goto('/organization');
  const panel = page.getByTestId('model-analysis');
  await expect(panel.getByTestId('official-model-table')).toBeVisible();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/v1/analytics/overview?*', async route => {
    reached(); await gate;
    await route.fulfill({ status: 200, json: response(route.request().url()).body });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: '刷新统计', exact: true }).click(); await started;
    await page.route('**/api/v1/analytics/models?*', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '统计授权已撤销' } } }), { times: 1 });
    await panel.getByRole('button', { name: '刷新模型统计', exact: true }).click();
    await expect(panel).toHaveCount(0);
    const lateResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/analytics/overview');
    release(); await (await lateResponse).finished(); await page.waitForLoadState('networkidle');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('统计授权已撤销');
    await expect(panel).toHaveCount(0); await expect(page.getByTestId('metric-prompts')).toHaveCount(0);
  } finally { release(); }
});
