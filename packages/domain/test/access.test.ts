import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, type Actor } from '../src/index.js';

const departmentAdmin: Actor = { user_id: 'manager', roles: ['department_admin'], managed_departments: [{ id: 'department-a', name: '部门A' }] };
test('department statistics access never grants access to a member session body', () => {
  assert.equal(authorize(departmentAdmin, 'statistics:read', { departmentId: 'department-a', userId: 'member' }), true);
  assert.equal(authorize(departmentAdmin, 'content:read', { departmentId: 'department-a', userId: 'member' }), false);
  assert.equal(authorize(departmentAdmin, 'content:read', { userId: 'manager' }), true);
});
test('superadmin global access and employee self access do not expand department grants', () => {
  const superAdmin: Actor = { user_id: 'root', roles: ['super'], managed_departments: [] };
  const employee: Actor = { user_id: 'employee', roles: ['employee'], managed_departments: [] };
  assert.equal(authorize(superAdmin, 'users:security'), true);
  assert.equal(authorize(superAdmin, 'content:read', { userId: 'employee' }), true);
  assert.equal(authorize(employee, 'statistics:read', { userId: 'employee' }), true);
  assert.equal(authorize(employee, 'statistics:read', { userId: 'other' }), false);
  assert.equal(authorize(employee, 'members:manage', { departmentId: 'department-a' }), false);
  assert.equal(authorize(departmentAdmin, 'members:manage', { departmentId: 'department-a' }), true);
  assert.equal(authorize(departmentAdmin, 'members:manage', { departmentId: 'department-b' }), false);
  assert.equal(authorize(departmentAdmin, 'statistics:read', { departmentId: 'department-b', userId: 'manager' }), false);
  assert.equal(authorize(departmentAdmin, 'departments:manage'), false);
  assert.equal(authorize(departmentAdmin, 'users:security'), false);
});
test('ANC administration covers departments and members but not global security or other users content', () => {
  const anc: Actor = { user_id: 'anc-manager', roles: ['anc_admin'], managed_departments: [] };
  assert.equal(authorize(anc, 'departments:manage'), true);
  assert.equal(authorize(anc, 'members:manage', { departmentId: 'department-b' }), true);
  assert.equal(authorize(anc, 'statistics:read'), true);
  assert.equal(authorize(anc, 'content:read', { userId: 'someone-else' }), false);
  assert.equal(authorize(anc, 'users:security'), false);
  assert.equal(authorize(anc, 'system:manage'), false);
});
