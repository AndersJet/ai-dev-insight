import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
for(const [status,code] of [[401,'unauthenticated'],[403,'forbidden'],[404,'not_found'],[409,'content_changed'],[503,'recovery_quarantined']]){
 test(`official quantities clear on ${code} rather than retaining protected input or cache values`,async({page})=>{
  await mockPage(page);await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
  const panel=page.getByTestId('session-official-usage');await expect(page.getByTestId('session-official-input')).toHaveText('23,000');
  await page.route('**/api/v1/sessions/*/official-usage*',route=>route.fulfill({status,json:{error:{code,message:'当前用量已不可读取',request_id:'synthetic'}}}),{times:1});
  await panel.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('已不可读取');
  for(const key of ['tokens','input','output','cache_read','cache_creation','calls'])await expect(page.getByTestId(`session-official-${key}`)).not.toBeVisible();
 });
}
test('an empty official response stays unknown and retains Hook reading',async({page})=>{
 await mockPage(page);await page.route('**/api/v1/sessions/*/official-usage*',route=>{const body=response(route.request().url()).body;body.data.groups=[];return route.fulfill({status:200,json:body});});
 await page.goto(`/my/sessions/${ids.session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
 for(const key of ['tokens','input','output','cache_read','cache_creation','calls'])await expect(page.getByTestId(`session-official-${key}`)).not.toBeVisible();
 await expect(page.getByTestId('session-official-usage')).toContainText('不能据此认定零使用');
 await page.getByRole('tab',{name:'原始事件',exact:true}).click();await page.locator('summary').filter({hasText:'UserPromptSubmit'}).click();await expect(page.getByText('请统一部门表单样式，并检查窄屏显示。',{exact:false})).toBeVisible();
});
