import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from '../../../../packages/storage/test/helpers.js';
import {createIdentityService} from '../../../../packages/domain/src/identity.js';
import {createRepositoryAllowlistService} from '../../../../packages/domain/src/project-repositories.js';
import {createApi} from '../../src/app.js';
import {createOrganizationService} from '../../../../packages/domain/src/organization.js';

test('repository allowlist HTTP routes require CSRF and return only canonical rule values',async t=>{
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const initial=await identity.bootstrap({email:'rules-http@example.invalid',name:'白名单HTTP'});const first=await identity.login('rules-http@example.invalid',initial.temporaryPassword);
  const root=await identity.changePassword(first.token,initial.temporaryPassword,'synthetic-http-rules-password');
  const app=createApi(undefined,{identity,repositoryAllowlist:createRepositoryAllowlistService(db,identity)});t.after(()=>app.close());
  const headers={cookie:`adi_session=${root.token}`,'x-csrf-token':root.csrfToken};
  const payload={kind:'repository',value:'https://user:synthetic-http-secret@git.example.com/team/App.git?token=synthetic-http-secret'};
  const added=await app.inject({method:'POST',url:'/api/v1/repository-allowlist',headers,payload});
  assert.equal(added.statusCode,201);assert.equal(added.json().data.value,'https://git.example.com/team/App.git');
  assert.equal(added.body.includes('synthetic-http-secret'),false);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/repository-allowlist',headers:{cookie:headers.cookie},payload:{kind:'host',value:'other.example.com'}})).statusCode,403);
  const listed=await app.inject({url:'/api/v1/repository-allowlist',headers});assert.equal(listed.statusCode,200);assert.equal(listed.json().data.total,1);
  const item=added.json().data;
  const edited=await app.inject({method:'PATCH',url:`/api/v1/repository-allowlist/${item.id}`,headers,payload:{kind:'host',value:'OTHER.EXAMPLE.COM',version:item.version}});
  assert.equal(edited.statusCode,200);assert.equal(edited.json().data.value,'other.example.com');
  assert.equal((await app.inject({method:'DELETE',url:`/api/v1/repository-allowlist/${item.id}`,headers,payload:{version:item.version}})).statusCode,409);
  assert.equal((await app.inject({method:'DELETE',url:`/api/v1/repository-allowlist/${item.id}`,headers,payload:{version:edited.json().data.version}})).statusCode,204);
});

test('employee, department admin and ANC admin cannot bypass allowlist permissions with direct HTTP requests',async t=>{
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const initial=await identity.bootstrap({email:'rules-roles@example.invalid',name:'权限测试'});const first=await identity.login('rules-roles@example.invalid',initial.temporaryPassword);
  const root=await identity.changePassword(first.token,initial.temporaryPassword,'synthetic-rules-roles-password');
  const service=createRepositoryAllowlistService(db,identity),org=createOrganizationService(db,identity);
  const department=await org.createDepartment(root.token,'白名单权限测试部门');
  const rule=await service.create(root.token,{kind:'host',value:'git.example.com'});
  const app=createApi(undefined,{identity,repositoryAllowlist:service});t.after(()=>app.close());
  for(const role of ['employee','department_admin','anc_admin']){
    const member=await org.addMember(root.token,department.id,{email:`rule-${role}@example.invalid`,display_name:role});
    if(role!=='employee')await db.query('INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,$2,$3,now())',[member.user_id,role,role==='department_admin'?department.id:null]);
    const temporary=await identity.resetPassword(root.token,member.user_id,member.version);const login=await identity.login(member.email,temporary.temporaryPassword);
    const account=await identity.changePassword(login.token,temporary.temporaryPassword,'synthetic-role-password');
    const headers={cookie:`adi_session=${account.token}`,'x-csrf-token':account.csrfToken};
    for(const request of [
      {method:'GET' as const,url:'/api/v1/repository-allowlist'},
      {method:'POST' as const,url:'/api/v1/repository-allowlist',payload:{kind:'host',value:'other.example.com'}},
      {method:'PATCH' as const,url:`/api/v1/repository-allowlist/${rule.id}`,payload:{kind:'host',value:'other.example.com',version:1}},
      {method:'DELETE' as const,url:`/api/v1/repository-allowlist/${rule.id}`,payload:{version:1}},
    ]){const result=await app.inject({...request,headers});assert.equal(result.statusCode,403,role);assert.equal(result.json().error.code,'forbidden');}
  }
});
