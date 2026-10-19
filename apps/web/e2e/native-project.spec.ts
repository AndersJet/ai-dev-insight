import {test,expect} from './helpers/browser.js';
import {realHookClient} from './helpers/hook-client.js';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {CodeFlowDto} from '@adi/contracts';
import {pluginHookMaterial} from './helpers/plugin-material.js';
import {resetSyntheticHookFixture} from './helpers/registered-fixture.js';

test('downloaded native client observes real Git projects and cached Hooks remain linked in the browser',async({page})=>{
  test.skip(!['darwin','win32'].includes(process.platform),'native producer acceptance requires macOS or Windows 5.1');
  const directory=await realpath(await mkdtemp(join(tmpdir(),'adi-native-browser-project-'))),workspace=join(directory,'真实项目 with spaces');
  const macos=process.platform==='darwin',emptyConfig=join(directory,'empty.gitconfig');
  await writeFile(emptyConfig,'');
  const environment={...(macos?{PATH:'/usr/bin:/bin'}:{}),GIT_CONFIG_GLOBAL:emptyConfig,GIT_CONFIG_SYSTEM:emptyConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
  const git=(...args:string[])=>promisify(execFile)(macos?'/usr/bin/git':'git.exe',args,{env:{...process.env,...environment}});
  let client:Awaited<ReturnType<typeof realHookClient>>|undefined;
  try{
    await git('init','--quiet','--template=',workspace);
    await git('-C',workspace,'remote','add','origin','https://synthetic-user:synthetic-secret@10.24.0.12/team/native.git?token=synthetic-secret');
    await git('-C',workspace,'remote','add','mirror','https://native-personal.example.invalid/team/native.git');
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
    await resetSyntheticHookFixture(page);
    const material=await pluginHookMaterial(page),issuedAt=material.issuedAt;
    const archive=join(directory,'client.zip');await writeFile(archive,material.archive,{mode:0o600});client=await realHookClient(archive,material.runtimeOwner);
    // The collector refreshes its credential snapshot independently. Wait for
    // an observed snapshot query started after issuance, without warming the
    // sender or publishing a replacement Hook for the assertion below.
    await expect.poll(async()=>{
      const response=await page.request.get('/api/v1/system/health');expect(response.ok()).toBe(true);
      const health=(await response.json()).data;
      const current=health.instances.find((item:{boot_id:string})=>item.boot_id===health.collector.boot_id);
      const expiresAt=current?.metrics.delivery_policyExpiresAt;
      return current?.fresh===true&&typeof expiresAt==='number'&&expiresAt-10000>=issuedAt;
    },{timeout:15000}).toBe(true);
    const source=randomUUID();await client.send({hook_event_name:'UserPromptSubmit',session_id:source,cwd:workspace,prompt:'仅为对话文本 https://dialogue-only.example.invalid/ignore.git'},environment);
    const query=async()=>{const response=await page.request.get(`/api/v1/code-flow?search=${encodeURIComponent(workspace)}`);expect(response.ok()).toBe(true);return (await response.json()).data as CodeFlowDto;};
    await expect.poll(async()=>(await query()).total,{timeout:12000}).toBe(1);
    const first=(await query()).items[0]!;expect(first.state).toBe('repository');expect(first.git_root).toBe(macos?workspace:workspace.replaceAll('\\','/'));expect(first.source_hook_session_id).toBe(source);
    // Fetch and push of the same repository remain one normalized address.
    expect(first.remotes).toHaveLength(2);expect(first.remotes.filter(remote=>remote.source_tag==='department')).toHaveLength(1);expect(first.remotes.filter(remote=>remote.source_tag==='personal')).toHaveLength(1);
    expect(first.remotes.map(remote=>remote.address).sort()).toEqual(['https://10.24.0.12/team/native.git','https://native-personal.example.invalid/team/native.git']);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret');expect(JSON.stringify(first)).not.toContain('dialogue-only');
    // A later real Hook reuses the old probe; changed local Git config must not
    // bypass five-minute throttling or rewrite the observation's source/time.
    await git('-C',workspace,'remote','set-url','origin','https://not-yet-observed.example.invalid/changed.git');
    const later=randomUUID();await client.send({hook_event_name:'UserPromptSubmit',session_id:later,cwd:workspace,prompt:'第二次实际Hook'},environment);
    await expect.poll(async()=>(await query()).items[0]?.session_count,{timeout:12000}).toBe(2);
    const cached=(await query()).items[0]!;expect(cached.id).toBe(first.id);expect(cached.collector_id).toBe(first.collector_id);expect(cached.observation_id).toBe(first.observation_id);expect(cached.observed_at).toBe(first.observed_at);expect(cached.source_hook_session_id).toBe(source);expect(cached.remotes).toEqual(first.remotes);
    await page.goto(`/code-flow?search=${encodeURIComponent(workspace)}&from=1999&to=ignored`);
    const row=page.getByRole('row').filter({hasText:workspace});await expect(row).toContainText('https://10.24.0.12/team/native.git');await expect(row).toContainText('https://native-personal.example.invalid/team/native.git');
    await expect(row).not.toContainText('not-yet-observed');await expect(page.getByRole('radiogroup',{name:'日期范围',exact:true})).toHaveCount(0);
    await row.getByRole('button',{name:'关联会话',exact:true}).click();const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText(source);await expect(dialog).toContainText(later);await expect(dialog.getByTestId('project-observed-session')).toHaveText(source);
  }finally{await client?.dispose();await rm(directory,{recursive:true,force:true});}
});
