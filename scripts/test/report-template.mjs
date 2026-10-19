/* global URL, process, structuredClone, window, navigator, document, innerWidth, console */
// Browser regression for the actual offline HTML embedded in downloaded packages.
// Run: node --import tsx scripts/test/report-template.mjs (set ADI_REPORT_BROWSER for a system Chromium).
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {analysisTemplate,analysisPrompt} from '../../apps/api/src/analysis-assets.ts';
const fixture=JSON.parse(await readFile(new URL('../../apps/api/test/fixtures/token-report.json',import.meta.url),'utf8'));
const browser=await chromium.launch(process.env.ADI_REPORT_BROWSER?{executablePath:process.env.ADI_REPORT_BROWSER}:{});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage(),errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));
 const withData=data=>analysisTemplate.replace(/(<script id="report-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_all,open,close)=>open+JSON.stringify(data).replaceAll('<','\\u003c')+close);
 const data=structuredClone(fixture);data.mode='report';data.evidence[0].excerpt='<img src="https://untrusted.invalid/pixel" onerror="window.attacked=true"></script><script>window.attacked=true</script>';data.findings[0].title='<b>用户原文应保持纯文本</b>';
 let current=data;
 await page.route('**/*',r=>{if(r.request().url().startsWith('http://127.0.0.1:4199/test-report'))return r.fulfill({contentType:'text/html; charset=utf-8',body:withData(current)});network.push(r.request().url());return r.abort();});
 await page.goto('http://127.0.0.1:4199/test-report');await page.locator('#overview').waitFor({state:'visible'});
 assert.equal(await page.locator('#mode').innerText(),'分析报告');assert.equal(await page.locator('.prototype-bar').count(),0);
 for(const id of ['result','communication','execution','cost','actions','evidence','overview']){await page.locator('#tab-'+id).click();assert.equal(await page.locator('#'+id).isVisible(),true);assert.equal(await page.locator('.panel:visible').count(),1);}
 await page.getByRole('button',{name:'查看证据 E1',exact:true}).first().click();assert.equal(await page.locator('#evidence-dialog').isVisible(),true);assert.equal(await page.locator('#drawer-excerpt').innerText(),data.evidence[0].excerpt);assert.equal(await page.locator('img:not(.brand-symbol)').count(),0);assert.equal(await page.evaluate(()=>window.attacked),undefined);await page.keyboard.press('Escape');assert.equal(await page.locator('#evidence-dialog').isVisible(),false);
 await page.locator('#tab-actions').click();await page.getByRole('button',{name:'复制建议提示词',exact:true}).first().click();await page.getByText('已复制',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),data.actions[0].prompt);
 await page.locator('#tab-overview').click();await page.screenshot({path:'.run/token-report-web-aligned-overview.png'});
 await page.emulateMedia({media:'print'});assert.equal(await page.locator('.panel:visible').count(),7);assert.equal(await page.locator('.full-evidence').first().isVisible(),true);await page.emulateMedia({media:'screen'});
 await page.goto('http://127.0.0.1:4199/test-report#ev-E1');assert.equal(await page.locator('#evidence-dialog').isVisible(),true);await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await page.locator('#tab-overview').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.run/token-report-web-aligned-mobile.png'});
 current={...fixture,mode:'report',requirements:[],actions:[],evidence:[],findings:[],costs:{...fixture.costs,official:[],scales:[]}};await page.goto('http://127.0.0.1:4199/test-report');assert.equal(await page.getByText('未提供可靠官方用量',{exact:true}).isVisible(),true);await page.locator('#tab-actions').click();assert.match(await page.locator('#actions').innerText(),/不足以支持/);
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.match(analysisPrompt,/只替换 id="report-data"/);assert.match(analysisPrompt,/mode 改为 report/);
 await mkdir('.run',{recursive:true});console.log(JSON.stringify({passed:['seven category navigation','raw text remains inert','no external requests','evidence dialog and direct hash','copy exact prompt','full print visibility','mobile width','missing evidence and official usage remain unknown','production prompt/template alignment'],screenshots:2}));
}finally{await browser.close();}
