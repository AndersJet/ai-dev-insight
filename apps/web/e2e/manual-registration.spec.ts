import {e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {realHookClient} from './helpers/hook-client.js';
import {pluginHookMaterial} from './helpers/plugin-material.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('anonymous installation guide redirects to login while four role manuals remain available',async({page})=>{
  const f=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
  await page.goto('/manual');await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('link',{name:'操作手册',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'下载个人安装包',exact:true})).toHaveCount(0);
  const people=[
    {email:f.admin.email,password:f.admin.password,title:'系统管理员操作手册',path:'system-admin'},
    {...f.roleNavigation.anc_admin,title:'组织管理员操作手册',path:'anc-admin'},
    {email:f.analytics.managerEmail,password:f.analytics.managerPassword,title:'一级部门管理员操作手册',path:'department-admin'},
    {...f.roleNavigation.employee,title:'普通员工操作手册',path:'employee'},
  ];
  for(const person of people){
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(person.email);await page.getByLabel('密码',{exact:true}).fill(person.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    const button=page.getByRole('button',{name:'操作手册',exact:true});await button.click();await expect(page).toHaveURL(new RegExp(`/manual/${person.path}$`));await expect(page.getByRole('heading',{name:person.title,exact:true})).toBeVisible();
    const bounds=await button.boundingBox(),logout=await page.getByRole('button',{name:'退出登录',exact:true}).boundingBox();expect(bounds!.x).toBeLessThan(logout!.x);
    await page.screenshot({path:`.run/manual-${person.path}.png`,fullPage:true});
    if(person.path==='employee'){await page.goto('/manual/system-admin');await expect(page).toHaveURL(/\/manual\/employee$/);}
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page).toHaveURL(/\/login$/);
  }
});

test('password registration and private plugin Hook material turn pending adoption into adopted on persisted Hook',async({page,request})=>{
  test.skip(!['darwin','win32'].includes(process.platform),'Native client acceptance requires an employee target platform');
  const login=await request.post('/api/v1/auth/login',{data:{email:'e2e-root@example.invalid',password:'e2e-admin-test-password'}});expect(login.status()).toBe(200);
  const csrf=(await request.storageState()).cookies.find(item=>item.name==='adi_csrf')!.value;
  const departmentName=`原生注册独立部门-${randomUUID().slice(0,8)}`;
  const department=await request.post('/api/v1/departments',{headers:{'x-csrf-token':csrf},data:{name:departmentName}});expect(department.status()).toBe(201);
  const email=`onboarding-native-${randomUUID()}@example.org`;
  await page.goto('/register');await page.getByLabel('工作邮箱',{exact:true}).fill(email);
  await expect(page.getByLabel('邮箱验证码',{exact:true})).toHaveCount(0);
  await page.getByLabel('姓名',{exact:true}).fill('自助注册合成员工');
  await page.getByRole('combobox',{name:'一级部门',exact:true}).click();await page.getByRole('option',{name:departmentName,exact:true}).click();await expect(page.getByRole('option',{name:departmentName,exact:true})).toBeHidden();
  await page.getByLabel('密码',{exact:true}).fill('native-onboarding-password');await page.getByLabel('确认密码',{exact:true}).fill('native-onboarding-password');await page.screenshot({path:'.run/registration-direct.png',fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'注册并进入采集安装',exact:true}).click();
  await expect(page).toHaveURL(/\/my\/installations$/);expect((await(await page.request.get('/api/v1/adoption?scope=self')).json()).data.adopted).toBe(0);
  await expect(page.getByRole('button',{name:'生成在线安装命令',exact:true})).toHaveCount(0);
  const material=await pluginHookMaterial(page),directory=await mkdtemp(join(tmpdir(),'adi-registration-plugin-')),archive=join(directory,'client.zip');await writeFile(archive,material.archive,{mode:0o600});
  const client=await realHookClient(archive,material.runtimeOwner);
  try {await expect.poll(async()=>{await client.send({session_id:`native-registration-${randomUUID()}`,hook_event_name:'SessionStart',source:'startup'});const r=await page.request.get('/api/v1/adoption?scope=self');return (await r.json()).data.adopted;},{timeout:12000}).toBe(1);await page.goto('/my/overview');await expect(page.getByRole('region',{name:'采纳进度'}).getByText('已采纳',{exact:true})).toBeVisible();await page.screenshot({path:'.run/registration-adopted.png',fullPage:true});}
  finally {await client.dispose();await rm(directory,{recursive:true,force:true});}
});

test('prebuilt employee signs in with temporary password and completes registration without email or password replacement',async({page,request})=>{
  const login=await request.post('/api/v1/auth/login',{data:{email:'e2e-root@example.invalid',password:'e2e-admin-test-password'}});expect(login.status()).toBe(200);
  const csrf=(await request.storageState()).cookies.find(item=>item.name==='adi_csrf')!.value,headers={'x-csrf-token':csrf};
  const created=await request.post('/api/v1/departments',{headers,data:{name:`预建档注册-${randomUUID().slice(0,8)}`}});expect(created.status()).toBe(201);
  const department=(await created.json()).data;
  const email=`activation-${randomUUID()}@example.org`;
  const added=await request.post(`/api/v1/departments/${department.id}/members`,{headers,data:{email,display_name:'预建档合成员工'}});expect(added.status()).toBe(201);
  const member=(await added.json()).data;
  const issued=await request.post(`/api/v1/admin/users/${member.user_id}/reset-password`,{headers,data:{version:member.version,reason:'initial_issue'}});expect(issued.status()).toBe(200);
  const temporary=(await issued.json()).data.temporary_password;
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(temporary);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page).toHaveURL(/\/change-password/);
  await page.getByLabel('当前密码',{exact:true}).fill(temporary);await page.getByLabel('新密码',{exact:true}).fill('activated-employee-password');await page.getByLabel('确认新密码',{exact:true}).fill('activated-employee-password');
  await page.getByRole('button',{name:'保存并继续',exact:true}).click();
  await expect(page).toHaveURL(/\/register$/);await expect(page.getByRole('heading',{name:'完成账号注册',exact:true})).toBeVisible();
  await expect(page.getByLabel('工作邮箱',{exact:true})).toBeDisabled();await expect(page.getByLabel('密码',{exact:true})).toHaveCount(0);await expect(page.getByLabel('邮箱验证码',{exact:true})).toHaveCount(0);
  await page.screenshot({path:'.run/registration-activation.png',fullPage:true});
  await page.getByRole('button',{name:'完成注册并进入采集安装',exact:true}).click();
  await expect(page).toHaveURL(/\/my\/installations$/);expect((await(await page.request.get('/api/v1/adoption?scope=self')).json()).data.adopted).toBe(0);
  const me=await page.request.get('/api/v1/me');expect((await me.json()).data.registered).toBe(true);
});

test('retired general guide leads authenticated users to personal installation',async({page})=>{
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
  await page.goto('/manual');await expect(page).toHaveURL(/\/my\/installations$/);
  await page.getByRole('button',{name:'操作手册',exact:true}).click();
  await page.locator('.manual-actions').getByRole('link',{name:'采集安装与下载',exact:true}).click();await expect(page).toHaveURL(/\/my\/installations$/);
});
