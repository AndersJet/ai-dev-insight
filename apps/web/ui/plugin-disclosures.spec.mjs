/* global window, document, MessageEvent, Node */
import {test,expect} from '@playwright/test';
import {overviewHtml} from '../../../trae-plugin/src/overview-ui.ts';

const base=()=>({remote:true,remoteSetup:{phase:'ready',message:'配套助手已连接。',canInstall:false,canRetry:true},remoteError:'',origin:'http://example.invalid',email:'synthetic@example.invalid',busy:false,authPending:false,badge:'已接入',updates:{version:'1.0.5',phase:'idle',message:'当前没有需要安装的更新。',trial:false,trialEligible:false},today:{stale:false,data:{business_date:'2026-10-16',as_of:new Date().toISOString(),official_configured:true,official_chat_tokens:'24680',official_cue_tokens:null,hook_sessions:3,prompt_turns:5}},git:'观测运行中',hook:'文件就绪 · 启用设置已确认 · 运行待验证',saved:new Date().toISOString(),hookGuide:{canConfirm:true,confirmed:true},verificationWorkspace:{id:'ssh-a',label:'Remote SSH 项目：合成项目 A'},verification:null});
const active=()=>{const started=Date.now();return {id:'synthetic-verification',result:'active',started,deadline:started+900000,checks:{plugin:true,account:true,hook:true,version:true,statistics:true},confirmed:{global:false,local:false,session:false},canPass:false,readOnly:false};};
const show=(page,state)=>page.evaluate(value=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:value}})),state);
async function start(page){
 await page.goto('about:blank');await page.evaluate(()=>{window.adiMessages=[];window.acquireVsCodeApi=()=>({postMessage:value=>window.adiMessages.push(value)});});await page.setContent(overviewHtml());
 await page.evaluate(()=>{for(const [key,value]of Object.entries({'--vscode-font-family':'sans-serif','--vscode-foreground':'#dbe5f5','--vscode-sideBar-background':'#101b2c','--vscode-descriptionForeground':'#9dafc7','--vscode-panel-border':'#2b3a50','--vscode-button-background':'#1261d8','--vscode-button-foreground':'#ffffff','--vscode-button-secondaryBackground':'#26354b','--vscode-button-secondaryForeground':'#dbe5f5','--vscode-focusBorder':'#55c9dc'}))document.documentElement.style.setProperty(key,value);});
}

test('窄屏常态三个模块默认收起，官方用量优先可见，手动展开只在当前页面保留',async({page})=>{
 await page.setViewportSize({width:360,height:900});await start(page);const state=base();await show(page,state);
 for(const id of ['remote-setup','collection-card','verification-card'])await expect(page.locator('#'+id)).toHaveJSProperty('open',false);
 await expect(page.locator('#remote-brief')).toHaveText('助手已连接');await expect(page.locator('#collection-brief')).toContainText('最近保存');await expect(page.locator('#verification-brief')).toContainText('未开始');
 expect((await page.locator('#chat-card h2').boundingBox()).y).toBeLessThan(850);
 expect(await page.locator('#chat-card').evaluate(element=>!!(element.compareDocumentPosition(document.getElementById('remote-setup'))&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
 await page.screenshot({path:test.info().outputPath('sidebar-collapsed-mobile.png'),fullPage:true});
 await page.locator('#remote-summary').click();await show(page,state);await expect(page.locator('#remote-setup')).toHaveJSProperty('open',true);
 await start(page);await show(page,state);await expect(page.locator('#remote-setup')).toHaveJSProperty('open',false);
 await page.locator('#collection-summary').focus();await page.keyboard.press('Enter');await expect(page.locator('#collection-card')).toHaveJSProperty('open',true);
 await show(page,{...state,verificationWorkspace:{id:'ssh-b',label:'Remote SSH 项目：合成项目 B'}});await expect(page.locator('#collection-card')).toHaveJSProperty('open',false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('底部开始验证后原位强制展开，鼠标键盘和刷新均不能收起，结束恢复摘要',async({page})=>{
 await page.setViewportSize({width:360,height:900});await start(page);const state=base();await show(page,state);
 await page.locator('#verification-summary').click();await page.locator('#verification-summary').scrollIntoViewIfNeeded();
 await page.getByRole('button',{name:'开始安装验证',exact:true}).click();expect(await page.evaluate(()=>window.adiMessages.at(-1).op)).toBe('verification-start');
 const scroll=await page.evaluate(()=>window.scrollY);state.verification=active();await show(page,state);
 await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);expect(Math.abs(await page.evaluate(()=>window.scrollY)-scroll)).toBeLessThan(2);
 const summary=page.locator('#verification-summary');await expect(summary).toHaveAttribute('aria-disabled','true');
 await summary.click({force:true});await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);
 await summary.focus();await page.keyboard.press('Space');await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);
 await page.locator('#verification-card').evaluate(element=>{element.open=false;});await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);
 await show(page,{...state,verification:{...state.verification,readOnly:true}});await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);
 await expect(page.locator('#verification-brief')).toContainText('临时调试日志剩余');
 await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+61000;});await expect(page.locator('#verification-brief')).toContainText(/13:\d{2}/);
 await page.screenshot({path:test.info().outputPath('sidebar-active-mobile.png'),fullPage:true});
 await show(page,{...state,verification:{...state.verification,result:'unconfirmed'}});await expect(page.locator('#verification-card')).toHaveJSProperty('open',false);await expect(page.locator('#verification-brief')).toContainText('临时调试日志已结束');
 await expect(page.locator('#collection-brief')).toContainText('Git：观测运行中');
 await summary.click();await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);
});

test('恢复进行中的验证自动展开，远端异常仅显示摘要提醒且仍可展开处理',async({page})=>{
 await start(page);const state=base();state.verification=active();state.remoteSetup={phase:'mismatch',message:'助手需更新。',canInstall:true,canRetry:true};await show(page,state);
 await expect(page.locator('#verification-card')).toHaveJSProperty('open',true);await expect(page.locator('#remote-setup')).toHaveJSProperty('open',false);await expect(page.locator('#remote-summary')).toHaveClass(/attention/);await expect(page.locator('#remote-brief')).toHaveText('助手需更新');
 await page.locator('#remote-summary').click();await expect(page.getByRole('button',{name:'一键安装配套助手',exact:true})).toBeVisible();
 await show(page,{...state,remote:false,remoteSetup:null,verification:null,verificationWorkspace:{id:'local-b',label:'本地项目：合成项目 B'}});await expect(page.locator('#verification-card')).toHaveJSProperty('open',false);await expect(page.locator('#remote-setup')).toBeHidden();
});

test('环境修复失败或中断时默认摘要醒目提示，修复中也显示进度入口',async({page})=>{
 await start(page);const state={...base(),remote:false,remoteSetup:null,verification:null,recovery:{busy:false,blocked:true,message:'上次环境修复未完成，本机采集保持暂停；请重新修复或查看备份。',hasBackup:true}};await show(page,state);
 await expect(page.locator('#verification-card')).toHaveJSProperty('open',false);await expect(page.locator('#verification-summary')).toHaveClass(/attention/);await expect(page.locator('#verification-brief')).toContainText('需处理');await expect(page.locator('#collection-brief')).toContainText('需处理');
 await page.locator('#verification-summary').click();await expect(page.locator('#recovery-message')).toContainText('上次环境修复未完成');await expect(page.getByRole('button',{name:'打开备份文件夹',exact:true})).toBeVisible();
 await show(page,{...state,recovery:{...state.recovery,busy:true}});await expect(page.locator('#verification-brief')).toContainText('环境修复中');
 await show(page,{...state,recovery:{...state.recovery,blocked:false,busy:false}});await expect(page.locator('#verification-summary')).not.toHaveClass(/attention/);await expect(page.locator('#verification-brief')).toContainText('未开始');
});
