import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createIdentityService} from '../../src/identity.js';
import {createRepositoryAllowlistService} from '../../src/project-repositories.js';
import {createOrganizationService} from '../../src/organization.js';

async function fixture(t:TestContext){
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const initial=await identity.bootstrap({email:'rules@example.invalid',name:'规则管理员'});const login=await identity.login('rules@example.invalid',initial.temporaryPassword);
  const root=await identity.changePassword(login.token,initial.temporaryPassword,'synthetic-rules-password');
  return {db,identity,root,service:createRepositoryAllowlistService(db,identity)};
}

test('superadmin adds canonical host and repository rules and reads them without embedded credentials',async t=>{
  const db=await testDatabase(t);await db.migrate();
  const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const initial=await identity.bootstrap({email:'allowlist@example.invalid',name:'白名单管理员'});
  const login=await identity.login('allowlist@example.invalid',initial.temporaryPassword);
  const root=await identity.changePassword(login.token,initial.temporaryPassword,'synthetic-allowlist-password');
  const service=createRepositoryAllowlistService(db,identity);
  const host=await service.create(root.token,{kind:'host',value:'GIT.EXAMPLE.COM'});
  const repository=await service.create(root.token,{kind:'repository',value:'https://user:synthetic-secret@git.example.com/team/App.git?token=synthetic-secret'});
  assert.equal(host.value,'git.example.com');assert.equal(repository.value,'https://git.example.com/team/App.git');
  const rules=await service.list(root.token);
  assert.equal(rules.items.length,2);assert.equal(rules.items.find(rule=>rule.id===host.id)?.version,1);
  assert.equal(JSON.stringify(rules).includes('synthetic-secret'),false);
});

test('allowlist edits and removals reject stale versions and duplicate or malformed rules',async t=>{
  const {root,service}=await fixture(t);
  const first=await service.create(root.token,{kind:'host',value:'git.example.com'});
  await assert.rejects(service.create(root.token,{kind:'host',value:'GIT.EXAMPLE.COM'}),{code:'repository_rule_exists'});
  for(const value of ['*.example.com','git.example.com:443','10.999.1.2'])await assert.rejects(service.create(root.token,{kind:'host',value}),{code:'invalid_repository_address'});
  const edited=await service.update(root.token,first.id,{kind:'repository',value:'ssh://user:synthetic-secret@git.example.com:2222/team/app.git',version:first.version});
  assert.equal(edited.value,'ssh://git.example.com:2222/team/app.git');assert.equal(edited.version,2);
  await assert.rejects(service.update(root.token,first.id,{kind:'host',value:'other.example.com',version:1}),{code:'version_conflict'});
  await assert.rejects(service.remove(root.token,first.id,1),{code:'version_conflict'});
  await service.remove(root.token,first.id,edited.version);
  assert.deepEqual((await service.list(root.token)).items,[]);
});

test('an ordinary employee cannot read or maintain the global repository allowlist',async t=>{
  const {db,identity,root,service}=await fixture(t);const org=createOrganizationService(db,identity);
  const department=await org.createDepartment(root.token,'合成研发部门');
  const member=await org.addMember(root.token,department.id,{email:'rules-employee@example.invalid',display_name:'员工'});
  const temporary=await identity.resetPassword(root.token,member.user_id,member.version);const login=await identity.login(member.email,temporary.temporaryPassword);
  const employee=await identity.changePassword(login.token,temporary.temporaryPassword,'synthetic-employee-password');
  const rule=await service.create(root.token,{kind:'host',value:'git.example.com'});
  await assert.rejects(service.list(employee.token),{code:'forbidden'});
  await assert.rejects(service.create(employee.token,{kind:'host',value:'other.example.com'}),{code:'forbidden'});
  await assert.rejects(service.update(employee.token,rule.id,{kind:'host',value:'other.example.com',version:1}),{code:'forbidden'});
  await assert.rejects(service.remove(employee.token,rule.id,1),{code:'forbidden'});
  assert.equal((await service.list(root.token)).items[0]?.value,'git.example.com');
});

test('allowlist pagination is scoped and stale cursors cannot conceal intervening rule changes',async t=>{
  const {root,service}=await fixture(t);
  for(const value of ['git-a.example.com','git-b.example.com','git-c.example.com'])await service.create(root.token,{kind:'host',value});
  const first=await service.list(root.token,{limit:1});
  assert.equal(first.items.length,1);assert.equal(first.total,3);assert.ok(first.next_cursor);
  const second=await service.list(root.token,{limit:1,cursor:first.next_cursor});
  assert.equal(second.items.length,1);assert.notEqual(second.items[0]!.id,first.items[0]!.id);
  await assert.rejects(service.list(root.token,{limit:1,search:'git-a',cursor:first.next_cursor}),{code:'invalid_cursor'});
  await service.remove(root.token,first.items[0]!.id,first.items[0]!.version);
  await assert.rejects(service.list(root.token,{limit:1,cursor:first.next_cursor}),{code:'invalid_cursor'});
  await service.create(root.token,{kind:'host',value:'git-search.example.com'});
  const found=await service.list(root.token,{search:'git-search.example.com'});
  assert.deepEqual(found.items.map(rule=>rule.value),['git-search.example.com']);
});
