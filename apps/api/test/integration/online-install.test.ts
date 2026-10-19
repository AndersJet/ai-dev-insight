import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {pluginFixture} from '../plugin-fixture.js';

test('retired terminal issuance and script downloads cannot be used; personal package requires its scoped grant',async t=>{
 const {app,bearer,headers,root,installations}=await pluginFixture(t);
 for(const path of ['/api/v1/me/collection-install-command','/api/v1/me/collection-client'])assert.equal((await app.inject({method:'POST',url:path,headers,payload:{}})).statusCode,410);
 for(const platform of ['macos','windows'])assert.equal((await app.inject({url:'/api/v1/collection-install/'+platform})).statusCode,410);
 const grant=(await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).json().data;
 assert.equal((await app.inject({url:grant.download_path})).statusCode,401);assert.equal((await app.inject({url:grant.download_path,headers})).statusCode,401);
 assert.equal((await app.inject({url:'/api/v1/me',headers:{cookie:'adi_session='+grant.authorization}})).statusCode,401);
 const credential=await installations.credential(root.token);
 assert.equal((await app.inject({url:grant.download_path,headers:{authorization:'Bearer '+credential.token}})).statusCode,401);
 const packageReply=await app.inject({url:grant.download_path,headers:{authorization:'Bearer '+grant.authorization}});assert.equal(packageReply.statusCode,200);
 const config=JSON.parse(Buffer.from(unzipSync(packageReply.rawPayload)['adi-installation.json']!).toString('utf8'));assert.equal(config.installation_id,grant.installation_id);assert.equal(config.token,credential.token);
 const old=await installations.issueDownloadGrant(root.token);assert.equal((await app.inject({url:grant.download_path,headers:{authorization:'Bearer '+old.authorization}})).statusCode,401);
});

test('30-minute package grants expire without changing Hook credentials; explicit reset invalidates them',async t=>{
 let time=new Date();const {app,bearer,installations,root}=await pluginFixture(t,()=>time);
 const generate=async()=>{const reply=await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}});assert.equal(reply.statusCode,200);return reply.json().data;};
 const grant=await generate(),get=(authorization:string)=>app.inject({url:grant.download_path,headers:{authorization:'Bearer '+authorization}}),credential=await installations.credential(root.token);
 time=new Date(time.getTime()+29*60000);assert.equal((await get(grant.authorization)).statusCode,200);
 time=new Date(time.getTime()+60000);const expired=await get(grant.authorization);assert.equal(expired.statusCode,410);assert.equal(expired.json().error.code,'installation_command_expired');
 const next=await generate();assert.equal(next.installation_id,credential.installation.id);assert.deepEqual(await installations.credential(root.token),credential);
 await installations.reset(root.token);assert.equal((await get(next.authorization)).statusCode,401);
});

test('downloaded personal material remains installable through fixed macOS plan/install after grant expiry, preserving unrelated Hooks', {skip:process.platform!=='darwin'},async t=>{
 let time=new Date();const {app,bearer,root}=await pluginFixture(t,()=>time);
 const {mkdtemp,mkdir,readFile,writeFile,readdir,rm}=await import('node:fs/promises');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {join}=await import('node:path');
 const directory=await mkdtemp('/tmp/adi-package-integration-');t.after(()=>rm(directory,{recursive:true,force:true}));
 const profile=join(directory,"profile with ' quote"),material=join(directory,'material');await mkdir(profile);await mkdir(material,{mode:0o700});
 const unrelated={hooks:[{type:'command',command:'user-validator'}]},hooks:Record<string,unknown[]>={};
 for(const name of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'])hooks[name]=[{hooks:[{type:'command',command:`"${profile}/trae-hook-send.sh"`}]}];hooks.Stop!.push(unrelated);await writeFile(join(profile,'hooks.json'),JSON.stringify({version:1,hooks}));
 const grant=(await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).json().data;
 const downloaded=await app.inject({url:grant.download_path,headers:{authorization:'Bearer '+grant.authorization}});assert.equal(downloaded.statusCode,200);assert.equal(createHash('sha256').update(downloaded.rawPayload).digest('hex'),grant.sha256);
 for(const [name,data] of Object.entries(unzipSync(downloaded.rawPayload)))await writeFile(join(material,name),data,{mode:0o600});
 const credentials=join(material,'adi-installation.json'),config=JSON.parse(await readFile(credentials,'utf8'));config.protocol_version=2;config.runtime_owner=createHash('sha256').update(JSON.stringify([root.user.user_id,'http://web.example.invalid'])).digest('hex');await writeFile(credentials,JSON.stringify(config),{mode:0o600});
 time=new Date(time.getTime()+30*60000);assert.equal((await app.inject({url:grant.download_path,headers:{authorization:'Bearer '+grant.authorization}})).statusCode,410);
 const run=promisify(execFile),env={...process.env,PATH:'/usr/bin:/bin'};
 for(let attempt=0;attempt<2;attempt++){
  const args=['--credentials',credentials,'--trae-dir',profile,'--replace-legacy'];
  const plan=await run('/bin/bash',[join(material,'install-hook.sh'),'plan',...args],{env,timeout:15000});assert.equal(JSON.parse(plan.stdout).action,'plan');
  const installed=await run('/bin/bash',[join(material,'install-hook.sh'),'install',...args],{env,timeout:15000});assert.equal(JSON.parse(installed.stdout).restart_trae_required,true);
  const current=JSON.parse(await readFile(join(profile,'hooks.json'),'utf8'));assert.ok(current.hooks.Stop.some((group:unknown)=>JSON.stringify(group)===JSON.stringify(unrelated)));
  const base=join(profile,'adi-native-collector'),manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8')),saved=JSON.parse(await readFile(join(base,manifest.release,'config.json'),'utf8'));assert.equal(saved.installation_id,grant.installation_id);
  assert.equal(Object.values(current.hooks as Record<string,{hooks:{command:string}[]}[]>).flatMap(groups=>groups.flatMap(group=>group.hooks)).filter(item=>item.command.includes('adi-native-collector')).length,6);
 }
 assert.ok((await readdir(material)).includes('adi-installation.json'));
});
