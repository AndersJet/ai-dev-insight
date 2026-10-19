import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createOrganizationService} from '@adi/domain';
import {pluginFixture} from '../plugin-fixture.js';

async function fixture(t:TestContext){
  const f=await pluginFixture(t),organization=createOrganizationService(f.db,f.identity);
  const accounts=new Map<string,{id:string;apiToken:string}>();
  const member=async(email:string,name:string)=>{
    const password='synthetic-linkage-password';
    const registered=await f.registration.register({email,password,display_name:name,department_id:f.department.id});
    const session=await f.identity.login(email,password);
    const response=await f.app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers:{cookie:`adi_session=${session.token}`,'x-csrf-token':session.csrfToken,origin:f.headers.origin},payload:{}});
    assert.equal(response.statusCode,200,response.body);
    accounts.set(email.toLowerCase(),{id:registered.user_id,apiToken:response.json().data.api_token});
    return registered.user_id;
  };
  const project=async(email:string,path:string,address='https://git.example.invalid/team/app.git')=>{
    const account=accounts.get(email.toLowerCase());assert.ok(account,'synthetic project owner must register and log in first');
    const registration={source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'macos',plugin_version:'0.3.0'};
    const bearer={authorization:`Bearer ${account.apiToken}`};
    const registered=await f.app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:registration});
    assert.equal(registered.statusCode,200,registered.body);
    const issued={...registered.json().data,nt_email:registered.json().data.email,token:account.apiToken};
    const observation={schema_version:2,collector_id:issued.collector_id,nt_email:email,source_config_id:registration.source_config_id,observation_id:randomUUID(),sequence:'1',platform:'macos',workspace_path:path,observed_at:'2024-01-01T00:00:00.000Z',state:'repository',reason:null,git_root:path,remotes:[{address}],plugin_version:'0.3.0'};
    const uploadHeaders={...bearer,'x-adi-source-secret':registration.source_secret};
    const saved=await f.app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:uploadHeaders,payload:observation});
    assert.equal(saved.statusCode,201,saved.body);
    return {issued,observation,uploadHeaders,registration};
  };
  const department=async(name:string)=>(await organization.createDepartment(f.root.token,name)).id;
  const list=async(query:Record<string,string>={})=>{const response=await f.app.inject({url:'/api/v1/plugin/projects?'+new URLSearchParams(query),headers:f.headers});assert.equal(response.statusCode,200,response.body);return response.json().data;};
  const history=async(source:Awaited<ReturnType<typeof project>>,query:Record<string,string>={})=>{
    const response=await f.app.inject({url:'/api/v1/plugin/observations?'+new URLSearchParams({nt_email:source.issued.nt_email,collector_id:source.issued.collector_id,workspace_path:source.observation.workspace_path,...query}),headers:f.headers});
    assert.equal(response.statusCode,200,response.body);return response.json().data;
  };
  return {...f,project,member,department,list,history};
}

test('plugin projects use the authenticated stable owner and normalized NT mailbox without creating users from declarations',async t=>{
  const f=await fixture(t),id=await f.member('case.nt@example.org','王晓明'),department=await f.department('研发一部');
  await f.db.query('DELETE FROM membership_periods WHERE user_id=$1',[id]);
  await f.db.query("INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,'2020-01-01')",[id,department]);
  const matched=await f.project('Case.NT@EXAMPLE.ORG','/synthetic/matched');
  const before=await f.history(matched),userCount=(await f.db.query<{total:number}>('SELECT count(*)::int AS total FROM users')).rows[0]!.total;
  const rejected=await f.app.inject({method:'POST',url:'/api/v1/plugin/sources',payload:{source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'macos',plugin_version:'0.3.0'}});
  assert.equal(rejected.statusCode,401,rejected.body);
  const retired=await f.app.inject({method:'POST',url:'/api/v1/plugin/registration',payload:{nt_email:'case.nt.other@example.org'}});
  assert.equal(retired.statusCode,410,retired.body);
  const page=await f.list();assert.equal(page.total,1);
  assert.deepEqual(page.items[0].linked_user,{user_id:id,name:'王晓明',email:'case.nt@example.org',account_status:'active',department_id:department,department_name:'研发一部'});
  assert.equal(page.items[0].nt_email,'case.nt@example.org');
  assert.deepEqual((await f.list({nt_email:'CASE.NT@EXAMPLE.ORG'})).items.map((p:{workspace_path:string})=>p.workspace_path),['/synthetic/matched']);
  assert.equal((await f.list({nt_email:'case.nt.other@example.org'})).total,0);
  const after=await f.history(matched);assert.equal(after.items[0].observation_id,matched.observation.observation_id);assert.equal(Object.hasOwn(after.items[0],'linked_user'),false);
  assert.deepEqual(after.items,before.items,'display association must not modify saved evidence');
  assert.equal((await f.db.query<{total:number}>('SELECT count(*)::int AS total FROM users')).rows[0]!.total,userCount,'anonymous declarations cannot create employees');
});

test('plugin projects show current department membership after a transfer and retain suspended or deleted employee history',async t=>{
  const f=await fixture(t),id=await f.member('transfer.nt@example.org','调岗成员'),unassigned=await f.member('unassigned.nt@example.org','未分配成员'),a=await f.department('原部门'),b=await f.department('当前部门');
  await f.db.query('DELETE FROM membership_periods WHERE user_id=ANY($1::uuid[])',[[id,unassigned]]);
  await f.db.query("INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,'2020-01-01','2025-01-01'),($1,$3,'2025-01-01',NULL)",[id,a,b]);
  const transfer=await f.project('transfer.nt@example.org','/synthetic/transfer');await f.project('unassigned.nt@example.org','/synthetic/unassigned');
  assert.equal((await f.list()).total,2);
  assert.equal((await f.list({department_id:a})).total,0,'observation date must not replace current display membership');
  const current=await f.list({department_id:b});assert.equal(current.total,1);assert.equal(current.items[0].linked_user.department_name,'当前部门');
  for(const [department,total] of [[a,0],[b,1]] as const)assert.equal((await f.history(transfer,{department_id:department})).total,total,'history uses the same current department display scope');
  const all=await f.list(),withoutDepartment=all.items.find((p:{nt_email:string})=>p.nt_email==='unassigned.nt@example.org');assert.equal(withoutDepartment.linked_user.user_id,unassigned);assert.equal(withoutDepartment.linked_user.department_id,null);assert.equal(withoutDepartment.linked_user.department_name,null);
  for(const status of ['suspended','deleted']){
    await f.db.query('UPDATE users SET status=$2 WHERE id=$1',[id,status]);
    const page=await f.list({department_id:b});assert.equal(page.total,1);assert.equal(page.items[0].linked_user.account_status,status);
    assert.equal((await f.app.inject({url:'/api/v1/plugin/me',headers:transfer.uploadHeaders})).statusCode,403,'historical visibility does not permit further collection');
  }
  await f.db.query('UPDATE departments SET deleted_at=now() WHERE id=$1',[b]);
  const deletedDepartment=(await f.list()).items.find((p:{nt_email:string})=>p.nt_email==='transfer.nt@example.org');assert.equal(deletedDepartment.linked_user.department_id,null);assert.equal(deletedDepartment.linked_user.department_name,null);
  for(const department of [b,randomUUID()]){const result=await f.app.inject({url:'/api/v1/plugin/projects?department_id='+department,headers:f.headers});assert.equal(result.statusCode,422,result.body);assert.equal(result.json().error.code,'invalid_scope');}
});

test('plugin project search covers project path, linked user name, NT mailbox and repository address with literal wildcard handling',async t=>{
  const f=await fixture(t);await f.member('search.nt@example.org','张搜索');await f.member('other.nt@example.org','另一个合成成员');
  await f.project('Search.NT@example.org','/synthetic/alpha_project','https://repository.example.invalid/team/target.git');await f.project('other.nt@example.org','/synthetic/alphaxproject','https://different.example.invalid/team/other.git');
  for(const search of ['张搜索','SEARCH.NT','alpha_project','repository.example.invalid','target.git']){const result=await f.list({search});assert.equal(result.total,1,search);assert.equal(result.items[0].workspace_path,'/synthetic/alpha_project');}
  assert.equal((await f.list({search:'%'})).total,0);assert.equal((await f.list({search:'张不存在'})).total,0);
  const invalid=await f.app.inject({url:'/api/v1/plugin/projects?department_id=invalid',headers:f.headers});assert.equal(invalid.statusCode,400,invalid.body);
});

test('NT display association never expands plugin read permissions or allows declared email identity substitution',async t=>{
  const f=await fixture(t),owner=await f.member('access.nt@example.org','访问成员');await f.member('different.nt@example.org','另一个账号');
  const access=await f.project('access.nt@example.org','/synthetic/access'),other=await f.project('different.nt@example.org','/synthetic/other');
  assert.equal((await f.app.inject({url:'/api/v1/plugin/projects'})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/v1/plugin/projects',headers:access.uploadHeaders})).statusCode,401);
  const substitution=await f.app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:access.uploadHeaders,payload:{...access.observation,nt_email:'different.nt@example.org',observation_id:randomUUID(),sequence:'2',state:'failed',reason:'git_error',git_root:null,remotes:[]}});
  assert.equal(substitution.statusCode,201,substitution.body);
  const own=(await f.list()).items.find((p:{workspace_path:string})=>p.workspace_path==='/synthetic/access');assert.equal(own.nt_email,'access.nt@example.org');assert.equal(own.linked_user.user_id,owner);
  assert.equal((await f.app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:other.uploadHeaders,payload:{...access.observation,observation_id:randomUUID(),sequence:'3'}})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:other.uploadHeaders,payload:access.registration})).statusCode,401);
  const forged=await f.app.inject({method:'POST',url:'/api/v1/plugin/observations',headers:access.uploadHeaders,payload:{...access.observation,observation_id:randomUUID(),sequence:'3',user_id:other.issued.user_id}});
  assert.equal(forged.statusCode,400,forged.body);
  await f.db.query('DELETE FROM role_grants WHERE user_id=$1',[f.root.user.user_id]);
  assert.equal((await f.app.inject({url:'/api/v1/plugin/projects',headers:f.headers})).statusCode,403);
});
