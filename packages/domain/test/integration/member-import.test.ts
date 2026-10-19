import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createOrganizationService } from '../../src/organization.js';
import { createMemberImportService } from '../../src/member-import.js';
import { parseMemberFile } from '../../src/member-file.js';
import { createAdministrationService } from '../../src/administration.js';
test('member import previews real rows then commits one atomic idempotent job without blank overwrites', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'import-root@example.invalid', name: '导入超管' }); const first = await identity.login('import-root@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'import-root-password');
  const org = createOrganizationService(db, identity); const dept = await org.createDepartment(root.token, '导入部门');
  await org.addMember(root.token, dept.id, { email: 'existing@example.invalid', display_name: '原姓名' });
  const absent = await org.addMember(root.token, dept.id, { email: 'absent@example.invalid', display_name: '文件缺席仍保留' });
  const imports = createMemberImportService(db, identity);
  const parsed = await parseMemberFile(Buffer.from('工作邮箱,姓名\nnew@example.invalid,新增成员\nexisting@example.invalid,\n'), 'members.csv');
  const preview = await imports.preview(root.token, dept.id, 'upsert', parsed, 'members.csv');
  assert.equal(preview.counts.create, 1); assert.equal(preview.counts.unchanged, 1); assert.equal(preview.counts.error, 0);
  const submitted = await imports.submit(root.token, preview.id, preview.preview_hash, 'same-attempt');
  assert.equal((await imports.submit(root.token, preview.id, preview.preview_hash, 'same-attempt')).job_id, submitted.job_id);
  assert.equal(await imports.runOne(), true);
  const result = await imports.get(root.token, preview.id); assert.equal(result.status, 'succeeded');
  const members = await org.listMembers(root.token, dept.id); assert.equal(members.items.length, 3);
  assert.equal(members.items.find(row => row.email === 'absent@example.invalid')?.user_id, absent.user_id);
  assert.equal(members.items.find(row => row.email === 'existing@example.invalid')?.display_name, '原姓名'); assert.equal(members.items.find(row => row.email === 'existing@example.invalid')?.eligible, null);
  assert.equal(await imports.runOne(), false);
});
test('revoking a queued import creator permission prevents the worker from applying any rows', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'revoke-import-root@example.invalid', name: '撤权超管' }); const first = await identity.login('revoke-import-root@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'revoke-import-root-password');
  const org = createOrganizationService(db, identity); const admin = createAdministrationService(db, identity); const imports = createMemberImportService(db, identity); const dept = await org.createDepartment(root.token, '撤权部门');
  const manager = await org.addMember(root.token, dept.id, { email: 'revoke-manager@example.invalid', display_name: '部门管理员' });
  const issued = await identity.resetPassword(root.token, manager.user_id, 1); const temporary = await identity.login(manager.email, issued.temporaryPassword); await identity.changePassword(temporary.token, issued.temporaryPassword, 'revoke-manager-password');
  await admin.setAccess(root.token, manager.user_id, { version: 3, global_roles: [], department_ids: [dept.id] }); const scoped = await identity.login(manager.email, 'revoke-manager-password');
  const preview = await imports.preview(scoped.token, dept.id, 'insert_only', await parseMemberFile(Buffer.from('工作邮箱,姓名\nforbidden-import@example.invalid,不应新增\n'), 'revoked.csv'), 'revoked.csv');
  await imports.submit(scoped.token, preview.id, preview.preview_hash, 'revoked'); await admin.setAccess(root.token, manager.user_id, { version: 4, global_roles: [], department_ids: [] });
  await imports.runOne(); const result = await imports.get(root.token, preview.id); assert.equal(result.status, 'failed'); assert.equal(result.job?.error_code, 'job_authorization_changed');
  assert.equal((await db.query("SELECT id FROM users WHERE email_key='forbidden-import@example.invalid'")).rowCount, 0);
});
test('duplicates block submission and a late database failure rolls back all imported rows', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'atomic-import@example.invalid', name: '原子导入' }); const first = await identity.login('atomic-import@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'atomic-import-password');
  const org = createOrganizationService(db, identity); const dept = await org.createDepartment(root.token, '原子部门'); const imports = createMemberImportService(db, identity);
  const duplicates = await imports.preview(root.token, dept.id, 'insert_only', await parseMemberFile(Buffer.from('工作邮箱,姓名\na@example.invalid,甲\nA@example.invalid,乙\n'), 'duplicates.csv'), 'duplicates.csv');
  assert.equal(duplicates.counts.error, 2); await assert.rejects(imports.submit(root.token, duplicates.id, duplicates.preview_hash, 'duplicates'), { code: 'import_has_errors' });
  const valid = await imports.preview(root.token, dept.id, 'insert_only', await parseMemberFile(Buffer.from('工作邮箱,姓名\nfirst-row@example.invalid,第一行\nfail-row@example.invalid,第二行\n'), 'atomic.csv'), 'atomic.csv');
  await imports.submit(root.token, valid.id, valid.preview_hash, 'atomic');
  await db.query("CREATE FUNCTION fail_import_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email_key='fail-row@example.invalid' THEN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$");
  await db.query('CREATE TRIGGER fail_import BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fail_import_row()');
  await imports.runOne(); assert.equal((await imports.get(root.token, valid.id)).status, 'failed'); assert.equal((await org.listMembers(root.token, dept.id)).items.length, 0);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE action='member_imported'")).rowCount, 0);
});
test('imports cannot restore removed manual eligibility controls', async t => {
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});
  const seed=await identity.bootstrap({email:'removed-eligibility@example.invalid',name:'导入校验'});const first=await identity.login('removed-eligibility@example.invalid',seed.temporaryPassword);const root=await identity.changePassword(first.token,seed.temporaryPassword,'removed-eligibility-password');
  const org=createOrganizationService(db,identity);const dept=await org.createDepartment(root.token,'无排除部门');const imports=createMemberImportService(db,identity);
  await assert.rejects(parseMemberFile(Buffer.from('工作邮箱,姓名,Trae资格\nmember@example.invalid,人员,未纳入\n'),'old.csv'),{code:'unsupported_columns'});
  await assert.rejects(imports.preview(root.token,dept.id,'insert_only',{departmentId:null,rows:[{row:2,email:'member@example.invalid',display_name:'人员',eligible:false,errors:[]}]},'synthetic.csv'),{code:'manual_eligibility_removed'});
  assert.equal((await db.query('SELECT 1 FROM eligibility_periods')).rowCount,0);
});
test('a scheduled transfer becoming effective after submission prevents the entire import from modifying the wrong department', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'import-race@example.invalid', name: '导入竞态' }); const first = await identity.login('import-race@example.invalid', seed.temporaryPassword); const root = await identity.changePassword(first.token, seed.temporaryPassword, 'import-race-password');
  let at = new Date('2026-09-24T00:00:00Z'); const org = createOrganizationService(db, identity, { clock: () => at }); const imports = createMemberImportService(db, identity, { clock: () => at });
  const a = await org.createDepartment(root.token, '导入甲部'); const b = await org.createDepartment(root.token, '导入乙部');
  const person = await org.addMember(root.token, a.id, { email: 'scheduled-import@example.invalid', display_name: '原姓名' });
  at = new Date('2026-09-24T01:00:00Z'); await org.transferMember(root.token, person.user_id, { version: 1, target_department_id: b.id, effective_at: '2026-09-24T02:00:00Z' });
  const parsed = await parseMemberFile(Buffer.from('工作邮箱,姓名\nshould-not-create@example.invalid,整批新增\nscheduled-import@example.invalid,不应改写\n'), 'race.csv');
  const preview = await imports.preview(root.token, a.id, 'upsert', parsed, 'race.csv'); await imports.submit(root.token, preview.id, preview.preview_hash, 'race-attempt');
  at = new Date('2026-09-24T03:00:00Z'); await imports.runOne();
  assert.equal((await imports.get(root.token, preview.id)).status, 'failed');
  assert.equal((await org.listMembers(root.token, b.id)).items[0]?.display_name, '原姓名');
  assert.equal((await db.query("SELECT id FROM users WHERE email_key='should-not-create@example.invalid'")).rowCount, 0);
});


async function previewFixture(t: TestContext) {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'preview-root@example.invalid', name: '预览验收' });
  const first = await identity.login('preview-root@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(first.token, seed.temporaryPassword, 'preview-root-password');
  const org = createOrganizationService(db, identity);
  const dept = await org.createDepartment(root.token, '预览部门');
  return { db, identity, root, org, dept, imports: createMemberImportService(db, identity) };
}

test('a concurrent department or member rename invalidates the preview before it can overwrite newer data', async t => {
  for (const target of ['department', 'member'] as const) {
    const f = await previewFixture(t);
    const member = await f.org.addMember(f.root.token, f.dept.id, { email: 'renamed@example.invalid', display_name: '原姓名' });
    const preview = await f.imports.preview(f.root.token, f.dept.id, 'upsert', await parseMemberFile(Buffer.from('工作邮箱,姓名\nrenamed@example.invalid,导入改名\n'), 'rename.csv'), 'rename.csv');
    if (target === 'department') {
      const current = (await f.org.listDepartments(f.root.token)).find(row => row.id === f.dept.id)!;
      await f.org.renameDepartment(f.root.token, current.id, '并发新部门名', current.version);
    } else await f.org.updateMember(f.root.token, f.dept.id, member.user_id, { version: member.version, display_name: '并发新姓名' });
    await assert.rejects(f.imports.submit(f.root.token, preview.id, preview.preview_hash, 'stale-rename'), { code: 'preview_stale' });
    assert.equal((await f.org.listMembers(f.root.token, f.dept.id)).items[0]?.display_name, target === 'member' ? '并发新姓名' : '原姓名');
    assert.equal((await f.imports.get(f.root.token, preview.id)).status, 'previewed');
    assert.equal(await f.imports.runOne(), false);
  }
});

test('preview reports cross-department and deleted-email conflicts without reviving or moving those identities', async t => {
  const f = await previewFixture(t); const other = await f.org.createDepartment(f.root.token, '其他部门');
  const foreign = await f.org.addMember(f.root.token, other.id, { email: 'foreign@example.invalid', display_name: '其他人员' });
  const deleted = await f.org.addMember(f.root.token, f.dept.id, { email: 'deleted@example.invalid', display_name: '已删人员' });
  await createAdministrationService(f.db, f.identity).setStatus(f.root.token, deleted.user_id, { version: deleted.version, status: 'deleted', reason: '合成预览验收' });
  const preview = await f.imports.preview(f.root.token, f.dept.id, 'upsert', await parseMemberFile(Buffer.from('工作邮箱,姓名\nforeign@example.invalid,不得调动\ndeleted@example.invalid,不得复活\n'), 'conflicts.csv'), 'conflicts.csv');
  assert.equal(preview.counts.error, 2);
  assert.ok(preview.rows.find(row => row.email === 'foreign@example.invalid')?.errors.includes('cross_department'));
  assert.ok(preview.rows.find(row => row.email === 'deleted@example.invalid')?.errors.includes('account_deleted'));
  await assert.rejects(f.imports.submit(f.root.token, preview.id, preview.preview_hash, 'invalid-conflicts'), { code: 'import_has_errors' });
  assert.equal((await f.org.listMembers(f.root.token, other.id)).items[0]?.user_id, foreign.user_id);
  assert.equal((await createAdministrationService(f.db, f.identity).getAccount(f.root.token, deleted.user_id)).status, 'deleted');
});
