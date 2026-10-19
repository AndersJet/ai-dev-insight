import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSession } from '../src/stores/session.js';
import type { CurrentUser } from '@adi/contracts';

test('a stale unauthenticated refresh cannot erase a newly successful login', async t => {
  const user: CurrentUser = { management_source: 'system', user_id: 'person', email: 'person@example.invalid', display_name: '合成用户', roles: ['employee'], managed_departments: [], allowed_actions: ['self:read'], default_route: '/my/overview', must_change_password: false };
  let release: ((response: Response) => void) | undefined;
  const oldReply = new Promise<Response>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (input === '/api/v1/me') return oldReply;
    return new Response(JSON.stringify({ data: user, meta: { request_id: 'fixture' } }), { status: 200 });
  });
  t.after(() => release?.(new Response(null, { status: 401 })));
  setActivePinia(createPinia()); const session = useSession();
  const refresh = session.refresh();
  await session.login('person@example.invalid', 'test-only-password');
  release?.(new Response(null, { status: 401 })); await refresh;
  assert.equal(session.user?.user_id, 'person'); assert.equal(session.loading, false);
});
