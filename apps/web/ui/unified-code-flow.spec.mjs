import {test,expect} from '../e2e/helpers/browser.js';
import {URL} from 'node:url';
import {mockPage,response,ids} from './fixtures.mjs';

async function tracking(page){
  await mockPage(page);
  const record={nt_email:'plugin.demo@example.org',collector_id:ids.user,source_config_id:ids.second,observation_id:ids.session,sequence:'1',platform:'macos',workspace_path:'/workspace/plugin-project',workspace_key:'a'.repeat(64),observed_at:'2026-10-05T00:00:00.000Z',received_at:'2026-10-05T00:00:01.000Z',state:'repository',reason:null,git_root:'/workspace/plugin-project',remotes:[{address:'https://git.example.com/team/plugin.git',source_tag:'department'}],plugin_version:'0.1.0'};
  const project={nt_email:record.nt_email,collector_id:record.collector_id,workspace_key:record.workspace_key,workspace_path:record.workspace_path,platform:record.platform,latest:record,confirmed:record,linked_user:{user_id:ids.user,name:'插件关联姓名',email:record.nt_email,account_status:'active',department_id:ids.department,department_name:'平台研发部'}};
  const result=(items=[project],page=1)=>({data:{items,total:41,page,limit:20,has_more:page<3}});
  const requests=[];page.on('request',r=>{const url=new URL(r.url());if(url.pathname==='/api/v1/code-flow'||url.pathname==='/api/v1/plugin/projects')requests.push(url);});
  await page.route('**/api/v1/plugin/projects?*',route=>route.fulfill({status:200,json:result([project],Number(new URL(route.request().url()).searchParams.get('page')??1))}));
  await page.route('**/api/v1/plugin/observations?*',route=>route.fulfill({status:200,json:result([record])}));
  return{project,record,result,requests};
}

test('plugin history has no project deletion path and keeps cleanup in the person and time workflow',async({page})=>{
  await tracking(page);await page.goto('/code-flow?source=plugin');
  await expect(page.getByRole('row').filter({hasText:'/workspace/plugin-project'})).toBeVisible();
  await expect(page.getByRole('button',{name:'删除',exact:true})).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText('人员与时间范围');
  await page.getByRole('button',{name:'观测历史',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'插件观测历史',exact:true})).toContainText('已保存状态变化');
});

test('history-only source projects retain their own history without presenting an old repository as current',async({page})=>{
  const fixture=await tracking(page);
  const historical={...fixture.project,user_id:ids.user,project_id:ids.session,latest:null,confirmed:null,current_available:false,history_only:true,retained_observations:1};
  await page.route('**/api/v1/plugin/projects?*',route=>route.fulfill({status:200,json:fixture.result([historical])}));
  await page.route('**/api/v1/code-flow?*',route=>{
    const result=response(route.request().url());Object.assign(result.body.data.items[0],{current_available:false,history_only:true,retained_observations:1,state:'unknown',reason:'current_evidence_unavailable',observed_at:null,confirmed_at:null,confirmed_state:null,git_root:null,remotes:[]});
    return route.fulfill({status:200,json:result.body});
  });
  let query;await page.route('**/api/v1/plugin/observations?*',route=>{query=new URL(route.request().url()).searchParams;return route.fulfill({status:200,json:fixture.result([fixture.record])});});
  await page.goto('/code-flow?source=plugin');const plugin=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});
  await expect(plugin).toBeVisible();await expect(plugin).toContainText('当前观测不可用');await expect(plugin).toContainText('仅保留历史');
  await expect(plugin).not.toContainText('https://git.example.com/team/plugin.git');
  await plugin.getByRole('button',{name:'观测历史',exact:true}).click();const history=page.getByRole('dialog',{name:'插件观测历史',exact:true});await expect(history).toContainText('https://git.example.com/team/plugin.git');expect(query.get('project_id')).toBe(ids.session);
  await history.getByRole('button',{name:'关闭',exact:true}).last().click();await page.getByRole('tab',{name:'Hook采集',exact:true}).click();const hook=page.getByRole('row').filter({hasText:'/workspace/demo-project'});
  await expect(hook).toContainText('当前观测不可用');await expect(hook).toContainText('仅保留历史');await expect(hook.getByRole('button',{name:'关联会话',exact:true})).toBeEnabled();
});

test('the shared allowlist action stays in the heading outside both source panels',async({page})=>{
  await tracking(page);await page.goto('/code-flow');
  const heading=page.locator('.page-heading'),button=heading.getByRole('button',{name:'部门仓库白名单',exact:true});await expect(button).toBeVisible();await expect(page.getByRole('tabpanel').getByRole('button',{name:'部门仓库白名单',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'部门仓库白名单',exact:true})).toHaveCount(1);
  const titleBounds=await heading.getByRole('heading',{name:'代码流向追踪',exact:true}).boundingBox(),buttonBounds=await button.boundingBox();expect(buttonBounds.x).toBeGreaterThan(titleBounds.x+titleBounds.width);
  await page.getByRole('tab',{name:'插件采集',exact:true}).click();await expect(button).toBeVisible();await expect(page.getByRole('tabpanel').getByRole('button',{name:'部门仓库白名单',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'部门仓库白名单',exact:true})).toHaveCount(1);
});

test('shared allowlist edits refresh the active source and apply to the other source on its next read',async({page})=>{
  const fixture=await tracking(page);let changed=false,hookReads=0,pluginReads=0;
  await page.route('**/api/v1/code-flow?*',route=>{hookReads++;const result=response(route.request().url());result.body.data.items[0].remotes=[{address:'https://git.example.com/team/hook.git',source_tag:changed?'department':'personal'}];return route.fulfill({status:200,json:result.body});});
  await page.route('**/api/v1/plugin/projects?*',route=>{pluginReads++;fixture.project.confirmed.remotes[0].source_tag=changed?'department':'personal';return route.fulfill({status:200,json:fixture.result()});});
  await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:200,json:{data:{items:[],total:0,next_cursor:null}}}));
  await page.route('**/api/v1/repository-allowlist',route=>{changed=true;return route.fulfill({status:201,json:{data:{id:ids.second,kind:'host',value:'git.example.com',version:1,created_at:'2026-10-05T00:00:00.000Z',updated_at:'2026-10-05T00:00:00.000Z'}}});});
  await page.goto('/code-flow');await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'}).locator('.el-tag--warning')).toHaveText('个人');await page.locator('.page-heading').getByRole('button',{name:'部门仓库白名单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});await dialog.getByLabel('匹配地址',{exact:true}).fill('git.example.com');await dialog.getByRole('button',{name:'添加规则',exact:true}).click();await expect.poll(()=>hookReads).toBe(2);expect(pluginReads).toBe(0);await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'}).locator('.el-tag--info')).toHaveText('部门');
  await page.getByRole('tab',{name:'插件采集',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'/workspace/plugin-project'}).locator('.el-tag--info')).toHaveText('部门');expect(pluginReads).toBe(1);expect(hookReads).toBe(2);
});

for(const [status,code] of [[401,'unauthorized'],[403,'forbidden'],[503,'recovery_quarantined']])test(`shared heading allowlist ${code} clears hook data and closes its dialog`,async({page})=>{
  await tracking(page);await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status,json:{error:{code,message:'共享仓库配置权限不可用'}}}));await page.goto('/code-flow');const row=page.getByRole('row').filter({hasText:'/workspace/demo-project'});await expect(row).toBeVisible();await page.locator('.page-heading').getByRole('button',{name:'部门仓库白名单',exact:true}).click();await expect(page.getByRole('dialog',{name:'部门仓库白名单',exact:true})).not.toBeVisible();await expect(row).toHaveCount(0);await expect(page.getByRole('main').getByRole('alert')).toContainText('共享仓库配置权限不可用');
});

test('one tracking menu provides source tabs, a shared query and current linked plugin member',async({page})=>{
  const fixture=await tracking(page);await page.goto(`/code-flow?dept=${ids.department}&search=项目`);
  const sidebar=page.getByRole('complementary');await expect(sidebar.getByRole('link',{name:'代码流向追踪',exact:true})).toHaveCount(1);await expect(sidebar.getByRole('link',{name:'插件代码追踪',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'Hook采集',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true})).toHaveValue('项目');
  await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();expect(fixture.requests.every(url=>url.pathname==='/api/v1/code-flow')).toBe(true);
  await page.getByRole('tab',{name:'插件采集',exact:true}).click();await expect(page.getByRole('tab',{name:'插件采集',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.page-heading h1')).toHaveText('代码流向追踪');
  const member=page.getByRole('row').filter({hasText:'/workspace/plugin-project'}).getByRole('cell').nth(1);await expect(member).toContainText('插件关联姓名');await expect(member).toContainText('plugin.demo@example.org');await expect(member).toContainText('平台研发部');
  await expect(page.getByRole('textbox',{name:'筛选声明NT邮箱',exact:true})).toHaveCount(0);await expect(page.getByRole('textbox',{name:/最近观测/})).toHaveCount(0);
  const query=fixture.requests.at(-1).searchParams;expect(query.get('department_id')).toBe(ids.department);expect(query.get('search')).toBe('项目');
  await page.getByRole('textbox',{name:'搜索项目、用户或仓库',exact:true}).fill('关联姓名');await page.getByRole('button',{name:'查询',exact:true}).click();await expect.poll(()=>fixture.requests.at(-1).searchParams.get('search')).toBe('关联姓名');
  await sidebar.getByRole('link',{name:/产品体验部/}).click();await expect(page.getByRole('tab',{name:'插件采集',exact:true})).toHaveAttribute('aria-selected','true');await expect.poll(()=>fixture.requests.at(-1).searchParams.get('department_id')).toBe(ids.second);expect(fixture.requests.at(-1).searchParams.get('search')).toBe('关联姓名');
});

test('legacy plugin URLs redirect and tab navigation clears pagination and dialog state',async({page})=>{
  const fixture=await tracking(page);await page.goto(`/plugin-code-flow?dept=${ids.department}&search=applied&page=2&nt_email=plugin.demo%40example.org&from=2026-10-01T00%3A00%3A00Z`);
  await expect(page).toHaveURL(/\/code-flow\?.*source=plugin/);await expect(page.getByRole('row').filter({hasText:'/workspace/plugin-project'})).toBeVisible();await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'观测历史',exact:true}).click();await expect(page.getByRole('dialog',{name:'插件观测历史',exact:true})).toBeVisible();await page.getByRole('dialog',{name:'插件观测历史',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('tab',{name:'Hook采集',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();const hook=new URL(page.url()).searchParams;expect(hook.get('dept')).toBe(ids.department);expect(hook.get('search')).toBe('applied');for(const field of ['page','cursor','project','assoc_cursor','assoc_page','from','to','nt_email'])expect(hook.has(field)).toBe(false);
  await page.goBack();await expect(page.getByRole('tab',{name:'插件采集',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();
  await page.goForward();await expect(page.getByRole('tab',{name:'Hook采集',exact:true})).toHaveAttribute('aria-selected','true');expect(fixture.requests.at(-1).pathname).toBe('/api/v1/code-flow');
});

test('plugin member fallbacks distinguish unmatched identities and members without departments',async({page})=>{
  const fixture=await tracking(page),unmatched={...fixture.project,workspace_key:'b'.repeat(64),workspace_path:'/workspace/unmatched',nt_email:'unknown@example.org',linked_user:null},unassigned={...fixture.project,workspace_key:'c'.repeat(64),workspace_path:'/workspace/unassigned',linked_user:{...fixture.project.linked_user,name:'无部门姓名',department_id:null,department_name:null,account_status:'suspended'}};
  await page.route('**/api/v1/plugin/projects?*',route=>route.fulfill({status:200,json:fixture.result([unmatched,unassigned])}));await page.goto('/code-flow?source=plugin');
  await expect(page.getByRole('row').filter({hasText:'/workspace/unmatched'})).toContainText('未关联用户');await expect(page.getByRole('row').filter({hasText:'/workspace/unmatched'})).toContainText('unknown@example.org');const row=page.getByRole('row').filter({hasText:'/workspace/unassigned'});await expect(row).toContainText('无部门姓名');await expect(row).toContainText('当前未分配部门');await expect(row).toContainText('已停用');await expect(page.getByRole('main')).toContainText('不代表已核验邮箱所有权');
});

test('rapid tab switching cannot reveal stale plugin projects or history',async({page})=>{
  const fixture=await tracking(page);let release,started;const gate=new Promise(resolve=>{release=resolve;}),read=new Promise(resolve=>{started=resolve;});await page.route('**/api/v1/plugin/projects?*',async route=>{started();await gate;try{await route.fulfill({status:200,json:fixture.result()});}catch{/* Aborted source request. */}});
  await page.goto('/code-flow');await page.getByRole('tab',{name:'插件采集',exact:true}).click();await read;await page.getByRole('tab',{name:'Hook采集',exact:true}).click();release();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();await expect(page.getByRole('row').filter({hasText:'/workspace/plugin-project'})).toHaveCount(0);await expect(page.getByRole('dialog',{name:'插件观测历史',exact:true})).not.toBeVisible();
});

test('source tabs reset source pagination instead of reusing a hook cursor or plugin page',async({page})=>{
  const fixture=await tracking(page);await page.goto('/code-flow?source=hook&search=applied&cursor=hook-tail&page=2');await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'插件采集',exact:true}).click();await expect(page.getByText('第 1 页 · 每页20个项目',{exact:true})).toBeVisible();await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();expect(fixture.requests.at(-1).searchParams.has('cursor')).toBe(false);
  await page.getByRole('tab',{name:'Hook采集',exact:true}).click();await expect(page.getByText('第 1 页 · 每页20个项目',{exact:true})).toBeVisible();expect(fixture.requests.at(-1).pathname).toBe('/api/v1/code-flow');expect(fixture.requests.at(-1).searchParams.has('cursor')).toBe(false);
});

test('source tabs support keyboard switching and label the visible panel',async({page})=>{
  await tracking(page);await page.goto('/code-flow');const hook=page.getByRole('tab',{name:'Hook采集',exact:true}),plugin=page.getByRole('tab',{name:'插件采集',exact:true});await hook.focus();await hook.press('ArrowRight');await expect(plugin).toBeFocused();await expect(page.getByRole('tabpanel',{name:'插件采集',exact:true})).toContainText('/workspace/plugin-project');await plugin.press('Home');await expect(hook).toBeFocused();await expect(page.getByRole('tabpanel',{name:'Hook采集',exact:true})).toContainText('/workspace/demo-project');
});

test('late plugin history cannot reopen after closing it and changing sources',async({page})=>{
  const fixture=await tracking(page);let release,started;const gate=new Promise(resolve=>{release=resolve;}),read=new Promise(resolve=>{started=resolve;});await page.route('**/api/v1/plugin/observations?*',async route=>{started();await gate;try{await route.fulfill({status:200,json:fixture.result([fixture.record])});}catch{/* Aborted history request. */}});
  await page.goto('/code-flow?source=plugin');await page.getByRole('button',{name:'观测历史',exact:true}).click();await read;await page.getByRole('dialog',{name:'插件观测历史',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('tab',{name:'Hook采集',exact:true}).click();release();await expect(page.getByRole('row').filter({hasText:'/workspace/demo-project'})).toBeVisible();await expect(page.getByRole('dialog',{name:'插件观测历史',exact:true})).not.toBeVisible();await expect(page.getByRole('main')).not.toContainText('plugin.demo@example.org');
});

test('hook project session return retains the source, selected project and page',async({page})=>{
  await tracking(page);await page.goto(`/code-flow?source=hook&dept=${ids.department}&search=demo&cursor=tail&page=2&project=${ids.session}`);const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toBeVisible();const href=await dialog.getByRole('link',{name:'查看近期内容',exact:true}).getAttribute('href');expect(new URL(href,'http://local').searchParams.get('return')).toContain('source=hook');expect(new URL(href,'http://local').searchParams.get('return')).toContain('page=2');await dialog.getByRole('link',{name:'查看近期内容',exact:true}).click();await page.getByRole('button',{name:'返回原列表',exact:true}).click();await expect(page.getByRole('tab',{name:'Hook采集',exact:true})).toHaveAttribute('aria-selected','true');await expect(dialog).toBeVisible();await expect(page.getByText('第 2 页 · 每页20个项目',{exact:true})).toBeVisible();
});
