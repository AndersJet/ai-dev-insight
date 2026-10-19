import {test,expect} from './helpers/browser.js';
import {registeredFixture} from './helpers/registered-fixture.js';
import {environment as env,e2eArtifact} from './helpers/environment.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

test('管理员上传真实VSIX并指定试用后正式发布，匿名员工可从登录页下载原包',async({page,browser})=>{
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill('e2e-root@example.invalid');await page.getByLabel('密码',{exact:true}).fill('e2e-admin-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
 const actor=(await(await page.request.get('/api/v1/me')).json()).data;await registeredFixture(actor.user_id);
 await page.goto('/system/plugin-releases');const {version}=JSON.parse(await readFile(resolve('trae-plugin/package.json'),'utf8'));const file=resolve(`trae-plugin/dist/adi-project-tracker-${version}.vsix`);const source=await readFile(file);
 await page.getByLabel('上传 VSIX 安装包').setInputFiles(file);await expect(page.getByText('安装包已上传。正式发布前可以指定试用。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'指定试用',exact:true}).click();await page.getByRole('combobox',{name:'选择试用人员'}).fill('e2e-root');await page.getByRole('option',{name:'端到端合成管理员 · e2e-root@example.invalid',exact:true}).click();await page.getByRole('heading',{name:'指定插件试用',exact:true}).click();await page.getByRole('button',{name:'保存指定试用',exact:true}).click();await expect(page.getByText('当前试用版',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'正式发布',exact:true}).click();await page.getByRole('button',{name:'确认发布',exact:true}).click();await expect(page.getByText('当前正式版',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog',{name:'确认正式发布',exact:true})).toBeHidden();await page.screenshot({path:e2eArtifact('plugin-releases-wide.png'),fullPage:true});
 const guest=await browser.newContext();try{const anonymous=await guest.newPage();await anonymous.goto(env.webURL+'/login');const link=anonymous.getByRole('link',{name:`下载正式版插件 ${version}`});await expect(link).toBeVisible();const path=await link.getAttribute('href');expect(path).toBeTruthy();const downloaded=await anonymous.request.get(env.webURL+path);expect(downloaded.status()).toBe(200);expect(createHash('sha256').update(await downloaded.body()).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'));
 await anonymous.setViewportSize({width:390,height:844});await expect(link).toBeVisible();await anonymous.screenshot({path:e2eArtifact('plugin-download-narrow.png'),fullPage:true});
 }finally{await guest.close();}
});
