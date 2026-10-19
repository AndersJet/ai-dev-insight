import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../../packages/storage/test/helpers.js';
import {createIdentityService,createOrganizationService,createRegistrationService} from '@adi/domain';
import {createApi} from '../../src/app.js';

test('community signup and login accept other domains and authenticated plugin reports retain their owner',async t=>{
  const db=await testDatabase(t);await db.migrate();
  const identity=createIdentityService(db),seed=await identity.bootstrap({email:'admin@example.org',name:'社区管理员'});
  const initial=await identity.login('admin@example.org',seed.temporaryPassword);
  const admin=await identity.changePassword(initial.token,seed.temporaryPassword,'community-admin-password');
  const organization=createOrganizationService(db,identity),department=await organization.createDepartment(admin.token,'社区团队');
  const app=createApi(undefined,{identity,registration:createRegistrationService(db,identity),plugin:{db,signingKey:Buffer.alloc(32,7)},secureCookies:false});t.after(()=>app.close());
  const input={email:'member+demo@another.org',password:'community-member-password',display_name:'社区成员',department_id:department.id};
  const signup=await app.inject({method:'POST',url:'/api/v1/registration/complete',payload:input});assert.equal(signup.statusCode,201,signup.body);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:input.email,password:input.password}});assert.equal(login.statusCode,200,login.body);
  const cookies=String(login.headers['set-cookie']).match(/adi_session=([^;]+)/)?.[1];assert.ok(cookies);
  const session=await identity.resolve(cookies);assert.ok(session);assert.deepEqual(session.user.roles,['employee']);
  const csrf=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie'].join(';'):String(login.headers['set-cookie'])).match(/adi_csrf=([^;]+)/)?.[1];assert.ok(csrf);
  const credential=await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers:{cookie:`adi_session=${cookies}`,'x-csrf-token':csrf},payload:{}});assert.equal(credential.statusCode,200,credential.body);
  const bearer={authorization:`Bearer ${credential.json().data.api_token}`},source={source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'macos',plugin_version:'1.0.6'};
  const registered=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:source});assert.equal(registered.statusCode,200,registered.body);
  const event={schema_version:2,collector_id:registered.json().data.collector_id,source_config_id:source.source_config_id,nt_email:input.email,observation_id:randomUUID(),sequence:'1',platform:'macos',workspace_path:'/synthetic/community',observed_at:new Date().toISOString(),state:'not_git',reason:null,git_root:null,remotes:[],plugin_version:'1.0.6'};
  const saved=await app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':source.source_secret},payload:event});assert.equal(saved.statusCode,201,saved.body);
  const me=await app.inject({url:'/api/v1/plugin/me',headers:bearer});assert.equal(me.json().data.email,input.email);
  assert.equal((await app.inject({url:'/api/v1/admin/sessions',headers:bearer})).statusCode,401);
  const restricted=createApi(undefined,{identity:createIdentityService(db,{emailDomains:['example.org']}),plugin:{db,signingKey:Buffer.alloc(32,7)},secureCookies:false});t.after(()=>restricted.close());
  assert.equal((await restricted.inject({url:'/api/v1/plugin/me',headers:bearer})).statusCode,403);
  assert.equal((await restricted.inject({method:'POST',url:'/api/v1/plugin/observations',headers:{...bearer,'x-adi-source-secret':source.source_secret},payload:event})).statusCode,403);
});

test('configured domain allowlists reject signup and login and retire sessions outside the new policy',async t=>{
  const db=await testDatabase(t);await db.migrate();
  const open=createIdentityService(db),seed=await open.bootstrap({email:'admin@example.org',name:'社区管理员'});
  const first=await open.login('admin@example.org',seed.temporaryPassword),admin=await open.changePassword(first.token,seed.temporaryPassword,'community-admin-password');
  const organization=createOrganizationService(db,open),department=await organization.createDepartment(admin.token,'社区部门');
  const registered=createRegistrationService(db,open),input={email:'member@outside.org',password:'community-member-password',display_name:'合成成员',department_id:department.id};
  await registered.register(input);const prior=await open.login(input.email,input.password);
  const identity=createIdentityService(db,{emailDomains:[' EXAMPLE.ORG ']}),app=createApi(undefined,{identity,registration:createRegistrationService(db,identity),secureCookies:false});t.after(()=>app.close());
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/complete',payload:{...input,email:'new@outside.org'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:input.email,password:input.password}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/v1/me',headers:{cookie:`adi_session=${prior.token}`}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'admin@example.org',password:'community-admin-password'}})).statusCode,200);
  assert.ok(await createIdentityService(db,{emailDomains:[]}).resolve(prior.token));
  assert.ok(await createIdentityService(db,{emailDomains:['']}).resolve(prior.token));
  for(const emailDomains of [['bad domain'],['example.org',''],['@example.org'],['-bad.org']])assert.throws(()=>createIdentityService(db,{emailDomains}),/Invalid email domain configuration/);
});
