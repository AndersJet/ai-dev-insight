import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
test('default API denies identity/role spoofing', async t => {
  const app = createApi(); t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/me?role=super', headers: { 'x-user-id': 'admin', 'x-role': 'super', cookie: 'adi_session=made-up' } });
  assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'unauthenticated');
});
test('me serializes only the public contract from the authentication adapter', async t => {
  const app = createApi(async () => ({ management_source: 'system', user_id: 'fixture', display_name: '合成用户', email: 'fixture@example.invalid', roles: ['employee'], managed_departments: [], allowed_actions: ['self:read'], default_route: '/my/overview', must_change_password: false, password_hash: 'do-not-leak' }));
  t.after(() => app.close());
  const response = await app.inject('/api/v1/me');
  assert.equal(response.statusCode, 200); assert.equal(response.json().data.user_id, 'fixture'); assert.ok(!response.body.includes('do-not-leak'));
});
test('authentication failure does not disclose internals', async t => {
  const app = createApi(async () => { throw new Error('db-password-secret'); }); t.after(() => app.close());
  const response = await app.inject('/api/v1/me');
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('secret'));
});
