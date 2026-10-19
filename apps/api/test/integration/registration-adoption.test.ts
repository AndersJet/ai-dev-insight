import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { testDatabase } from '../../../../packages/storage/test/helpers.js';
import { createIdentityService } from '../../../../packages/domain/src/identity.js';
import { createOrganizationService } from '../../../../packages/domain/src/organization.js';
import { createRegistrationService } from '../../../../packages/domain/src/registration.js';
import { createAdoptionService } from '../../../../packages/domain/src/adoption.js';
import { createInstallationService } from '../../../../packages/domain/src/installations.js';
import { createAdministrationService } from '../../../../packages/domain/src/administration.js';
import { createApi } from '../../src/app.js';

test('authenticated pre-provisioned activation and first committed Hook drive cumulative adoption without manual exclusion', async t => {
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db);
  const seed=await identity.bootstrap({email:'synthetic-root@example.org',name:'合成超管'});
  const initial=await identity.login('synthetic-root@example.org',seed.temporaryPassword);
  const root=await identity.changePassword(initial.token,seed.temporaryPassword,'synthetic-root-password');
  const organization=createOrganizationService(db,identity),administration=createAdministrationService(db,identity),installations=createInstallationService(db,identity,{encryptionKey:Buffer.alloc(32,4)}),adoption=createAdoptionService(db,identity);
  const dept=await organization.createDepartment(root.token,'合成注册部门');const otherDept=await organization.createDepartment(root.token,'另一个合成部门');
  const registration=createRegistrationService(db,identity);
  const app=createApi(undefined,{identity,organization,administration,installations,adoption,registration,secureCookies:false,allowedOrigin:'http://synthetic.invalid'});t.after(()=>app.close());
  assert.equal((await app.inject({url:'/api/v1/registration/setup'})).json().data.departments.length,2);
  const prebuilt=await organization.addMember(root.token,dept.id,{email:'claim@example.org',display_name:'原姓名'});
  assert.equal((await adoption.snapshot(root.token,{scope:'organization'})).registered,0);
  assert.equal((await installations.statusForUser(root.token,prebuilt.user_id)).installation,null);
  const email='claim@example.org';
  const input={email,password:'synthetic-person-password',display_name:'申请姓名',department_id:otherDept.id};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/complete',payload:input})).statusCode,409,'unissued identities cannot be claimed anonymously');
  const temporary=await identity.resetPassword(root.token,prebuilt.user_id,prebuilt.version);
  const temporarySession=await identity.login(email,temporary.temporaryPassword);
  await assert.rejects(registration.activate(temporarySession.token,{}),{code:'password_change_required'});
  const employee=await identity.changePassword(temporarySession.token,temporary.temporaryPassword,input.password);
  const headers={cookie:`adi_session=${employee.token}; adi_csrf=${employee.csrfToken}`,'x-csrf-token':employee.csrfToken};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/activate',payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/activate',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/activate',headers:{...headers,origin:'http://untrusted.invalid'},payload:{}})).statusCode,403);
  const completion=await app.inject({method:'POST',url:'/api/v1/registration/activate',headers,payload:{department_id:otherDept.id}});
  assert.equal(completion.statusCode,200,completion.body);assert.equal(completion.json().data.user_id,prebuilt.user_id);
  assert.equal((await db.query('SELECT department_id FROM membership_periods WHERE user_id=$1 AND valid_to IS NULL',[prebuilt.user_id])).rows[0]!.department_id,dept.id);
  assert.equal((await db.query('SELECT display_name FROM users WHERE id=$1',[prebuilt.user_id])).rows[0]!.display_name,'原姓名');
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/activate',headers,payload:{}})).statusCode,409);
  assert.equal((await identity.resolve(employee.token))!.user.registered,true);assert.deepEqual(employee.user.roles,['employee']);
  await assert.rejects(adoption.snapshot(employee.token,{scope:'organization'}),{code:'forbidden'});
  const before=await adoption.snapshot(root.token,{scope:'organization'});assert.equal(before.registered,1);assert.equal(before.pending,1);assert.equal(before.adoption_rate,0);
  const installed=await installations.credential(employee.token);const at=new Date();await db.ensurePartitions(new Date(at.getTime()-86400000),new Date(at.getTime()+86400000));
  const envelope={schema_version:2 as const,installation_id:installed.installation.id,client_event_id:randomUUID(),occurred_at:at.toISOString(),event_type:'SessionStart',source_session_id:'registered-adoption',payload:{hook_event_name:'SessionStart',session_id:'registered-adoption'}};
  const options={admissionEpoch:1,receivedAt:at,tokenHash:createHash('sha256').update(installed.token).digest('hex')};
  assert.equal((await db.ingest(envelope,options)).outcome,'committed');const first=(await db.query('SELECT adopted_at FROM users WHERE id=$1',[prebuilt.user_id])).rows[0]!.adopted_at;
  assert.equal((await db.ingest(envelope,{...options,receivedAt:new Date(at.getTime()+1000)})).outcome,'duplicate');assert.deepEqual((await db.query('SELECT adopted_at FROM users WHERE id=$1',[prebuilt.user_id])).rows[0]!.adopted_at,first);
  assert.equal((await adoption.snapshot(root.token,{scope:'organization'})).adoption_rate,1);
  const account=await administration.getAccount(root.token,prebuilt.user_id);await administration.setStatus(root.token,prebuilt.user_id,{version:account.version,status:'suspended',reason:'合成停用原因'});
  assert.equal(await identity.resolve(employee.token),null);assert.equal((await adoption.snapshot(root.token,{scope:'organization'})).registered,1);assert.equal((await adoption.snapshot(root.token,{scope:'organization'})).suspended,1);
  assert.deepEqual(await db.ingest({...envelope,client_event_id:randomUUID()},options),{outcome:'rejected',reason:'account_disabled'});
  const stopped=await administration.getAccount(root.token,prebuilt.user_id);await administration.setStatus(root.token,prebuilt.user_id,{version:stopped.version,status:'deleted',reason:'合成删除原因'});
  const deleted=await adoption.snapshot(root.token,{scope:'organization'});assert.equal(deleted.registered,1);assert.equal(deleted.adopted,1);assert.equal(deleted.deleted,1);
  const filtered=await organization.listMembers(root.token,dept.id,{status:'deleted'});assert.equal(filtered.total,1);
  const listed=filtered.items[0] as typeof filtered.items[0]&{status_reason:string};assert.equal(listed.status_reason,'合成删除原因');
  const rootHeaders={cookie:`adi_session=${root.token}; adi_csrf=${root.csrfToken}`,'x-csrf-token':root.csrfToken};
  const removed=await app.inject({method:'PATCH',url:`/api/v1/departments/${dept.id}/members/${prebuilt.user_id}`,headers:rootHeaders,payload:{version:1,eligible:false}});assert.equal(removed.statusCode,400,'manual statistical exclusion removed from contract');
});

async function registrationFixture(t: import('node:test').TestContext) {
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']});
  const seed=await identity.bootstrap({email:'root-test@example.org',name:'测试管理员'});
  const initial=await identity.login('root-test@example.org',seed.temporaryPassword);
  const root=await identity.changePassword(initial.token,seed.temporaryPassword,'strong-root-test-password');
  const org=createOrganizationService(db,identity),admin=createAdministrationService(db,identity),registration=createRegistrationService(db,identity);
  const dept=await org.createDepartment(root.token,'注册部门');
  const app=createApi(undefined,{identity,registration,secureCookies:false,allowedOrigin:'http://synthetic.invalid'});t.after(()=>app.close());
  const input={email:'new-person@example.org',password:'safe-test-person-password',display_name:'合成员工',department_id:dept.id};
  return {db,identity,root,org,admin,registration,dept,app,input};
}

test('new employees register without mail, races reserve one identity, and invalid input never activates',async t=>{
  const {db,identity,app,input}=await registrationFixture(t);
  const setup=(await app.inject({url:'/api/v1/registration/setup'})).json().data;
  assert.deepEqual(Object.keys(setup),['departments']);
  const submit=(payload:unknown)=>app.inject({method:'POST',url:'/api/v1/registration/complete',payload:payload as Record<string,unknown>});
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/complete',headers:{origin:'http://untrusted.invalid'},payload:input})).statusCode,403);
  assert.equal((await submit({...input,email:'outside@other.invalid'})).statusCode,400);
  assert.equal((await submit({...input,password:'short'})).statusCode,400);
  assert.equal((await submit({...input,roles:['super']})).statusCode,400);
  assert.equal((await submit({...input,code:'123456'})).statusCode,400,'retired OTP field is not accepted');
  assert.equal((await submit({...input,department_id:randomUUID()})).statusCode,422);
  assert.equal((await db.query('SELECT 1 FROM users WHERE email_key=$1',[input.email])).rowCount,0,'failed department selection rolls back the identity');
  const results=await Promise.all([submit(input),submit({...input,email:'NEW-PERSON@EXAMPLE.ORG'})]);
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[201,409]);
  const employee=await identity.login(input.email,input.password);
  assert.equal(employee.user.registered,true);assert.equal(employee.user.must_change_password,false);assert.deepEqual(employee.user.roles,['employee']);
  assert.equal((await submit({...input,password:'different-password'})).statusCode,409);
  assert.equal((await db.query('SELECT 1 FROM users WHERE email_key=$1',[input.email])).rowCount,1);
  assert.equal((await db.query("SELECT to_regclass('registration_challenges') AS name")).rows[0]!.name,null);
  assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='email_verified_at'",[db.schema])).rowCount,0);
  const headers={cookie:`adi_session=${employee.token}; adi_csrf=${employee.csrfToken}`,'x-csrf-token':employee.csrfToken};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/registration/code',headers,payload:{email:input.email}})).statusCode,404);
  const bucket=createHash('sha256').update('limited-source').digest('hex');
  await db.query('INSERT INTO registration_rate_limits(bucket,window_start,attempts) VALUES($1,now(),100)',[bucket]);
  const limited=await app.inject({method:'POST',url:'/api/v1/registration/complete',remoteAddress:'limited-source',payload:{...input,email:'limited@example.org'}});
  assert.equal(limited.statusCode,429,limited.body);
});

test('all existing credential states and preassigned roles require login; suspension and deletion cannot be bypassed',async t=>{
  const {db,identity,root,org,admin,registration,dept,input}=await registrationFixture(t);
  for(const state of ['unissued','temporary','expired','permanent','suspended','deleted'] as const){
    const email=`${state}@example.org`,member=await org.addMember(root.token,dept.id,{email,display_name:state});
    let version=member.version;
    const access=await admin.setAccess(root.token,member.user_id,{version,global_roles:['anc_admin']});version=access.version;
    let token='';
    if(state!=='unissued'){
      const temporary=await identity.resetPassword(root.token,member.user_id,version);version=temporary.version;
      const session=await identity.login(email,temporary.temporaryPassword);token=session.token;
      if(state==='expired')await db.query("UPDATE credentials SET temporary_expires_at=now()-interval '1 minute' WHERE user_id=$1",[member.user_id]);
      if(['permanent','suspended','deleted'].includes(state)){
        const session=await identity.changePassword(token,temporary.temporaryPassword,input.password);token=session.token;
        version=(await admin.getAccount(root.token,member.user_id)).version;
      }
      if(state==='suspended'||state==='deleted')await admin.setStatus(root.token,member.user_id,{version,status:state,reason:'合成测试'});
    }
    const before=(await db.query('SELECT password_hash FROM credentials WHERE user_id=$1',[member.user_id])).rows;
    await assert.rejects(registration.register({...input,email}),{code:'registration_not_allowed'});
    assert.deepEqual((await db.query('SELECT password_hash FROM credentials WHERE user_id=$1',[member.user_id])).rows,before);
    if(state==='permanent'){
      await registration.activate(token,{});
      const current=(await identity.resolve(token))!.user;assert.equal(current.registered,true);assert.ok(current.roles.includes('anc_admin'));
    }else if(token){
      await assert.rejects(registration.activate(token,{}),{code:state==='temporary'?'password_change_required':'unauthenticated'});
      assert.equal((await db.query('SELECT registered_at FROM users WHERE id=$1',[member.user_id])).rows[0]!.registered_at,null);
    }
  }
  const configuration={email:'configured-registration@example.org',name:'配置身份',password:'configuration-password'};
  const configured=await identity.syncConfigurationAdministrator(configuration);
  const hash=(await db.query('SELECT password_hash FROM credentials WHERE user_id=$1',[configured.userId])).rows[0]!.password_hash;
  await assert.rejects(registration.register({...input,email:configuration.email,password:configuration.password}),{code:'registration_not_allowed'});
  const owner=await identity.login(configuration.email,configuration.password);
  await assert.rejects(registration.activate(owner.token,{}),{code:'department_unavailable'});
  assert.equal((await db.query('SELECT registered_at FROM users WHERE id=$1',[configured.userId])).rows[0]!.registered_at,null);
  await registration.activate(owner.token,{department_id:dept.id});
  assert.equal((await db.query('SELECT password_hash FROM credentials WHERE user_id=$1',[configured.userId])).rows[0]!.password_hash,hash);
  assert.ok((await identity.resolve(owner.token))!.user.roles.includes('super'));
});
