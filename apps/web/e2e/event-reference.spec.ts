import {e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';

test('D trace and raw event reading keep UUID reuse separate at microsecond precision',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('navigation',{name:'一级导航'})).toBeVisible();
 const listed=await page.request.get('/api/v1/me/sessions?search=browser-composite-reference');expect(listed.status()).toBe(200);const session=(await listed.json()).data.items[0];
 const references:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname.includes('/events/')&&url.pathname.endsWith('/content'))references.push(url.searchParams.get('occurred_at')??'missing');});
 await page.goto('/my/sessions/'+session.id);await expect(page.getByTestId('session-trace')).toContainText('REFERENCE_FIRST');await page.getByRole('button',{name:/第 2 轮/}).click();await expect(page.getByTestId('session-trace')).toContainText('REFERENCE_SECOND');await expect(page.getByTestId('session-trace')).not.toContainText('REFERENCE_FIRST');
 await page.getByRole('tab',{name:'原始事件',exact:true}).click();const events=page.locator('details.raw-event');await expect(events).toHaveCount(2);
 await events.nth(0).locator('summary').click();await expect(events.nth(0)).toContainText('REFERENCE_FIRST');await events.nth(1).locator('summary').click();await expect(events.nth(1)).toContainText('REFERENCE_SECOND');await expect(events.nth(0).getByTestId('session-content')).toHaveCount(0);
 expect(references.some(at=>at.endsWith('.123456Z'))).toBe(true);expect(references.some(at=>at.endsWith('.123457Z'))).toBe(true);expect(references).not.toContain('missing');
 await expect(page.getByRole('complementary',{name:'当前工作区菜单'})).toBeVisible();
});
