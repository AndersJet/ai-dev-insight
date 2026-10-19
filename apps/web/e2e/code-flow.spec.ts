import {environment as e2eEnv} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {randomUUID} from 'node:crypto';
import {pluginHookMaterial} from './helpers/plugin-material.js';
import {resetSyntheticHookFixture} from './helpers/registered-fixture.js';

test('project inventory uses actual context remotes, ignores dates and returns from linked sessions to its scoped list',async({page})=>{
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
 await resetSyntheticHookFixture(page);const personal=(await pluginHookMaterial(page)).config;
 const workspace=`/synthetic/project-${randomUUID()}`,collector=randomUUID(),source=randomUUID(),now=new Date().toISOString();
 const project={collector_id:collector,platform:'macos',workspace,unresolved_reason:null,observation:{id:randomUUID(),sequence:'1',observed_at:now,state:'repository',reason:null,git_root:workspace,remotes:[{name:'origin',direction:'fetch',address:'https://10.24.0.12/team/browser.git'},{name:'mirror',direction:'push',address:'https://git.example.invalid/team/browser.git'}]}};
 const event={schema_version:2,installation_id:personal.installation_id,client_event_id:randomUUID(),source_session_id:source,occurred_at:now,event_type:'UserPromptSubmit',payload:{cwd:workspace,prompt:'对话提及 https://dialogue-only.example.invalid/unrelated.git'},project};
 await expect.poll(async()=>{await page.request.post(e2eEnv.collectorURL+'/hooks',{headers:{authorization:`Bearer ${personal.token}`},data:event});const response=await page.request.get(`/api/v1/code-flow?search=${encodeURIComponent(workspace)}&from=1999&to=ignored`);return response.ok()?(await response.json()).data.items.some((row:{workspace:string})=>row.workspace===workspace):false;},{timeout:12000}).toBe(true);
 await page.goto(`/code-flow?search=${encodeURIComponent(workspace)}&from=1999&to=ignored`);await expect(page.getByRole('heading',{name:'代码流向追踪',exact:true})).toBeVisible();
 await expect(page.getByRole('radiogroup',{name:'日期范围',exact:true})).toHaveCount(0);
 const row=page.getByRole('row').filter({hasText:workspace});await expect(row).toContainText('https://10.24.0.12/team/browser.git');await expect(row).toContainText('https://git.example.invalid/team/browser.git');
 await expect(row.getByText('部门',{exact:true})).toHaveCount(1);await expect(row.getByText('个人',{exact:true})).toHaveCount(1);
 await expect(page.getByRole('main')).not.toContainText('dialogue-only.example.invalid');
 await row.getByRole('button',{name:'关联会话',exact:true}).click();const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText(source);await expect(dialog.getByTestId('project-observed-session')).toHaveText(source);
 const original=page.url();await dialog.getByRole('link',{name:'查看近期内容',exact:true}).click();await expect(page.getByRole('heading',{name:'会话详情',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'返回原列表',exact:true}).click();await expect(page).toHaveURL(original);await expect(page.getByRole('dialog',{name:'项目关联会话',exact:true})).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();
 for(let i=0;i<20;i++){const sent=await page.request.post(e2eEnv.collectorURL+'/hooks',{headers:{authorization:`Bearer ${personal.token}`},data:{...event,client_event_id:randomUUID(),source_session_id:randomUUID()}});expect(sent.ok()).toBe(true);}
 await expect.poll(async()=>{const r=await page.request.get(`/api/v1/code-flow?search=${encodeURIComponent(workspace)}`);return r.ok()?(await r.json()).data.items[0]?.session_count:-1;},{timeout:12000}).toBe(21);
 await page.getByRole('button',{name:'刷新项目',exact:true}).click();await expect(page.getByRole('button',{name:'刷新项目',exact:true})).toBeEnabled();await row.getByRole('button',{name:'关联会话',exact:true}).click();await expect(dialog.locator('.el-table__body tbody tr')).toHaveCount(20);
 await dialog.getByRole('button',{name:'下一页',exact:true}).click();await expect(dialog.locator('.el-table__body tbody tr')).toHaveCount(1);const associationPage=page.url(),tail=await dialog.locator('.el-table__body tbody tr td').first().innerText();await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();await expect(dialog.getByRole('button',{name:'刷新关联',exact:true})).toBeEnabled();await expect(page).toHaveURL(associationPage);await expect(dialog.locator('.el-table__body tbody tr td').first()).toHaveText(tail);
 const projectId=new URL(page.url()).searchParams.get('project')!;
 await page.route(`**/api/v1/code-flow/${projectId}/sessions?*`,route=>{const url=new URL(route.request().url());url.searchParams.set('cursor','deliberately-invalid');return route.continue({url:url.href});},{times:1});
 const rejected=page.waitForResponse(r=>r.status()===400&&new URL(r.url()).pathname===`/api/v1/code-flow/${projectId}/sessions`);await dialog.getByRole('button',{name:'刷新关联',exact:true}).click();expect((await (await rejected).json()).error.code).toBe('invalid_cursor');await expect(dialog).toContainText('第 1 页');await expect(dialog.locator('.el-table__body tbody tr')).toHaveCount(20);expect(new URL(page.url()).searchParams.get('search')).toBe(workspace);expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();
 for(let i=0;i<21;i++)await page.request.post(e2eEnv.collectorURL+'/hooks',{headers:{authorization:`Bearer ${personal.token}`},data:{...event,client_event_id:randomUUID(),project:{...project,workspace:`${workspace}/page-${i}`,observation:{...project.observation,id:randomUUID(),sequence:String(i+2)}}}});
 await expect.poll(async()=>{const r=await page.request.get(`/api/v1/code-flow?search=${encodeURIComponent(workspace)}`);return r.ok()?(await r.json()).data.total:-1;},{timeout:15000}).toBe(22);
 const search=page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true});await search.fill(workspace);await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(20);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(2);const second=page.url();await search.fill('未提交的草稿');await page.getByRole('button',{name:'刷新项目',exact:true}).click();await expect(page.getByRole('button',{name:'刷新项目',exact:true})).toBeEnabled();
 await expect(page).toHaveURL(second);await expect(search).toHaveValue('未提交的草稿');await expect(page.locator('tbody tr')).toHaveCount(2);
});
