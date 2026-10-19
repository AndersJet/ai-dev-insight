import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {promisify} from 'node:util';import {execFile} from 'node:child_process';
import {testDatabase} from '../../../../packages/storage/test/helpers.js';import {createIdentityService,createRegistrationService,createInstallationService,createAdministrationService} from '@adi/domain';import {createApi} from '../../src/app.js';import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';import {loadClientDistribution} from '../../src/client-distribution.js';import {fork} from 'node:child_process';
test('the real extension authenticates through HTTP and PG before Git, keeps secrets out of its view, and stops on sign-out',{skip:!['darwin','win32'].includes(process.platform)},async t=>{
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']});const department=randomUUID();await db.query('INSERT INTO departments(id,name)VALUES($1,$2)',[department,'合成端到端部门']);
 const app=createApi(undefined,{identity,registration:createRegistrationService(db,identity),plugin:{db,signingKey:Buffer.alloc(32,7)},secureCookies:false});
 // Keep the login-triggered overview in flight while Git registration finishes.
 // A refresh request can join/skip that work; the view is the completion signal.
 app.addHook('preHandler',async request=>{if(request.url==='/api/v1/plugin/today')await new Promise(resolve=>setTimeout(resolve,1000));});
 await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());const address=app.server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const directory=await mkdtemp(join(tmpdir(),'adi-extension-api-'));t.after(()=>rm(directory,{recursive:true,force:true}));const workspace=join(directory,'workspace'),storage=join(directory,'storage'),home=join(directory,'home');await Promise.all([mkdir(workspace),mkdir(storage),mkdir(home)]);
 const exec=promisify(execFile);await exec('git',['init',workspace]);await exec('git',['-C',workspace,'remote','add','origin','https://git.example.invalid/team/synthetic.git']);const bundle=join(directory,'extension.cjs');
 await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/scripts/build.mjs',import.meta.url))],{env:{...process.env,ADI_PLUGIN_OUTPUT_DIR:directory,ADI_PLUGIN_WEB_URL:origin},timeout:15000,maxBuffer:8192});
 const result=await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/test/fixtures/extension-host.mjs',import.meta.url))],{timeout:20000,maxBuffer:8192,env:{...process.env,HOME:home,USERPROFILE:home,ADI_SYNTHETIC_ORIGIN:origin,ADI_SYNTHETIC_STORAGE:storage,ADI_SYNTHETIC_WORKSPACE:workspace,ADI_SYNTHETIC_DEPARTMENT:department,ADI_SYNTHETIC_BUNDLE:bundle}});
 assert.equal(JSON.parse(result.stdout).git_saved,true);assert.equal(JSON.parse(result.stdout).registered_in_plugin,true);
});

test('temporary account suspension stops the SDK host while retaining its token and automatically restores the same source without another login',{skip:!['darwin','win32'].includes(process.platform),timeout:45000},async t=>{
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']});
 const seed=await identity.bootstrap({email:'plugin.lifecycle.admin@example.org',name:'合成生命周期管理员'}),initial=await identity.login('plugin.lifecycle.admin@example.org',seed.temporaryPassword),admin=await identity.changePassword(initial.token,seed.temporaryPassword,'SyntheticOnlyLifecycleAdmin123!');
 const administration=createAdministrationService(db,identity),department=randomUUID();await db.query('INSERT INTO departments(id,name)VALUES($1,$2)',[department,'合成生命周期部门']);
 const app=createApi(undefined,{identity,registration:createRegistrationService(db,identity),plugin:{db,signingKey:Buffer.alloc(32,7)},secureCookies:false});let logins=0;
 app.addHook('onRequest',async request=>{if(request.url==='/api/v1/auth/login')logins++;});
 await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());const address=app.server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const directory=await mkdtemp(join(tmpdir(),'adi-extension-lifecycle-'));t.after(()=>rm(directory,{recursive:true,force:true}));const workspace=join(directory,'workspace'),storage=join(directory,'storage'),home=join(directory,'home');await Promise.all([mkdir(workspace),mkdir(storage),mkdir(home)]);
 const exec=promisify(execFile);await exec('git',['init',workspace]);await exec('git',['-C',workspace,'remote','add','origin','https://git.example.invalid/team/synthetic.git']);const bundle=join(directory,'extension.cjs');
 await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/scripts/build.mjs',import.meta.url))],{env:{...process.env,ADI_PLUGIN_OUTPUT_DIR:directory,ADI_PLUGIN_WEB_URL:origin},timeout:15000,maxBuffer:8192});
 const child=fork(fileURLToPath(new URL('../../../../trae-plugin/test/fixtures/extension-host.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,HOME:home,USERPROFILE:home,ADI_SYNTHETIC_ACCOUNT_RECOVERY:'1',ADI_SYNTHETIC_ORIGIN:origin,ADI_SYNTHETIC_STORAGE:storage,ADI_SYNTHETIC_WORKSPACE:workspace,ADI_SYNTHETIC_DEPARTMENT:department,ADI_SYNTHETIC_BUNDLE:bundle}});
 t.after(()=>{if(child.exitCode===null)child.kill();});let stdout='',stderr='',checkpointError:unknown,sourceId:string|undefined,userId:string|undefined;
 child.stdout!.on('data',value=>{stdout+=value;});child.stderr!.on('data',value=>{stderr+=value;});
 child.on('message',async message=>{
  if(!message||typeof message!=='object'||!('type'in message)||message.type!=='account-checkpoint'||!('id'in message)||typeof message.id!=='number'||!Number.isSafeInteger(message.id)||!('action'in message)||!['suspend','restore'].includes(String(message.action))||!('user_id'in message)||typeof message.user_id!=='string')return;
  const command={id:message.id,action:String(message.action),user_id:message.user_id};
  try{
   assert.ok(['suspend','restore'].includes(command.action));const account=await administration.getAccount(admin.token,command.user_id);assert.equal(account.email,'plugin.host.synthetic@example.org');
   if(command.action==='suspend'){
    userId=account.id;const page=await app.inject({url:'/api/v1/plugin/projects?nt_email=plugin.host.synthetic@example.org',headers:{cookie:`adi_session=${admin.token}`}});assert.equal(page.statusCode,200,page.body);assert.equal(page.json().data.total,1);sourceId=page.json().data.items[0].collector_id;
   }else{assert.equal(command.user_id,userId);await exec('git',['-C',workspace,'remote','set-url','origin','https://git.example.invalid/team/synthetic-restored.git']);}
   await administration.setStatus(admin.token,account.id,{version:account.version,status:command.action==='suspend'?'suspended':'active',reason:'合成SDK停用恢复验证'});
   child.send({type:'account-checkpoint-result',id:command.id,ok:true});
  }catch(error){checkpointError=error;child.send({type:'account-checkpoint-result',id:command.id,ok:false});}
 });
 const exitCode=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.ifError(checkpointError);assert.equal(exitCode,0,stderr);
 const report=JSON.parse(stdout);assert.equal(report.temporary_account_gate,true);assert.equal(report.original_binding_restored,true);assert.equal(report.no_password_reentry,true);assert.equal(logins,1,'account restoration must not send another password login');
 const page=await app.inject({url:'/api/v1/plugin/projects?nt_email=plugin.host.synthetic@example.org',headers:{cookie:`adi_session=${admin.token}`}});assert.equal(page.statusCode,200,page.body);assert.equal(page.json().data.total,1);assert.equal(page.json().data.items[0].collector_id,sourceId);assert.equal(page.json().data.items[0].linked_user.user_id,userId);assert.equal(page.json().data.items[0].confirmed.remotes[0].address,'https://git.example.invalid/team/synthetic-restored.git');
});

test('automatic global installation preserves third parties, repeated login is a no-op and modified Hooks are not overwritten',{skip:process.platform!=='darwin'},async t=>{
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']});const department=randomUUID();await db.query('INSERT INTO departments(id,name)VALUES($1,$2)',[department,'合成端到端部门']);
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const selected=socket.address();assert.ok(selected&&typeof selected==='object');const origin=`http://127.0.0.1:${selected.port}`;await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
 const app=createApi(undefined,{identity,registration:createRegistrationService(db,identity),installations:createInstallationService(db,identity,{encryptionKey:Buffer.alloc(32,7)}),clientDistribution:await loadClientDistribution({collectorUrl:origin+'/hooks'}),plugin:{db,signingKey:Buffer.alloc(32,7)},allowedOrigin:origin,secureCookies:false});await app.listen({host:'127.0.0.1',port:selected.port});t.after(()=>app.close());
 const directory=await mkdtemp(join(tmpdir(),'adi-extension-api-'));t.after(()=>rm(directory,{recursive:true,force:true}));const workspace=join(directory,'workspace'),storage=join(directory,'storage'),home=join(directory,'home');await Promise.all([mkdir(workspace),mkdir(storage),mkdir(home)]);
 const exec=promisify(execFile);await exec('git',['init',workspace]);await exec('git',['-C',workspace,'remote','add','origin','https://git.example.invalid/team/synthetic.git']);const bundle=join(directory,'extension.cjs');
 await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/scripts/build.mjs',import.meta.url))],{env:{...process.env,ADI_PLUGIN_OUTPUT_DIR:directory,ADI_PLUGIN_WEB_URL:origin},timeout:15000,maxBuffer:8192});
 const result=await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/test/fixtures/extension-host.mjs',import.meta.url))],{timeout:30000,maxBuffer:8192,env:{...process.env,HOME:home,USERPROFILE:home,ADI_SYNTHETIC_AUTO_HOOK:'1',ADI_SYNTHETIC_ORIGIN:origin,ADI_SYNTHETIC_STORAGE:storage,ADI_SYNTHETIC_WORKSPACE:workspace,ADI_SYNTHETIC_DEPARTMENT:department,ADI_SYNTHETIC_BUNDLE:bundle}});
 assert.equal(JSON.parse(result.stdout).git_saved,true);assert.equal(JSON.parse(result.stdout).registered_in_plugin,true);
});

test('an old HTTP rejection delayed by cache persistence cannot delete the new target binding or stop its collection',{skip:!['darwin','win32'].includes(process.platform),timeout:45000},async t=>{
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']}),department=randomUUID();await db.query('INSERT INTO departments(id,name)VALUES($1,$2)',[department,'合成取消边界部门']);
 const options={identity,registration:createRegistrationService(db,identity),plugin:{db,signingKey:Buffer.alloc(32,7)},secureCookies:false};
 const oldApp=createApi(undefined,options),newApp=createApi(undefined,options);let rejectOldOverview=false,oldSaved=0,newSaved=0;
 oldApp.addHook('onRequest',async(request,reply)=>{if(request.url==='/api/v1/plugin/today'&&rejectOldOverview){rejectOldOverview=false;return reply.code(401).send({error:{code:'plugin_unauthorized',message:'合成旧请求拒绝',request_id:request.id}});}});
 oldApp.addHook('onResponse',async(request,reply)=>{if(request.method==='POST'&&request.url==='/api/v1/plugin/observations'&&[200,201].includes(reply.statusCode))oldSaved++;});
 newApp.addHook('onResponse',async(request,reply)=>{if(request.method==='POST'&&request.url==='/api/v1/plugin/observations'&&[200,201].includes(reply.statusCode))newSaved++;});
 await oldApp.listen({host:'127.0.0.1',port:0});await newApp.listen({host:'127.0.0.1',port:0});t.after(async()=>{await newApp.close();await oldApp.close();});
 const oldAddress=oldApp.server.address(),newAddress=newApp.server.address();assert.ok(oldAddress&&typeof oldAddress==='object');assert.ok(newAddress&&typeof newAddress==='object');const origin=`http://127.0.0.1:${oldAddress.port}`,nextOrigin=`http://127.0.0.1:${newAddress.port}`;
 const directory=await mkdtemp(join(tmpdir(),'adi-extension-cancel-'));t.after(()=>rm(directory,{recursive:true,force:true}));const workspace=join(directory,'workspace'),storage=join(directory,'storage'),home=join(directory,'home');await Promise.all([mkdir(workspace),mkdir(storage),mkdir(home)]);
 const exec=promisify(execFile);await exec('git',['init',workspace]);await exec('git',['-C',workspace,'remote','add','origin','https://git.example.invalid/team/synthetic.git']);const bundle=join(directory,'extension.cjs');
 await exec(process.execPath,[fileURLToPath(new URL('../../../../trae-plugin/scripts/build.mjs',import.meta.url))],{env:{...process.env,ADI_PLUGIN_OUTPUT_DIR:directory,ADI_PLUGIN_WEB_URL:origin},timeout:15000,maxBuffer:8192});
 const child=fork(fileURLToPath(new URL('../../../../trae-plugin/test/fixtures/extension-host.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,HOME:home,USERPROFILE:home,ADI_SYNTHETIC_LATE_REJECTION:'1',ADI_SYNTHETIC_ORIGIN:origin,ADI_SYNTHETIC_NEXT_ORIGIN:nextOrigin,ADI_SYNTHETIC_STORAGE:storage,ADI_SYNTHETIC_WORKSPACE:workspace,ADI_SYNTHETIC_DEPARTMENT:department,ADI_SYNTHETIC_BUNDLE:bundle}});
 t.after(()=>{if(child.exitCode===null)child.kill();});let stdout='',stderr='',checkpointError:unknown;
 child.stdout!.on('data',value=>{stdout+=value;});child.stderr!.on('data',value=>{stderr+=value;});
 child.on('message',async message=>{
  if(!message||typeof message!=='object'||!('type'in message)||message.type!=='account-checkpoint'||!('id'in message)||typeof message.id!=='number'||!('action'in message))return;
  try{
   if(message.action==='arm-old-rejection'){assert.equal(oldSaved,1);rejectOldOverview=true;await exec('git',['-C',workspace,'remote','set-url','origin','https://git.example.invalid/team/synthetic-new-target.git']);}
   else if(message.action==='switched-target'){assert.equal(oldSaved,1,'old target must not receive new observations');assert.ok(newSaved>=1,'the new target must receive a real authenticated observation');}
   else throw new Error('invalid_synthetic_checkpoint');
   child.send({type:'account-checkpoint-result',id:message.id,ok:true});
  }catch(error){checkpointError=error;child.send({type:'account-checkpoint-result',id:message.id,ok:false});}
 });
 const exitCode=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.ifError(checkpointError);assert.equal(exitCode,0,stderr);
 const report=JSON.parse(stdout);assert.equal(report.old_rejection_ignored,true);assert.equal(report.new_target_binding_preserved,true);assert.equal(report.new_target_saved,true);assert.equal(oldSaved,1);assert.ok(newSaved>=1);
});
