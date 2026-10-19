import {test,expect} from '../e2e/helpers/browser.js';
import {URL} from 'node:url';
import {mockPage,ids} from './fixtures.mjs';

const firstAddress='https://git.example.com/team/project.git',secondAddress='https://git.example.com/fork/project.git';
const cases=[
  {name:'shared legacy repository addresses',remotes:[{name:'origin',direction:'fetch',address:firstAddress},{name:'upstream',direction:'push',address:firstAddress}],addresses:[firstAddress]},
  {name:'different legacy repository addresses',remotes:[{name:'origin',direction:'fetch',address:firstAddress},{name:'origin',direction:'push',address:secondAddress}],addresses:[firstAddress,secondAddress]},
  {name:'unknown legacy repository addresses',remotes:[{name:'origin',direction:'fetch',address:null},{name:'upstream',direction:'push',address:null}],addresses:[null]},
  {name:'address-only repository records',remotes:[{address:firstAddress},{address:firstAddress},{address:secondAddress}],addresses:[firstAddress,secondAddress]},
];
async function mockPlugin(page,remotes){
  await mockPage(page);
  const record={nt_email:'plugin.demo@example.org',collector_id:ids.user,source_config_id:ids.second,observation_id:ids.session,sequence:'1',platform:'macos',workspace_path:'/workspace/plugin-project',workspace_key:'a'.repeat(64),observed_at:'2026-10-05T00:00:00.000Z',received_at:'2026-10-05T00:00:01.000Z',state:'repository',reason:null,git_root:'/workspace/plugin-project',remotes,plugin_version:'0.1.0'};
  const project={nt_email:record.nt_email,collector_id:record.collector_id,workspace_key:record.workspace_key,workspace_path:record.workspace_path,platform:record.platform,latest:record,confirmed:record};
  const result=items=>({data:{items,total:1,page:1,limit:20,has_more:false},meta:{request_id:'plugin-ui'}});
  await page.route('**/api/v1/plugin/projects?*',route=>route.fulfill({status:200,json:result([project])}));
  await page.route('**/api/v1/plugin/observations?*',route=>route.fulfill({status:200,json:result([record])}));
  return {record,project,result};
}

for(const surface of ['latest','history']){
  test(`plugin ${surface} shows current repository affiliation once per address`,async({page})=>{
    await mockPlugin(page,[
      {address:firstAddress,host:'git.example.com',source_tag:'department',reason:'allowlist'},
      {address:firstAddress,host:'git.example.com',source_tag:'department',reason:'allowlist'},
      {address:secondAddress,host:'git.example.com',source_tag:'personal',reason:'unmatched'},
      {address:null,host:null,source_tag:null,reason:'unrecognized'},
    ]);
    await page.goto('/plugin-code-flow');const project=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});
    let container=project.getByRole('cell').nth(2);
    if(surface==='history'){
      await project.getByRole('button',{name:'观测历史',exact:true}).click();
      container=page.getByRole('dialog',{name:'插件观测历史',exact:true}).getByRole('row').filter({has:page.locator('.plugin-remote')}).getByRole('cell').nth(2);
    }
    await expect(container.locator('.el-tag--info')).toHaveText(['部门']);
    await expect(container.locator('.el-tag--warning')).toHaveText(['个人']);
    await expect(container).toContainText('归类未知');await expect(container.locator('.plugin-remote')).toHaveCount(3);
    await expect(container).not.toContainText(/origin|upstream|fetch|push/);
  });
}

test('plugin shares the allowlist and refreshes current projects and the current history page after a rule change',async({page})=>{
  const fixture=await mockPlugin(page,[{address:firstAddress,host:'git.example.com',source_tag:'personal',reason:'unmatched'}]);let projectReads=0,historyReads=0;const historyPages=[];
  await page.route('**/api/v1/plugin/projects?*',route=>{projectReads++;return route.fulfill({status:200,json:fixture.result([fixture.project])});});
  await page.route('**/api/v1/plugin/observations?*',route=>{historyReads++;const page=Number(new URL(route.request().url()).searchParams.get('page')??1);historyPages.push(page);return route.fulfill({status:200,json:{data:{...fixture.result([fixture.record]).data,page,total:21,has_more:page===1}}});});
  const rule={id:ids.second,kind:'host',value:'git.example.com',version:1,created_at:'2026-10-05T00:00:00.000Z',updated_at:'2026-10-05T00:00:00.000Z'};
  await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:200,json:{data:{items:[],total:0,next_cursor:null}}}));
  await page.route('**/api/v1/repository-allowlist',route=>{expect(route.request().method()).toBe('POST');expect(route.request().postDataJSON()).toEqual({kind:'host',value:rule.value});fixture.record.remotes=[{address:firstAddress,host:'git.example.com',source_tag:'department',reason:'allowlist'}];return route.fulfill({status:201,json:{data:rule}});});
  await page.goto('/plugin-code-flow');const project=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});await expect(project.locator('.el-tag--warning')).toHaveText('个人');
  await project.getByRole('button',{name:'观测历史',exact:true}).click();const history=page.getByRole('dialog',{name:'插件观测历史',exact:true});await expect(history.locator('.el-tag--warning')).toHaveText('个人');await history.getByRole('button',{name:'下一页',exact:true}).click();await expect(history).toContainText('第 2 页');
  await history.getByRole('button',{name:'部门仓库白名单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});await expect(dialog).toBeVisible();
  await dialog.getByLabel('匹配地址',{exact:true}).fill(rule.value);await dialog.getByRole('button',{name:'添加规则',exact:true}).click();
  await expect.poll(()=>projectReads).toBe(2);await expect.poll(()=>historyReads).toBe(3);expect(historyPages).toEqual([1,2,2]);
  await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(history.locator('.el-tag--info')).toHaveText('部门');await expect(history).toContainText('第 2 页');
  await history.getByRole('button',{name:'关闭',exact:true}).last().click();await expect(project.locator('.el-tag--info')).toHaveText('部门');
});

for(const [status,code] of [[403,'forbidden'],[401,'unauthorized'],[503,'recovery_quarantined']]){
  test(`plugin allowlist ${code} clears protected project and history data`,async({page})=>{
    await mockPlugin(page,[{address:firstAddress,host:'git.example.com',source_tag:'department',reason:'allowlist'}]);
    await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status,json:{error:{code,message:'仓库配置权限不可用',request_id:'plugin-ui'}}}));
    await page.goto('/plugin-code-flow');const project=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});await project.getByRole('button',{name:'观测历史',exact:true}).click();
    const history=page.getByRole('dialog',{name:'插件观测历史',exact:true});await expect(history).toContainText(firstAddress);
    await history.getByRole('button',{name:'部门仓库白名单',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'部门仓库白名单',exact:true})).not.toBeVisible();await expect(history).not.toBeVisible();await expect(project).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('仓库配置权限不可用');
  });
}

for(const deniedSurface of ['projects','observations']){
  test(`a denied plugin ${deniedSurface} refresh cannot be overwritten by the other late success`,async({page})=>{
    const fixture=await mockPlugin(page,[{address:firstAddress,host:'git.example.com',source_tag:'personal',reason:'unmatched'}]);let changed=false,started=0,ready,release;
    const bothStarted=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    for(const surface of ['projects','observations'])await page.route(`**/api/v1/plugin/${surface}?*`,async route=>{
      if(changed){started++;if(started===2)ready();if(surface===deniedSurface){await bothStarted;return route.fulfill({status:403,json:{error:{code:'forbidden',message:'项目读取权限已撤销',request_id:'plugin-ui'}}});}await gate;}
      return route.fulfill({status:200,json:fixture.result([surface==='projects'?fixture.project:fixture.record])});
    });
    await page.route('**/api/v1/repository-allowlist?*',route=>route.fulfill({status:200,json:{data:{items:[],total:0,next_cursor:null}}}));
    await page.route('**/api/v1/repository-allowlist',route=>{changed=true;return route.fulfill({status:201,json:{data:{id:ids.second,kind:'host',value:'git.example.com',version:1,created_at:'2026-10-05T00:00:00.000Z',updated_at:'2026-10-05T00:00:00.000Z'}}});});
    await page.goto('/plugin-code-flow');const project=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});await project.getByRole('button',{name:'观测历史',exact:true}).click();const history=page.getByRole('dialog',{name:'插件观测历史',exact:true});await expect(history).toContainText(firstAddress);
    await history.getByRole('button',{name:'部门仓库白名单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'部门仓库白名单',exact:true});await dialog.getByLabel('匹配地址',{exact:true}).fill('git.example.com');
    try{await dialog.getByRole('button',{name:'添加规则',exact:true}).click();await bothStarted;await expect(page.getByRole('main').getByRole('alert')).toContainText('项目读取权限已撤销');await expect(history).not.toBeVisible();await expect(dialog).not.toBeVisible();}finally{release();}
    await page.waitForLoadState('networkidle');await expect(project).toHaveCount(0);await expect(history).not.toBeVisible();
  });
}

test('plugin project layout uses code-flow table and toolbar styles with contained narrow-screen scrolling',async({page})=>{
  await mockPlugin(page,[{address:firstAddress,host:'git.example.com',source_tag:'department',reason:'allowlist'}]);
  await page.goto('/code-flow');await expect(page.locator('.project-table tbody tr').first()).toBeVisible();
  const reference=await page.locator('.project-table th').first().evaluate(el=>{const s=el.ownerDocument.defaultView.getComputedStyle(el);return{padding:s.padding,fontSize:s.fontSize,color:s.color,border:s.borderBottom};});
  await page.goto('/plugin-code-flow');await expect(page.locator('.page-heading h1')).toHaveText('代码流向追踪');await expect(page.locator('.page-toolbar .search-row')).toBeVisible();
  const panel=page.locator('section.data-panel');await expect(panel.locator('.project-table .project-path').first()).toHaveText('/workspace/plugin-project');
  const actual=await panel.locator('.project-table th').first().evaluate(el=>{const s=el.ownerDocument.defaultView.getComputedStyle(el);return{padding:s.padding,fontSize:s.fontSize,color:s.color,border:s.borderBottom};});expect(actual).toEqual(reference);
  await expect(page.getByText('共 1 个插件来源项目实例 · 观测不自动过期 · 仅超管可见',{exact:true})).toBeVisible();await expect(panel.locator('.table-pager')).toContainText('每页20个项目');
  await page.setViewportSize({width:760,height:1000});await expect(page.getByRole('button',{name:'部门仓库白名单',exact:true})).toBeVisible();
  const bounds=await page.locator('.project-table').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,outer:el.ownerDocument.documentElement.clientWidth,page:el.ownerDocument.documentElement.scrollWidth}));expect(bounds.scroll).toBeGreaterThan(bounds.client);expect(bounds.page).toBeLessThanOrEqual(bounds.outer+1);
  await page.setViewportSize({width:600,height:1000});await page.getByRole('row').filter({hasText:'/workspace/plugin-project'}).getByRole('button',{name:'观测历史',exact:true}).click();
  const history=page.getByRole('dialog',{name:'插件观测历史',exact:true}),dialogBounds=await history.boundingBox();
  for(const button of await history.locator('.history-pager button').all()){await expect(button).toBeVisible();const buttonBounds=await button.boundingBox();expect(buttonBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);expect(buttonBounds.x+buttonBounds.width).toBeLessThanOrEqual(dialogBounds.x+dialogBounds.width);}
});
for(const surface of ['latest','history'])for(const scenario of cases){
  test(`plugin ${surface} lists ${scenario.name} once per address`,async({page})=>{
    await mockPlugin(page,scenario.remotes);await page.goto('/plugin-code-flow');
    const project=page.getByRole('row').filter({hasText:'/workspace/plugin-project'});
    await expect(project).toHaveCount(1);await expect(project).toBeVisible();let container=project.getByRole('cell').nth(2);
    if(surface==='history'){
      await project.getByRole('button',{name:'观测历史',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'插件观测历史',exact:true});await expect(dialog).toBeVisible();
      const historyRow=dialog.getByRole('row').filter({has:page.locator('.plugin-remote')});await expect(historyRow).toHaveCount(1);
      container=historyRow.getByRole('cell').nth(2);
    }
    const remotes=container.locator('.plugin-remote');await expect(remotes).toHaveCount(scenario.addresses.length);
    for(const [index,address] of scenario.addresses.entries())await expect(remotes.nth(index)).toHaveText(address??'地址未确认');
    await expect(container).not.toContainText(/origin|upstream|fetch|push/);
  });
}
