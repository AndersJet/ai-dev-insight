/* global window, MessageEvent */
import {test,expect} from '@playwright/test';
import {overviewHtml} from '../../../trae-plugin/src/overview-ui.ts';

test('插件安装验证按五项检查和人工确认启用通过，失败显示日志路径',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{window.adiMessages=[];window.acquireVsCodeApi=()=>({postMessage:value=>window.adiMessages.push(value)});});
  await page.setContent(overviewHtml());
  await page.locator('#verification-summary').click();
  await page.getByRole('button',{name:'开始安装验证',exact:true}).click();
  expect(await page.evaluate(()=>window.adiMessages.at(-1).op)).toBe('verification-start');
  const started=Date.now(),verification={result:'active',started,deadline:started+900000,checks:{plugin:true,account:true,hook:true,version:true,statistics:true},confirmed:{global:false,local:false,session:false},canPass:false,readOnly:false,logPath:'/owned/debug-logs/verification-test.jsonl'};
  const state={origin:'http://example.invalid',email:'synthetic@example.invalid',busy:false,authPending:false,badge:'已接入',today:{data:null,stale:false},verification,hookGuide:{canConfirm:true,confirmed:false}};
  const render=()=>page.evaluate(s=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:s}})),state);
  await render();await expect(page.locator('#verification-checks li')).toHaveCount(5);await expect(page.getByRole('button',{name:'验证通过',exact:true})).toBeDisabled();await expect(page.locator('#verification-session')).toBeDisabled();
  await page.locator('#verification-global').click();expect(await page.evaluate(()=>window.adiMessages.at(-1).op)).toBe('verification-global');verification.confirmed.global=true;await render();
  await expect(page.locator('#verification-global')).toHaveText('✓ 全局 Hooks 已开启 · 已完成');
  await page.locator('#verification-local').click();verification.confirmed.local=true;await render();await expect(page.locator('#verification-session')).toBeEnabled();
  await expect(page.locator('#verification-local')).toHaveText('✓ 本地自动运行已确认 · 已完成');
  await page.locator('#verification-session').click();expect(await page.evaluate(()=>window.adiMessages.at(-1).op)).toBe('verification-session');verification.confirmed.session=true;verification.canPass=true;await render();await expect(page.getByRole('button',{name:'验证通过',exact:true})).toBeEnabled();
  await expect(page.locator('#verification-session')).toHaveText('✓ 平台收到本次新会话 · 已完成');
  verification.result='failed';verification.canPass=false;await render();await page.locator('#verification-summary').click();await expect(page.locator('#verification-log')).toContainText(verification.logPath);await expect(page.getByRole('button',{name:'打开日志文件夹',exact:true})).toBeVisible();
  verification.result='unconfirmed';await render();await expect(page.locator('#verification-result')).toContainText('未确认');
  verification.result='passed';verification.detailsDeleted=true;verification.logPath='';await render();await expect(page.locator('#verification-result')).toContainText('详细日志已删除');await expect(page.locator('#verification-folder')).toBeHidden();
});

test('SSH 验证明确显示项目范围和已完成步骤，切换工作区后不沿用旧按钮状态',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{window.adiMessages=[];window.acquireVsCodeApi=()=>({postMessage:value=>window.adiMessages.push(value)});});
  await page.setContent(overviewHtml());
  await page.locator('#verification-summary').click();
  const started=Date.now(),workspace={id:'remote-a',label:'Remote SSH 项目：A'};
  const state={remote:true,origin:'http://example.invalid',email:'synthetic@example.invalid',busy:false,today:{data:null,stale:false},verificationWorkspace:workspace,verification:{result:'active',started,deadline:started+900000,checks:{plugin:true,account:true,hook:true,version:true,statistics:true},confirmed:{global:true,local:true,session:false},canPass:false,readOnly:false}};
  const render=value=>page.evaluate(s=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:s}})),value);
  await render(state);await expect(page.locator('#verification-workspace')).toHaveText(workspace.label);
  await expect(page.locator('#verification-global')).toHaveText('✓ 项目 Hooks 已开启 · 已完成');await expect(page.locator('#verification-local')).toHaveText('✓ 远端运行方式已确认 · 已完成');
  await page.locator('#verification-session').click();expect(await page.evaluate(()=>window.adiMessages.at(-1))).toEqual({op:'verification-session',workspace:workspace.id});
  await render({...state,remote:false,verificationWorkspace:{id:'local-b',label:'本地项目：B'},verification:null});
  await expect(page.locator('#verification-workspace')).toHaveText('本地项目：B');await expect(page.locator('#verification-body')).toBeHidden();
  await page.locator('#verification-summary').click();
  await page.getByRole('button',{name:'开始安装验证',exact:true}).click();expect(await page.evaluate(()=>window.adiMessages.at(-1))).toEqual({op:'verification-start',workspace:'local-b'});
  await render({...state,remote:false,verificationWorkspace:{id:'local-b',label:'本地项目：B'},verification:{...state.verification,confirmed:{global:false,local:false,session:false},readOnly:true}});
  await expect(page.locator('#verification-global')).toHaveText('确认全局 Hooks 已开启');await expect(page.locator('#verification-global')).toBeDisabled();await expect(page.locator('#verification-result')).toContainText('自动恢复');
});
