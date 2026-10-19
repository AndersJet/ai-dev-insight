import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApi } from '@adi/contracts';

test('published query requirements match the HTTP schema for imports and authenticated personal downloads', () => {
  const parameters = (path: string, method: string) => (openApi.paths[path]?.[method] as { parameters: { name: string; in: string; required: boolean }[] }).parameters;
  const preview = parameters('/api/v1/member-imports/preview', 'post');
  assert.equal(preview.find(item => item.name === 'department_id')?.required, true);
  assert.equal(preview.find(item => item.name === 'mode')?.required, false);
  assert.equal(openApi.paths['/api/v1/me/installations'], undefined);
  assert.equal(openApi.paths['/api/v1/public/collection-client'], undefined);
  assert.equal(openApi.paths['/api/v1/me/collection-client'],undefined);
  assert.ok(openApi.paths['/api/v1/plugin/collection-client']?.get);
  assert.equal(openApi.paths['/api/v1/plugin/collection-client']?.post,undefined);
  assert.equal(openApi.paths['/api/v1/admin/users/{id}/collection-credential']?.post, undefined);
});
