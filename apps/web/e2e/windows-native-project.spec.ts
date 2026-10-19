import {test,expect} from './helpers/browser.js';
import {parallelsProjectClient} from './helpers/parallels-client.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {CodeFlowDto} from '@adi/contracts';
import {pluginHookMaterial} from './helpers/plugin-material.js';
import {resetSyntheticHookFixture} from './helpers/registered-fixture.js';

test('Windows personal ZIP produces real project evidence persisted by collector and visible in browser',async({page})=>{
  test.skip(process.env.ADI_TEST_PARALLELS_WINDOWS!=='1','requires the opt-in existing Windows test VM');test.setTimeout(120000);
  const directory=await mkdtemp(join(tmpdir(),'adi-windows-browser-'));
  let client:Awaited<ReturnType<typeof parallelsProjectClient>>|undefined;
  try{
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
    await resetSyntheticHookFixture(page);
    const material=await pluginHookMaterial(page),issuedAt=material.issuedAt;
    const archive=join(directory,'client.zip');await writeFile(archive,material.archive,{mode:0o600});client=await parallelsProjectClient(archive,material.runtimeOwner);
    await expect.poll(async()=>{
      const result=await page.request.get('/api/v1/system/health');expect(result.ok()).toBe(true);const health=(await result.json()).data;
      const current=health.instances.find((item:{boot_id:string})=>item.boot_id===health.collector.boot_id),expires=current?.metrics.delivery_policyExpiresAt;
      return current?.fresh===true&&typeof expires==='number'&&expires-10000>=issuedAt;
    },{timeout:15000}).toBe(true);
    const source=randomUUID();await client.send(source);expect(client.forwarded()).toBe(1);
    const query=async()=>{const result=await page.request.get('/api/v1/code-flow?search='+encodeURIComponent(client!.workspace));expect(result.ok()).toBe(true);return (await result.json()).data as CodeFlowDto;};
    await expect.poll(async()=>(await query()).total,{timeout:12000}).toBe(1);
    const first=(await query()).items[0]!;expect(first.state).toBe('repository');expect(first.platform).toBe('windows');expect(first.source_hook_session_id).toBe(source);expect(first.git_root).toBe(client.workspace.replaceAll('\\','/'));
    expect(first.remotes).toHaveLength(2);expect(first.remotes.filter(item=>item.source_tag==='department')).toHaveLength(1);expect(first.remotes.filter(item=>item.source_tag==='personal')).toHaveLength(1);expect(JSON.stringify(first)).not.toContain('synthetic-secret');expect(JSON.stringify(first)).not.toContain('dialogue-only');
    await client.changeRemote();const later=randomUUID();await client.send(later);expect(client.forwarded()).toBe(2);
    await expect.poll(async()=>(await query()).items[0]?.session_count,{timeout:12000}).toBe(2);const cached=(await query()).items[0]!;
    expect(cached.collector_id).toBe(first.collector_id);expect(cached.observation_id).toBe(first.observation_id);expect(cached.observed_at).toBe(first.observed_at);expect(cached.remotes).toEqual(first.remotes);
    await page.goto('/code-flow?search='+encodeURIComponent(client.workspace)+'&from=1999&to=ignored');const row=page.getByRole('row').filter({hasText:client.workspace});await expect(row).toContainText('https://10.24.0.12/team/native.git');await expect(row).toContainText('https://native-personal.example.invalid/team/native.git');await expect(row).not.toContainText('not-yet-observed');
    await row.getByRole('button',{name:'关联会话',exact:true}).click();const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toContainText(source);await expect(dialog).toContainText(later);
  }finally{await client?.dispose();await rm(directory,{recursive:true,force:true});}
});
