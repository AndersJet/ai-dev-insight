import {test,expect} from './helpers/browser.js';
import {mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';
import type {CodeFlowDto} from '@adi/contracts';

// Human operates the named, logged-in IDE window; this harness supplies only
// a project Hook and checks the real producer through API/PG and the browser.
// It does not type prompts, guess selected models or manufacture Hook events.
test('real Trae conversations reach the project inventory from the explicitly authorized test project',async({page})=>{
  test.skip(process.env.ADI_TEST_REAL_TRAE!=='1','requires user-authorized live IDE operation');
  test.setTimeout(600000);
  const workspace=process.env.ADI_TEST_REAL_TRAE_PROJECT;
  expect(workspace,'explicitly authorized absolute test project').toBeTruthy();
  expect(workspace).toMatch(/^\//);
  expect(process.platform).toBe('darwin');
  const profile=join(workspace!,'.trae'),base=join(profile,'adi-native-collector'),hooks=join(profile,'hooks.json');
  let before:Buffer|undefined;
  try{before=await readFile(hooks);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{await access(base);throw new Error('live test must not replace an existing project installation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const directory=join(workspace!,'.adi-validation-live-'+randomUUID().slice(0,8));await mkdir(directory,{mode:0o700});
  let installed=false;
  const ready=join(process.cwd(),'.run','real-trae-ready.json'),completed=join(process.cwd(),'.run','real-trae-ui-complete.json');
  await rm(completed,{force:true});
  const installer=join(directory,'install-hook.sh');
  try{
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
    const csrf=(await page.context().cookies()).find(item=>item.name==='adi_csrf')!.value;
    const credential=await page.request.get('/api/v1/me/collection-credential');expect(credential.ok()).toBe(true);
    if((await credential.json()).data.reset_required){const reset=await page.request.post('/api/v1/me/collection-credential/reset',{headers:{'x-csrf-token':csrf},data:{}});expect(reset.ok()).toBe(true);}
    const issued=await page.request.post('/api/v1/me/collection-client',{headers:{'x-csrf-token':csrf},data:{}});expect(issued.ok()).toBe(true);const issuedAt=Date.now();
    for(const[name,bytes]of Object.entries(unzipSync(await issued.body())))await writeFile(join(directory,name),bytes,{mode:0o600});
    await promisify(execFile)('/bin/bash',[installer,'install','--trae-dir',profile,'--credentials',join(directory,'adi-installation.json')],{env:{...process.env,PATH:'/usr/bin:/bin'}});installed=true;
    await expect.poll(async()=>{
      const result=await page.request.get('/api/v1/system/health');expect(result.ok()).toBe(true);const health=(await result.json()).data;
      const current=health.instances.find((item:{boot_id:string})=>item.boot_id===health.collector.boot_id),expires=current?.metrics.delivery_policyExpiresAt;
      return current?.fresh===true&&typeof expires==='number'&&expires-10000>=issuedAt;
    },{timeout:15000}).toBe(true);
    await writeFile(ready,JSON.stringify({workspace,profile,ready_at:new Date().toISOString(),minimum_sessions:2,project_hooks_enable_required:true,restore_project_hooks_enable_after_test:true}),{mode:0o600});
    const query=async()=>{const result=await page.request.get('/api/v1/code-flow?search='+encodeURIComponent(workspace!));expect(result.ok()).toBe(true);return (await result.json()).data as CodeFlowDto;};
    // Only real IDE events can satisfy this poll. Manual UI evidence must also
    // identify the two selected model categories and their responses.
    await expect.poll(async()=>{try{return JSON.parse(await readFile(completed,'utf8')).completed===true;}catch{return false;}},{timeout:540000,intervals:[1000]}).toBe(true);
    await expect.poll(async()=>(await query()).items[0]?.session_count??0,{timeout:540000,intervals:[1000]}).toBeGreaterThanOrEqual(2);
    const project=(await query()).items[0]!;expect(project.platform).toBe('macos');expect(project.state).toBe('not_git');expect(project.git_root).toBeNull();expect(project.remotes).toEqual([]);
    await page.goto('/code-flow?search='+encodeURIComponent(workspace!));const row=page.getByRole('row').filter({hasText:workspace!});await expect(row).toBeVisible();await row.getByRole('button',{name:'关联会话',exact:true}).click();const dialog=page.getByRole('dialog',{name:'项目关联会话',exact:true});await expect(dialog).toBeVisible();
    await writeFile(join(process.cwd(),'.run','real-trae-result.json'),JSON.stringify({project,observed_at:new Date().toISOString()}),{mode:0o600});
  }finally{
    await rm(ready,{force:true});
    if(installed){await promisify(execFile)('/bin/bash',[installer,'uninstall','--trae-dir',profile],{env:{...process.env,PATH:'/usr/bin:/bin'}});await rm(base,{recursive:true,force:true});}
    if(installed&&!before){const remaining=JSON.parse(await readFile(hooks,'utf8'));if(Object.values(remaining.hooks??{}).every(value=>Array.isArray(value)&&value.length===0))await rm(hooks,{force:true});}
    await rm(directory,{recursive:true,force:true});
  }
});
