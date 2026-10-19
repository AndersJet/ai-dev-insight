import {test,expect} from '../e2e/helpers/browser.js';
import {mockPage,response,ids} from './fixtures.mjs';
test('main detail reload refreshes official breakdown while keeping its evidence explanation open',async({page})=>{
 await mockPage(page);let calls=0;
 await page.route('**/api/v1/sessions/'+ids.session+'/official-usage*',route=>{const value=response(route.request().url()).body;
  if(++calls>1)value.data.groups[0].token_breakdown.input={tokens:'20000',known_tokens:'20000',missing_token_records:0};
  return route.fulfill({status:200,json:value});
 });
 await page.goto('/my/sessions/'+ids.session);await page.getByRole('tab',{name:'官方用量',exact:true}).click();
 const panel=page.getByTestId('session-official-usage');await expect(page.getByTestId('session-official-input')).toHaveText('23,000');
 await panel.getByText('查看关联依据与时间',{exact:true}).click();await page.getByRole('button',{name:'重新加载',exact:true}).click();
 await expect(page.getByTestId('session-official-input')).toHaveText('20,000');await expect(panel.getByText('查看关联依据与时间',{exact:true}).locator('..')).toHaveAttribute('open','');expect(calls).toBeGreaterThan(1);
});
