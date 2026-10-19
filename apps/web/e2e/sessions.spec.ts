import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import { test, expect } from './helpers/browser.js';
import { readFileSync } from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pluginHookMaterial} from './helpers/plugin-material.js';
import {resetSyntheticHookFixture} from './helpers/registered-fixture.js';

test('D session detail stays inside the workspace, reads turns and bounded content, and returns to the same filtered list', async ({ page }) => {
  let automaticExternalRequests = 0;
  await page.route('https://example.invalid/**', route => { automaticExternalRequests++; return route.abort(); });
  const fixture = JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'), 'utf8'));
  await page.goto('/login'); await page.getByLabel('邮箱', { exact: true }).fill(fixture.analytics.managerEmail); await page.getByLabel('密码', { exact: true }).fill(fixture.analytics.managerPassword); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation', { name: '一级导航' }).getByRole('link', { name: '我的空间', exact: true }).click();
  await page.getByRole('complementary', { name: '当前工作区菜单' }).getByRole('link', { name: '我的Token使用分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的Token使用分析', exact: true })).toBeVisible();
  await page.getByLabel('搜索会话', { exact: true }).fill('PRIVATE_BROWSER_A'); await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'PRIVATE_BROWSER_A' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'PRIVATE_BROWSER_A' })).toContainText('会话完整性未知');
  const origin = page.url();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话详情', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '一级导航' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '当前工作区菜单' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /第 1 轮/ })).toBeVisible();
  await expect(page.getByTestId('session-trace')).toContainText('PRIVATE_BROWSER_A');
  await expect(page.getByTestId('session-trace').getByRole('heading', { name: '排版验收标题', exact: true })).toBeVisible();
  const response = page.getByTestId('session-content').filter({ has: page.getByRole('heading', { name: '排版验收标题', exact: true }) });
  await expect(response.locator('strong')).toHaveText('重点结论');
  await expect(response.getByRole('table')).toContainText('已核对');
  await expect(response.locator('pre code')).toContainText('const example = "safe";');
  await expect(response.getByRole('link', { name: '文档', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(response.locator('img, iframe, script, a[href^="javascript:"]')).toHaveCount(0);
  await response.getByRole('radio', { name: '原文', exact: true }).click();
  await expect(page.getByTestId('session-trace').getByRole('heading', { name: '排版验收标题', exact: true })).toHaveCount(0);
  const rawResponse = page.getByTestId('session-content').filter({ hasText: '# 排版验收标题' });
  await expect(rawResponse.locator('pre')).toContainText('**重点结论**');
  await rawResponse.getByRole('radio', { name: '原文', exact: true }).press('Home');
  await expect(response.getByRole('radio', { name: '排版', exact: true })).toBeChecked();
  await expect(page.getByTestId('session-trace')).toContainText('<script>window.__unsafeExecuted=true</script>');
  expect(await page.evaluate(() => Object.hasOwn(window, '__unsafeExecuted'))).toBe(false);
  expect(automaticExternalRequests).toBe(0);
  await expect(page.getByTestId('session-trace')).not.toContainText('ANSWER_END_MARKER');
  await page.getByRole('button', { name: '继续读取', exact: true }).click();
  await expect(page.getByTestId('session-trace')).toContainText('ANSWER_END_MARKER');
  await page.locator('summary').filter({ hasText: 'ReadFile · 工具步骤' }).click();
  await expect(page.getByTestId('session-trace')).toContainText('SYNTHETIC_TOOL_RESULT');
  await page.screenshot({ path: '.run/session-trace.png', fullPage: true });
  await page.getByRole('tab', { name: '原始事件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '原始事件', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '官方用量', exact: true }).click();
  await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');
  await expect(page.getByTestId('session-official-coverage')).toContainText('会话完整性未知');
  await expect(page.getByTestId('session-official-coverage')).toContainText('仅为已关联部分');
  await expect(page.getByTestId('session-official-usage')).toContainText('Synthetic Model');
  await expect(page.getByTestId('session-official-usage')).toContainText('企业统一接入');
  await expect(page.getByTestId('session-official-usage')).toContainText('来源标记未计价');
  await expect(page.getByTestId('session-official-usage')).toContainText('0.123456');
  await expect(page.getByTestId('session-official-usage')).toContainText('单 Hook 查询');
  await expect(page.getByRole('complementary',{name:'当前工作区菜单'})).toBeVisible();
  await page.route('**/api/v1/sessions/*/official-usage?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'source_unavailable',message:'合成用量查询暂不可用'}})}),{times:1});
  await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(page.getByTestId('session-official-usage').getByRole('alert')).toContainText('合成用量查询暂不可用');await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');await expect(page.getByTestId('session-official-usage').getByRole('alert')).toContainText('当前为上次结果');
  await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');await expect(page.getByTestId('session-official-usage').getByRole('alert')).toHaveCount(0);
  for(const id of ['content-estimate-tokens','observed-content-details','billing-simulation-details','token-check'])await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId('session-official-input')).toBeVisible();
  await page.getByRole('tab', { name: '会话信息', exact: true }).click();
  await expect(page.getByTestId('session-info')).toContainText(fixture.analytics.managerEmail);
  await page.screenshot({ path: '.run/session-detail.png', fullPage: true });
  await page.getByRole('button', { name: '返回原列表', exact: true }).click();
  await expect(page).toHaveURL(origin);
  await expect(page.getByLabel('搜索会话', { exact: true })).toHaveValue('PRIVATE_BROWSER_A');
  await expect(page.getByRole('row').filter({ hasText: 'PRIVATE_BROWSER_A' })).toHaveCount(1);
});


test('returning from detail restores the list scroll and next-page cursor without using browser back as pagination', async ({ page }) => {
  const fixture = JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'), 'utf8'));
  await page.goto('/login'); await page.getByLabel('邮箱', { exact: true }).fill(fixture.admin.email); await page.getByLabel('密码', { exact: true }).fill(fixture.admin.password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '我的空间', exact: true }).click();
  await page.getByRole('complementary').getByRole('link', { name: '我的Token使用分析', exact: true }).click();
  await page.getByLabel('搜索会话', { exact: true }).fill('分页读取示例'); await page.getByRole('button', { name: '查询', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: '分页读取示例' }); await expect(rows).toHaveCount(20);
  const last = rows.last().getByRole('button', { name: '查看详情', exact: true }); await last.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY); expect(scroll).toBeGreaterThan(300);
  await last.click(); await expect(page.getByRole('heading', { name: '会话详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回原列表', exact: true }).click(); await expect(rows).toHaveCount(20);
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(3);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows).toHaveCount(2); const secondPage = page.url();
  await rows.first().getByRole('button', { name: '查看详情', exact: true }).click(); await expect(page.getByRole('heading', { name: '会话详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回原列表', exact: true }).click(); await expect(page).toHaveURL(secondPage); await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(rows).toHaveCount(20); await expect(page.getByRole('heading', { name: '我的Token使用分析', exact: true })).toBeVisible();
});

test('real session cursor rejection recovers trace and raw pages independently',async({page})=>{
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
  await resetSyntheticHookFixture(page);const personal=(await pluginHookMaterial(page)).config;
  const source=randomUUID(),marker=`真实分页验收-${source}`,start=Date.now()-3600000;
  async function send(event_type:string,offset:number,payload:Record<string,unknown>){
    const sent=await page.request.post(e2eEnv.collectorURL+'/hooks',{headers:{authorization:`Bearer ${personal.token}`},data:{schema_version:2,installation_id:personal.installation_id,client_event_id:`${source}:${offset}`,source_session_id:source,occurred_at:new Date(start+offset).toISOString(),event_type,payload}});expect(sent.ok()).toBe(true);
  }
  // A newly issued installation can precede the collector's next policy
  // snapshot. HTTP 200 is fail-open, so establish persisted intake first using
  // the same event id on retries, without adding duplicate prompt turns.
  await expect.poll(async()=>{
    await send('UserPromptSubmit',1000,{prompt:`${marker} 第1轮`});
    const listed=await page.request.get(`/api/v1/me/sessions?search=${encodeURIComponent(marker)}`);return listed.ok()&&(await listed.json()).data.total===1;
  },{timeout:12000}).toBe(true);
  for(let turn=2;turn<=25;turn++){
    await send('UserPromptSubmit',turn*1000,{prompt:`${marker} 第${turn}轮`});
    if(turn===21)for(let step=1;step<=25;step++)await send('PreToolUse',turn*1000+step,{tool_use_id:`synthetic-tool-${step}`,tool_name:'ReadFile',tool_input:{path:`synthetic-${step}.ts`}});
  }
  let sessionId='';await expect.poll(async()=>{
    const listed=await page.request.get(`/api/v1/me/sessions?search=${encodeURIComponent(marker)}`);if(!listed.ok())return false;
    const item=((await listed.json()).data.items as Array<{id:string;source_session_id:string}>).find(item=>item.source_session_id===source);if(!item)return false;
    sessionId=item.id;const detail=await page.request.get(`/api/v1/sessions/${sessionId}`);if(!detail.ok())return false;const data=(await detail.json()).data;return data.projection_ready&&data.prompt_turns===25;
  },{timeout:15000}).toBe(true);
  await page.goto(`/my/sessions/${sessionId}`);await page.getByRole('button',{name:'下一组',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');
  await page.getByRole('tab',{name:'原始事件',exact:true}).click();await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');
  let corrupt:'raw'|'trace'|null=null;
  // Send a deliberately invalid cursor to the real API; the server itself must
  // reject it. Responses, first-page recovery, evidence and auth remain real.
  await page.route(`**/api/v1/sessions/${sessionId}/fragments?*`,route=>{
    const url=new URL(route.request().url()),mode=url.searchParams.get('mode')==='raw'?'raw':'trace';
    if(mode===corrupt&&url.searchParams.has('cursor'))url.searchParams.set('cursor','deliberately-invalid');
    return route.continue({url:url.href});
  });
  for(const section of ['raw','trace'] as const){
    if(section==='trace'){await page.getByRole('button',{name:'下一页事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');}
    await page.locator('.raw-event summary').first().click();await expect(page.locator('.raw-event').first()).toHaveJSProperty('open',true);
    corrupt=section;const denied=page.waitForResponse(reply=>reply.status()===400&&new URL(reply.url()).pathname===`/api/v1/sessions/${sessionId}/fragments`);
    await page.getByRole('button',{name:'重新加载',exact:true}).click();expect((await (await denied).json()).error.code).toBe('invalid_cursor');await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeEnabled();corrupt=null;
    await expect(page.getByRole('tab',{name:'原始事件',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('main')).toContainText(`原始事件第 ${section==='raw'?1:2} 页`);await expect(page.locator('.raw-event').first()).toHaveJSProperty('open',section!=='raw');
    await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();await expect(page.getByTestId('session-trace')).toContainText(`轨迹第 ${section==='raw'?2:1} 页`);await page.getByRole('tab',{name:'原始事件',exact:true}).click();
  }
  // Ordinary paging uses the same bounded recovery while the raw second page
  // remains independently readable, including its expanded source event.
  await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();corrupt='trace';
  const invalidTrace=page.waitForResponse(reply=>reply.status()===400&&new URL(reply.url()).pathname===`/api/v1/sessions/${sessionId}/fragments`);
  await page.getByRole('button',{name:'后段轨迹',exact:true}).click();expect((await (await invalidTrace).json()).error.code).toBe('invalid_cursor');await expect(page.getByRole('button',{name:'后段轨迹',exact:true})).toBeEnabled();corrupt=null;
  await expect(page.getByTestId('session-trace')).toContainText('轨迹第 1 页');await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'上一组',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 1 轮',exact:true})).toBeVisible();
  let corruptDirectory=true;
  await page.route(`**/api/v1/sessions/${sessionId}/turns?*`,route=>{const url=new URL(route.request().url());if(corruptDirectory&&url.searchParams.has('cursor'))url.searchParams.set('cursor','deliberately-invalid');return route.continue({url:url.href});});
  const invalidDirectory=page.waitForResponse(reply=>reply.status()===400&&new URL(reply.url()).pathname===`/api/v1/sessions/${sessionId}/turns`);
  await page.getByRole('button',{name:'下一组',exact:true}).click();expect((await (await invalidDirectory).json()).error.code).toBe('invalid_cursor');await expect(page.getByRole('button',{name:'下一组',exact:true})).toBeEnabled();corruptDirectory=false;await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 1 轮',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'原始事件',exact:true}).click();await expect(page.getByRole('main')).toContainText('原始事件第 2 页');await expect(page.locator('.raw-event').first()).toHaveJSProperty('open',true);
  await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await page.getByRole('button',{name:'下一组',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();await page.getByRole('button',{name:'后段轨迹',exact:true}).click();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');await page.getByRole('tab',{name:'原始事件',exact:true}).click();corrupt='raw';
  const invalidRaw=page.waitForResponse(reply=>reply.status()===400&&new URL(reply.url()).pathname===`/api/v1/sessions/${sessionId}/fragments`);
  await page.getByRole('button',{name:'下一页事件',exact:true}).click();expect((await (await invalidRaw).json()).error.code).toBe('invalid_cursor');await expect(page.getByRole('button',{name:'下一页事件',exact:true})).toBeEnabled();corrupt=null;await expect(page.getByRole('main')).toContainText('原始事件第 1 页');
  await page.getByRole('tab',{name:'执行轨迹',exact:true}).click();await expect(page.getByTestId('session-trace').getByRole('heading',{name:'第 21 轮',exact:true})).toBeVisible();await expect(page.getByTestId('session-trace')).toContainText('轨迹第 2 页');
});

test('bounded Markdown reading falls back to raw fragments after discarding the prefix and can restart', async ({ page }) => {
  const fixture = JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'), 'utf8'));
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(fixture.admin.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
  const listed = await page.request.get('/api/v1/me/sessions?search=MARKDOWN_WINDOW');
  expect(listed.status()).toBe(200);
  const session = (await listed.json()).data.items[0];
  await page.goto(`/my/sessions/${session.id}`);
  const response = page.getByTestId('session-content').filter({ hasText: 'CONTENT_WINDOW' });
  await expect(response.getByRole('heading', { name: '大段阅读标题', exact: true })).toBeVisible();
  await expect(response).toContainText('排版可能尚不完整');
  for (let index = 0; index < 9; index++) await response.getByRole('button', { name: '继续读取', exact: true }).click();
  await expect(response).toContainText('仅保留最近读取的片段，以原文显示');
  await expect(response).toContainText('TAIL_WINDOW_MARKER');
  await expect(response.getByRole('radio')).toHaveCount(0);
  await expect(response.locator('pre')).toContainText('```');
  await expect(response.getByRole('heading')).toHaveCount(0);
  await response.getByRole('button', { name: '从头读取', exact: true }).click();
  await expect(response.getByRole('heading', { name: '大段阅读标题', exact: true })).toBeVisible();
  await expect(response.getByRole('radio', { name: '排版', exact: true })).toBeChecked();
  await expect(response).not.toContainText('TAIL_WINDOW_MARKER');
});
