import {e2eArtifact} from './helpers/environment.mjs';
import { test,expect } from './helpers/browser.js';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionListDto } from '@adi/contracts';

test('personal confirmation is reversible, mixes with official records without inflating tokens, and survives D list filtering',async({page})=>{
 test.setTimeout(150000);
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 async function login(email:string,password:string){await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('navigation')).toBeVisible();}
 // Ordinary changes reach a complete published snapshot within 60 seconds.
 // The deadline starts at the mutation, including navigation back to the list.
 const snapshotConsistencyMs=60000;
 const remaining=(started:number)=>{const ms=snapshotConsistencyMs-(performance.now()-started);if(ms<=0)throw new Error('List snapshot did not reflect personal confirmation within its 60-second consistency deadline');return Math.ceil(ms);};
 async function refreshListUntil(operation:string,started:number,check:()=>Promise<boolean>){
  const refresh=page.getByRole('button',{name:'刷新列表',exact:true});
  const observations:{elapsed_ms:number;status:number;snapshot?:SessionListDto['snapshot'];total?:number;items?:Pick<SessionListDto['items'][number],'id'|'channel'|'personal_models'|'official_tokens'>[]}[]=[];
  try{
   while(true){
    await expect(refresh).toBeEnabled({timeout:remaining(started)});
    const [response]=await Promise.all([
     page.waitForResponse(result=>result.request().method()==='GET'&&new URL(result.url()).pathname==='/api/v1/me/sessions',{timeout:remaining(started)}),
     refresh.click({timeout:remaining(started)}),
    ]);
    const observation={elapsed_ms:performance.now()-started,status:response.status()};observations.push(observation);
    // A failed refresh is a failure, including 503; only stale successful
    // snapshots are retried. Do not hide request errors inside expect.poll.
    expect(response.status()).toBe(200);
    const result:{data:SessionListDto}=await response.json();Object.assign(observation,{snapshot:result.data.snapshot,total:result.data.total,items:result.data.items.map(({id,channel,personal_models,official_tokens})=>({id,channel,personal_models,official_tokens}))});
    await expect(refresh).toBeEnabled({timeout:remaining(started)});remaining(started);
    if(await check()){remaining(started);return;}
    await delay(Math.min(250,remaining(started)));
   }
  }finally{await test.info().attach('personal-model-'+operation+'-snapshots.json',{body:JSON.stringify(observations,null,2),contentType:'application/json'});}
 }
 await login(fixture.analytics.managerEmail,fixture.analytics.managerPassword);
 await page.getByRole('navigation').getByRole('link',{name:'我的空间',exact:true}).click();await page.getByRole('complementary').getByRole('link',{name:'我的Token使用分析',exact:true}).click();
 await page.getByRole('radio',{name:'有官方记录',exact:true}).click();const row=page.getByRole('row').filter({hasText:'PRIVATE_BROWSER_A'});await expect(row).toHaveCount(1);await expect(row).toContainText('2,500');
 await row.getByRole('button',{name:'查看详情',exact:true}).click();await page.getByRole('tab',{name:'官方用量',exact:true}).click();await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');
 await page.getByRole('button',{name:'确认个人自配模型',exact:true}).click();const dialog=page.getByRole('dialog',{name:'本人确认个人自配模型',exact:true});
 await dialog.getByLabel('模型名称',{exact:true}).fill('DeepSeek-V3\n个人渠道模型');await dialog.getByRole('button',{name:'保存本人确认',exact:true}).click();await expect(dialog).toBeHidden();
 await expect(page.getByTestId('personal-models-panel')).toContainText('DeepSeek-V3');await expect(page.getByTestId('personal-models-panel')).toContainText('本人确认');await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');await page.screenshot({path:'.run/personal-model-confirmation.png',fullPage:true});
 const ownDetail=page.url();const id=new URL(ownDetail).pathname.split('/').at(-1)!;
 const currentResponse=await page.request.get('/api/v1/sessions/'+id+'/personal-models');expect(currentResponse.ok()).toBe(true);const current=(await currentResponse.json()).data;
 const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='adi_csrf')!.value;
 const changedStarted=performance.now(),changed=await page.request.put('/api/v1/sessions/'+id+'/personal-models',{headers:{'x-csrf-token':csrf},data:{version:current.version,cleanup_generation:current.cleanup_generation,models:['DeepSeek-V3','个人渠道模型','刷新验收模型']}});expect(changed.ok()).toBe(true);
 await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.getByTestId('personal-models-panel')).toContainText('刷新验收模型');await expect(page.getByTestId('session-official-tokens')).toHaveText('2,500');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await login(fixture.admin.email,fixture.admin.password);await page.goto('/all/sessions/'+id);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
 await expect(page.getByTestId('personal-models-panel')).toContainText('DeepSeek-V3');await expect(page.getByRole('button',{name:'修改本人确认',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'撤销本人确认',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await login(fixture.analytics.managerEmail,fixture.analytics.managerPassword);await page.goto(ownDetail);
 await page.getByRole('button',{name:'返回原列表',exact:true}).click();await refreshListUntil('confirmation',changedStarted,async()=>{const text=await row.allTextContents();return text.length===1&&text[0]!.includes('官方＋本人确认');});await expect(row).toContainText('官方＋本人确认');await page.getByRole('radio',{name:'个人自配',exact:true}).click();await expect(row).toHaveCount(1);await expect(row).toContainText('DeepSeek-V3');await page.screenshot({path:'.run/session-channel-list.png',fullPage:true});
 await row.getByRole('button',{name:'查看详情',exact:true}).click();await page.getByRole('tab',{name:'官方用量',exact:true}).click();const revokeStarted=performance.now();const [revoked]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/v1/sessions/'+id+'/personal-models',{timeout:remaining(revokeStarted)}),
  page.getByRole('button',{name:'撤销本人确认',exact:true}).click({timeout:remaining(revokeStarted)}),
 ]);expect(revoked.status()).toBe(200);expect((await revoked.json()).data.models).toEqual([]);await expect(page.getByTestId('personal-models-panel')).not.toContainText('DeepSeek-V3');
 await page.getByRole('button',{name:'返回原列表',exact:true}).click();await refreshListUntil('revocation',revokeStarted,async()=>await row.count()===0);await expect(page.getByRole('row').filter({hasText:'PRIVATE_BROWSER_A'})).toHaveCount(0);await page.getByRole('radio',{name:'有官方记录',exact:true}).click();await expect(row).toContainText('2,500');
});
