import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createOrganizationService } from '../../src/organization.js';

test('department member lifecycle refuses nonempty deletion and preserves the removed person and history', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const bootstrap = await identity.bootstrap({ email: 'org-root@example.invalid', name: '组织管理员' });
  const first = await identity.login('org-root@example.invalid', bootstrap.temporaryPassword);
  const root = await identity.changePassword(first.token, bootstrap.temporaryPassword, 'organization-root-password');
  const org = createOrganizationService(db, identity);
  const department = await org.createDepartment(root.token, '研发一部');
  const member = await org.addMember(root.token, department.id, { email: ' Member@Example.Invalid ', display_name: '员工甲' });
  assert.equal((await org.listMembers(root.token, department.id)).items[0]?.email, 'member@example.invalid');
  let current = (await org.listDepartments(root.token)).find(item => item.id === department.id); assert.ok(current);
  await assert.rejects(org.deleteDepartment(root.token, department.id, current.version), { code: 'department_not_empty' });
  await org.removeMember(root.token, department.id, member.user_id, member.version);
  assert.equal((await org.listMembers(root.token, department.id)).items.length, 0);
  const original = await db.query<{ status: string }>('SELECT status FROM users WHERE id=$1', [member.user_id]);
  const history = await db.query<{ department_id: string; valid_to: Date | null }>('SELECT department_id,valid_to FROM membership_periods WHERE user_id=$1', [member.user_id]);
  assert.equal(original.rows[0]?.status, 'active'); assert.equal(history.rows[0]?.department_id, department.id); assert.ok(history.rows[0]?.valid_to);
  current = (await org.listDepartments(root.token)).find(item => item.id === department.id); assert.ok(current);
  await org.deleteDepartment(root.token, department.id, current.version);
  assert.equal((await org.listDepartments(root.token)).length, 0);
});
test('removing a membership at its exact creation time ends access immediately and keeps an empty historical period', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'instant-root@example.invalid', name: '边界管理员' });
  const first = await identity.login('instant-root@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'instant-root-password');
  const at = new Date('2026-09-24T00:00:00Z'); const org = createOrganizationService(db, identity, { clock: () => at });
  const dept = await org.createDepartment(root.token, '即时边界'); const member = await org.addMember(root.token, dept.id, { email: 'instant@example.invalid', display_name: '同一时刻' });
  await org.removeMember(root.token, dept.id, member.user_id, 1);
  assert.equal((await org.listMembers(root.token, dept.id)).items.length, 0);
  const history = await db.query<{ empty: boolean }>("SELECT isempty(tstzrange(valid_from,valid_to,'[)')) AS empty FROM membership_periods WHERE user_id=$1", [member.user_id]);
  assert.equal(history.rows[0]?.empty, true);
});
test('scheduled transfers preserve the old department until effective time and can be cancelled before taking effect', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'transfer-root@example.invalid', name: '调岗管理员' });
  const first = await identity.login('transfer-root@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'transfer-root-password');
  let at = new Date('2026-09-24T00:00:00Z'); const org = createOrganizationService(db, identity, { clock: () => at });
  const a = await org.createDepartment(root.token, '调出部门'); const b = await org.createDepartment(root.token, '调入部门');
  const member = await org.addMember(root.token, a.id, { email: 'transfer-person@example.invalid', display_name: '调岗成员' });
  at = new Date('2026-09-24T01:00:00Z');
  await org.transferMember(root.token, member.user_id, { target_department_id: b.id, effective_at: '2026-09-25T00:00:00Z', version: 1 });
  assert.equal((await org.listMembers(root.token, a.id)).items.length, 1); assert.equal((await org.listMembers(root.token, b.id)).items.length, 0);
  await org.cancelTransfer(root.token, member.user_id, 2);
  at = new Date('2026-09-26T00:00:00Z');
  assert.equal((await org.listMembers(root.token, a.id)).items.length, 1); assert.equal((await org.listMembers(root.token, b.id)).items.length, 0);
  await org.transferMember(root.token, member.user_id, { target_department_id: b.id, version: 3 });
  assert.equal((await org.listMembers(root.token, a.id)).items.length, 0); assert.equal((await org.listMembers(root.token, b.id)).items.length, 1);
  const history = await db.query<{ department_id: string }>("SELECT department_id FROM membership_periods WHERE user_id=$1 AND tstzrange(valid_from,valid_to,'[)') @> $2::timestamptz", [member.user_id, '2026-09-24T12:00:00Z']);
  assert.equal(history.rows[0]?.department_id, a.id);
  await assert.rejects(org.transferMember(root.token, member.user_id, { target_department_id: a.id, version: 4, effective_at: '2026-09-24T00:00:00Z' }), { code: 'invalid_effective_at' });
});
test('member edits version-check and reject manual statistical exclusion',async t=>{
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const seed=await identity.bootstrap({email:'eligibility-root@example.invalid',name:'统计管理员'});const first=await identity.login('eligibility-root@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(first.token,seed.temporaryPassword,'eligibility-root-password');
  const org=createOrganizationService(db,identity);const dept=await org.createDepartment(root.token,'测试部门');const member=await org.addMember(root.token,dept.id,{email:'person@example.invalid',display_name:'原姓名'});
  await assert.rejects(org.updateMember(root.token,dept.id,member.user_id,{version:member.version,eligible:false}),{code:'manual_eligibility_removed'});
  await org.updateMember(root.token,dept.id,member.user_id,{version:member.version,display_name:'新姓名'});
  await assert.rejects(org.updateMember(root.token,dept.id,member.user_id,{version:member.version,display_name:'过期覆盖'}),{code:'version_conflict'});
  await assert.rejects(org.addMember(root.token,dept.id,{email:'override@example.invalid',display_name:'不得纳入',eligible:true}),{code:'manual_eligibility_removed'});
  assert.equal((await org.listMembers(root.token,dept.id)).items[0]?.eligible,null);
  assert.equal((await db.query('SELECT 1 FROM eligibility_periods')).rowCount,0);
});
test('member pagination is stable and its signed cursor cannot be reused with another filter', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'pages@example.invalid', name: '分页管理员' });
  const login = await identity.login('pages@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(login.token, seed.temporaryPassword, 'pagination-root-password');
  const org = createOrganizationService(db, identity); const dept = await org.createDepartment(root.token, '分页部门');
  for (let i = 0; i < 5; i++) await org.addMember(root.token, dept.id, { email: `page-${i}@example.invalid`, display_name: `成员${i}` });
  const first = await org.listMembers(root.token, dept.id, { limit: 2 }); assert.equal(first.items.length, 2); assert.ok(first.next_cursor);
  const second = await org.listMembers(root.token, dept.id, { limit: 2, cursor: first.next_cursor }); assert.equal(second.items.length, 2); assert.ok(second.next_cursor);
  const third = await org.listMembers(root.token, dept.id, { limit: 2, cursor: second.next_cursor }); assert.equal(third.items.length, 1); assert.equal(third.next_cursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.user_id)).size, 5);
  await assert.rejects(org.listMembers(root.token, dept.id, { limit: 2, cursor: first.next_cursor, search: '成员0' }), { code: 'invalid_cursor' });
  await assert.rejects(org.listMembers(root.token, dept.id, { limit: 2, cursor: `${first.next_cursor}x` }), { code: 'invalid_cursor' });
  assert.equal((await org.listMembers(root.token, undefined)).items.length, 6); // Includes the unassigned root.
});
test('ANC can configure all departments while a department administrator is limited to granted member scopes', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'scope-root@example.invalid', name: '超管' });
  const initial = await identity.login('scope-root@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(initial.token, seed.temporaryPassword, 'scope-root-password'); const org = createOrganizationService(db, identity);
  const a = await org.createDepartment(root.token, '甲部'); const b = await org.createDepartment(root.token, '乙部');
  const manager = await org.addMember(root.token, a.id, { email: 'manager@example.invalid', display_name: '部门管理员' });
  const issued = await identity.resetPassword(root.token, manager.user_id, 1);
  const temporary = await identity.login(manager.email, issued.temporaryPassword);
  await identity.changePassword(temporary.token, issued.temporaryPassword, 'department-manager-password');
  const currentA = (await org.listDepartments(root.token)).find(item => item.id === a.id); assert.ok(currentA);
  await org.setDepartmentAdmins(root.token, a.id, [manager.user_id], currentA.version);
  const scoped = await identity.login(manager.email, 'department-manager-password');
  assert.deepEqual((await org.listDepartments(scoped.token)).map(item => item.id), [a.id]);
  await org.addMember(scoped.token, a.id, { email: 'own@example.invalid', display_name: '本部成员' });
  await assert.rejects(org.addMember(scoped.token, b.id, { email: 'outside@example.invalid', display_name: '越权' }), { code: 'forbidden' });
  await assert.rejects(org.createDepartment(scoped.token, '越权新部门'), { code: 'forbidden' });
  await assert.rejects(org.listMembers(scoped.token, b.id), { code: 'forbidden' });
  let unlock: (() => void) | undefined; let notify: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { unlock = resolve; }); const locked = new Promise<void>(resolve => { notify = resolve; });
  const holder = db.transaction(async client => { await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [seed.userId]); notify?.(); await gate; });
  try { await Promise.race([locked, holder]); await assert.rejects(org.setDepartmentAdmins(scoped.token, b.id, [seed.userId], 1), { code: 'forbidden' }); }
  finally { unlock?.(); await holder; }
  await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'anc_admin',$2)", [manager.user_id, new Date()]);
  const anc = await identity.login(manager.email, 'department-manager-password');
  await org.createDepartment(anc.token, '事业部新增');
  assert.equal((await org.listDepartments(anc.token)).length, 3);
});

test('a department deletion queued behind a real concurrent member creation cannot delete the newly occupied department', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'concurrent-dept@example.invalid', name: '并发部门验收' });
  const first = await identity.login('concurrent-dept@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(first.token, seed.temporaryPassword, 'concurrent-dept-password');
  const org = createOrganizationService(db, identity); const dept = await org.createDepartment(root.token, '并发部门');
  let release!: () => void; let acquired!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<number>(resolve => { acquired = resolve; });
  const holder = db.transaction(async sql => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:organization:${db.schema}`]);
    acquired(Number((await sql.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)); await gate;
  });
  const operations: Promise<PromiseSettledResult<unknown>[]>[] = [];
  try {
    const blocker = await ready;
    const waiting = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blocker]);
        if (Number(result.rows[0]?.n) >= count) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`expected ${count} real PostgreSQL lock waiters`);
    };
    operations.push(Promise.allSettled([org.addMember(root.token, dept.id, { email: 'racing-member@example.invalid', display_name: '并发新增' })]));
    await waiting(1);
    operations.push(Promise.allSettled([org.deleteDepartment(root.token, dept.id, dept.version)]));
    await waiting(2);
    release(); await holder;
    const added = (await operations[0]!)[0]!; const deleted = (await operations[1]!)[0]!;
    assert.equal(added.status, 'fulfilled');
    assert.equal(deleted.status, 'rejected');
    if (deleted.status === 'rejected') assert.equal(deleted.reason.code, 'department_not_empty');
    assert.equal((await org.listDepartments(root.token)).find(item => item.id === dept.id)?.member_count, 1);
    assert.equal((await org.listMembers(root.token, dept.id)).items[0]?.email, 'racing-member@example.invalid');
  } finally { release(); await holder; await Promise.all(operations); }
});
