/* global window, MessageEvent */
import { test, expect } from '../e2e/helpers/browser.js';
import { mockPage, response, ids } from './fixtures.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
const html = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import {overviewHtml} from './trae-plugin/src/overview-ui.ts';process.stdout.write(overviewHtml());"], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });

test('unreported official fields are absent from plugin display rather than empty metrics', async ({ page }) => {
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: () => {} }); });
  await page.goto('about:blank'); await page.setContent(html);
  await expect(page.locator('#chat-input')).not.toBeVisible({timeout:1000});
});

test('unreported official fields are absent from session cards and table columns', async ({ page }) => {
  await mockPage(page);
  await page.route('**/api/v1/sessions/*/official-usage*', route => {
    const result = response(route.request().url()); delete result.body.data.groups[0].token_breakdown;
    return route.fulfill({ status: 200, json: result.body });
  });
  await page.goto(`/my/sessions/${ids.session}`); await page.getByRole('tab', { name: '官方用量', exact: true }).click();
  await expect(page.getByTestId('session-official-tokens')).toHaveText('24,680');
  await expect(page.getByTestId('session-official-calls')).toHaveText('12');
  for (const key of ['input', 'output', 'cache_read', 'cache_creation']) await expect(page.getByTestId(`session-official-${key}`)).not.toBeVisible();
  await expect(page.getByRole('columnheader', { name: '输入 Tokens', exact: true })).toHaveCount(0);
});

test('original legacy plugin response keeps actual total but never reveals absent breakdown', async ({ page }) => {
 await page.setViewportSize({width:360,height:900});
 await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({postMessage:()=>{}});});await page.goto('about:blank');await page.setContent(html);
 await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:{badge:'已接入',email:'synthetic@example.invalid',origin:'http://example.invalid',git:'已保存',hook:'已安装',today:{data:{business_date:'2026-10-12',as_of:'2026-10-12T08:00:00Z',official_chat_tokens:'100',official_cue_tokens:null,hook_sessions:1,prompt_turns:1},stale:false}}}})));
 await expect(page.locator('#chat')).toHaveText('100');
 for(const key of ['input','output','cache_read','cache_creation','calls'])await expect(page.locator(`#chat-${key}`)).not.toBeVisible();
 await expect(page.locator('#cue-card')).not.toBeVisible();await page.screenshot({path:'.run/plugin-reported-only.png',fullPage:true});
});
for(const scenario of ['all_missing','reported_zero','partial_zero']){
 test(`official field availability respects ${scenario} rather than assuming unavailable counters are zero`,async({page})=>{
  await mockPage(page);await page.route('**/api/v1/sessions/*/official-usage*',route=>{
   const result=response(route.request().url()),row=result.body.data.groups[0];row.records=scenario==='partial_zero'?2:1;
   const q=scenario==='reported_zero'?{tokens:'0',known_tokens:'0',missing_token_records:0}:{tokens:null,known_tokens:'0',missing_token_records:1};
   row.token_breakdown={input:{...q},output:{...q},cache_read:{...q},cache_creation:{...q}};
   return route.fulfill({status:200,json:result.body});
  });
  await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  const input=page.getByTestId('session-official-input');
  if(scenario==='all_missing'){await expect(input).not.toBeVisible();await expect(page.getByRole('columnheader',{name:'输入 Tokens',exact:true})).toHaveCount(0);}
  else if(scenario==='reported_zero')await expect(input).toHaveText('0');
  else{await expect(input).toContainText('已知 0');await expect(input).toContainText('数据不完整');}
 });
}

test('reported zero cache reads produce a zero token hit rate while zero input produces no rate',async({page})=>{
 await mockPage(page);let zeroInput=false;
 await page.route('**/api/v1/sessions/*/official-usage*',route=>{const result=response(route.request().url()),q=tokens=>({tokens,known_tokens:tokens,missing_token_records:0});
 result.body.data.groups[0].token_breakdown={input:q(zeroInput?'0':'1000'),output:q('10'),cache_read:q('0'),cache_creation:q('0')};
 return route.fulfill({status:200,json:result.body});});
 await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
 await expect(page.getByTestId('session-official-cache-hit-rate')).toHaveText('0.00%');
 zeroInput=true;await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(page.getByTestId('session-official-cache-hit-rate')).toHaveCount(0);
});
