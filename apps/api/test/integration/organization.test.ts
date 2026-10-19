import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from '../../../../packages/storage/test/helpers.js';
import { createIdentityService } from '../../../../packages/domain/src/identity.js';
import { createOrganizationService } from '../../../../packages/domain/src/organization.js';
import { createApi } from '../../src/app.js';

test('organization HTTP mutations require CSRF, enforce versions and refuse deleting a populated department', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'http-org@example.invalid', name: 'HTTP组织' });
  const initial = await identity.login('http-org@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(initial.token, seed.temporaryPassword, 'http-organization-password');
  const organization = createOrganizationService(db, identity); const app = createApi(undefined, { identity, organization }); t.after(() => app.close());
  const headers = { cookie: `adi_session=${root.token}`, 'x-csrf-token': root.csrfToken };
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/departments', headers: { cookie: headers.cookie }, payload: { name: '新部门' } })).statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/v1/departments', headers, payload: { name: '新部门' } }); assert.equal(created.statusCode, 201);
  const departmentId = created.json().data.id;
  const member = await app.inject({ method: 'POST', url: `/api/v1/departments/${departmentId}/members`, headers, payload: { email: 'member-http@example.invalid', display_name: 'HTTP成员' } }); assert.equal(member.statusCode, 201);
  const departments = await app.inject({ url: '/api/v1/departments', headers }); const row = departments.json().data[0]; assert.equal(row.member_count, 1);
  const rejected = await app.inject({ method: 'DELETE', url: `/api/v1/departments/${departmentId}`, headers, payload: { version: row.version } });
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, 'department_not_empty');
  const list = await app.inject({ url: `/api/v1/departments/${departmentId}/members?limit=8`, headers }); assert.equal(list.json().data.items.length, 1); assert.equal(list.json().data.items[0].eligible, null);
  const rename = await app.inject({ method: 'PATCH', url: `/api/v1/departments/${departmentId}`, headers, payload: { name: '改名', version: row.version } }); assert.equal(rename.statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/departments/${departmentId}`, headers, payload: { name: '旧版本', version: row.version } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/departments/${departmentId}/members`, headers, payload: { email: 'injected@example.invalid', display_name: '提权', roles: ['super'] } })).statusCode, 400);
  const target = await app.inject({ method: 'POST', url: '/api/v1/departments', headers, payload: { name: '调入部门' } });
  const moved = await app.inject({ method: 'POST', url: `/api/v1/members/${member.json().data.user_id}/transfers`, headers, payload: { target_department_id: target.json().data.id, version: 1 } });
  assert.equal(moved.statusCode, 200);
  assert.equal((await app.inject({ url: `/api/v1/departments/${departmentId}/members`, headers })).json().data.items.length, 0);
});
