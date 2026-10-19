/* global window, MessageEvent */
import {test,expect} from '../e2e/helpers/browser.js';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,URL} from 'node:url';
import process from 'node:process';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const html=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {overviewHtml} from './trae-plugin/src/overview-ui.ts';process.stdout.write(overviewHtml());"],{cwd:root,encoding:'utf8'});
const q=(tokens,known_tokens=tokens??'0',missing_token_records=0)=>({tokens,known_tokens,missing_token_records});
const usage={records:1,...q('100'),calls:'2',known_calls:'2',missing_call_records:0,token_breakdown:{input:q('90'),output:q('10'),cache_read:q(null,'0',1),cache_creation:q('0')}};
test('plugin shows official Chat and CUE separately, keeps missing cache unknown, and supports older data',async({page})=>{
 await page.setViewportSize({width:360,height:1000});await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({postMessage:()=>{}});});await page.goto('about:blank');await page.setContent(html);
 const data={business_date:'2026-10-12',as_of:'2026-10-12T08:00:00Z',official_chat_tokens:'100',official_cue_tokens:'5',official_chat_usage:usage,official_cue_usage:{...usage,...q('5'),token_breakdown:{input:q('5'),output:q('0'),cache_read:q('0'),cache_creation:q('0')}},official_configured:true,official_coverage:{complete:true,oldest_verified_at:'2026-10-12T07:59:00Z'},hook_sessions:1,prompt_turns:2,partial_history:true};
 const send=async value=>page.evaluate(value=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:{busy:false,email:'synthetic@example.invalid',origin:'http://example.invalid',badge:'已接入',today:{data:value,stale:false},hook:'已安装',git:'已保存'}}})),value);
 await send(data);await expect(page.locator('#chat')).toHaveText('100');await expect(page.locator('#chat-input')).toHaveText('90');await expect(page.locator('#chat-output')).toHaveText('10');await expect(page.locator('#chat-calls')).toHaveText('2');await expect(page.locator('#chat-cache_read')).not.toBeVisible();await expect(page.locator('#chat-cache_read-hint')).not.toBeVisible();await expect(page.locator('#chat-cache_creation')).toHaveText('0');await expect(page.locator('#cue')).toHaveText('5');
 await expect(page.locator('body')).not.toContainText('估算');await expect(page.locator('#asof')).toContainText('页面读取');await expect(page.locator('#asof')).toContainText('官方最早核验');await expect(page.locator('#coverage')).toContainText('官方快照已核验');await expect(page.locator('#coverage')).toContainText('Hook观测暂不完整');
 await page.screenshot({path:'.run/plugin-official-usage.png',fullPage:true});
 const legacy={...data};delete legacy.official_chat_usage;delete legacy.official_cue_usage;await send(legacy);await expect(page.locator('#chat')).toHaveText('100');await expect(page.locator('#chat-input')).not.toBeVisible();await expect(page.locator('#chat-input-hint')).not.toBeVisible();
});
