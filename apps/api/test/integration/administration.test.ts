import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from '../../../../packages/storage/test/helpers.js';
import { createIdentityService } from '../../../../packages/domain/src/identity.js';
import { createAdministrationService } from '../../../../packages/domain/src/administration.js';
import { createOrganizationService } from '../../../../packages/domain/src/organization.js';
import { createApi } from '../../src/app.js';
test('global account APIs expose no credential hashes and enforce superadmin-only mutations', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'api-admin@example.invalid', name: 'API超管' }); const initial = await identity.login('api-admin@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(initial.token, seed.temporaryPassword, 'api-admin-password');
  const organization = createOrganizationService(db, identity); const department = await organization.createDepartment(root.token, '账号部门'); const person = await organization.addMember(root.token, department.id, { email: 'api-account@example.invalid', display_name: '账号员工' });
  const administration = createAdministrationService(db, identity); const app = createApi(undefined, { identity, organization, administration }); t.after(() => app.close());
  const headers = { cookie: `adi_session=${root.token}`, 'x-csrf-token': root.csrfToken };
  const info = await app.inject({ url: `/api/v1/admin/users/${person.user_id}`, headers }); assert.equal(info.statusCode, 200); assert.equal(info.json().data.credential_state, 'unissued'); assert.ok(!info.body.includes('password_hash'));
  const grant = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${person.user_id}/global-roles`, headers, payload: { global_roles: ['anc_admin'], department_ids: [], version: 1 } }); assert.equal(grant.statusCode, 200);
  const issued = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${person.user_id}/reset-password`, headers, payload: { version: 2, reason: 'initial_issue' } }); assert.equal(issued.statusCode, 200);
  const temporary = await identity.login(person.email, issued.json().data.temporary_password); const anc = await identity.changePassword(temporary.token, issued.json().data.temporary_password, 'api-account-password');
  assert.equal((await app.inject({ url: '/api/v1/admin/users', headers: { cookie: `adi_session=${anc.token}` } })).statusCode, 403);
  const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${person.user_id}/status`, headers, payload: { version: 4, status: 'suspended', reason: '测试停用' } }); assert.equal(disabled.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie: `adi_session=${anc.token}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${seed.userId}/status`, headers, payload: { version: 2, status: 'deleted', reason: '最后超管' } })).statusCode, 409);
});

test('HTTP advertises configuration management and rejects protected mutations without exposing secrets', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const fixed = await identity.syncConfigurationAdministrator({ email: 'configured-http@example.invalid', name: '配置管理员', password: 'configured-http-password' });
  const app = createApi(undefined, { identity, administration: createAdministrationService(db, identity) }); t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'configured-http@example.invalid', password: 'configured-http-password' } });
  assert.equal(login.statusCode, 200); assert.equal(login.json().data.management_source, 'environment'); assert.equal(login.json().data.must_change_password, false);
  const cookies = [login.headers['set-cookie']].flat().join('; ');
  const headers = { cookie: cookies, 'x-csrf-token': /adi_csrf=([^;]+)/.exec(cookies)![1]! };
  const account = await app.inject({ url: `/api/v1/admin/users/${fixed.userId}`, headers });
  assert.equal(account.statusCode, 200); assert.equal(account.json().data.management_source, 'environment');
  for (const request of [
    { method: 'POST' as const, url: '/api/v1/auth/change-password', payload: { current_password: 'configured-http-password', new_password: 'forbidden-new-password' } },
    { method: 'POST' as const, url: `/api/v1/admin/users/${fixed.userId}/reset-password`, payload: { version: 1, reason: 'forgotten' } },
    { method: 'PATCH' as const, url: `/api/v1/admin/users/${fixed.userId}/status`, payload: { version: 1, status: 'deleted', reason: 'test' } },
    { method: 'PUT' as const, url: `/api/v1/admin/users/${fixed.userId}/global-roles`, payload: { version: 1, global_roles: [] } },
    { method: 'PATCH' as const, url: `/api/v1/admin/users/${fixed.userId}/email`, payload: { version: 1, email: 'wrong@example.invalid', verification_note: 'test' } },
  ]) {
    const result = await app.inject({ ...request, headers });
    assert.equal(result.statusCode, 403, result.body); assert.equal(result.json().error.code, 'configuration_managed_account');
    assert.doesNotMatch(result.body, /configured-http-password|password_hash|scrypt/);
  }
});
