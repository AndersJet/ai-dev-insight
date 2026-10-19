import {e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';import {readFileSync} from 'node:fs';
test('legacy simulation API remains compatible while the session page does not request it',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.analytics.managerEmail);await page.getByLabel('密码',{exact:true}).fill(fixture.analytics.managerPassword);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
 const listed=await page.request.get('/api/v1/me/sessions?search=PRIVATE_BROWSER_A');const id=(await listed.json()).data.items[0].id;const initial=await page.request.get(`/api/v1/sessions/${id}/billing-simulation`);expect(initial.status()).toBe(200);const initialData=(await initial.json()).data;expect(initialData.amount).toBe(null);expect(initialData.baseline.calibrated).toBe(false);expect(initialData.baseline.samples).toBe(0);expect(initialData.baseline.training_before).toBe(initialData.period.from);expect(initialData.computed_at).toBeTruthy();const again=await page.request.get(`/api/v1/sessions/${id}/billing-simulation`);expect((await again.json()).data.computed_at).toBe(initialData.computed_at);
 const zero=(await (await page.request.get(`/api/v1/sessions/${id}/billing-simulation?base_tokens=0`)).json()).data;
 const increased=(await (await page.request.get(`/api/v1/sessions/${id}/billing-simulation?base_tokens=10000`)).json()).data;
 expect(BigInt(increased.simulated_input_tokens)>BigInt(zero.simulated_input_tokens)).toBe(true);
 const retired:string[]=[];page.on('request',request=>{if(/\/(billing-simulation|token-check)(?:\?|$)/.test(request.url()))retired.push(request.url());});
 await page.goto(`/my/sessions/${id}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
 await expect(page.getByTestId('session-official-tokens')).toBeVisible();
 await expect(page.getByTestId('billing-simulation-details')).toHaveCount(0);await expect(page.getByTestId('token-check')).toHaveCount(0);expect(retired).toEqual([]);
});
