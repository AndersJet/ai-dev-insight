import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createAdministrationService } from '../../src/administration.js';
import { createOrganizationService } from '../../src/organization.js';
import { createInstallationService } from '../../src/installations.js';

const configuration = { email: 'configured@example.invalid', name: '配置管理员', password: 'configured-admin-password' };
test('configuration administrator has no password expiry; unchanged startup preserves sessions and rotation revokes them', async t => {
  const db = await testDatabase(t); await db.migrate();
  let time = new Date();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock: () => time });
  const first = await identity.syncConfigurationAdministrator(configuration);
  const login = await identity.login(configuration.email, configuration.password);
  assert.equal(login.user.must_change_password, false);
  assert.equal(login.user.management_source, 'environment');
  assert.ok(login.user.roles.includes('super'));
  assert.ok(!login.user.allowed_actions.includes('self:password'));
  assert.equal((await identity.syncConfigurationAdministrator(configuration)).userId, first.userId);
  assert.ok(await identity.resolve(login.token));
  await identity.syncConfigurationAdministrator({ ...configuration, password: 'rotated-admin-password' });
  assert.equal(await identity.resolve(login.token), null);
  await assert.rejects(identity.login(configuration.email, configuration.password), { code: 'invalid_credentials' });
  time = new Date(time.getTime() + 400 * 86400000);
  assert.equal((await identity.login(configuration.email, 'rotated-admin-password')).user.must_change_password, false);
  const credentials = (await db.query('SELECT must_change,temporary_expires_at FROM credentials')).rows[0];
  assert.deepEqual(credentials, { must_change: false, temporary_expires_at: null });
});

test('switching configured email retires only that identity and never revives its previous credentials', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const first = await identity.syncConfigurationAdministrator(configuration);
  const old = await identity.login(configuration.email, configuration.password);
  await db.query('UPDATE users SET registered_at=now() WHERE id=$1',[first.userId]); // Synthetic registered owner to exercise credential retirement.
  const installation = await createInstallationService(db, identity, { encryptionKey: Buffer.alloc(32, 4) }).credential(old.token);
  const next = { ...configuration, email: 'next@example.invalid', password: 'next-configured-password' };
  const switched = await identity.syncConfigurationAdministrator(next);
  assert.notEqual(first.userId, switched.userId);
  assert.equal(await identity.resolve(old.token), null);
  await assert.rejects(identity.login(configuration.email, configuration.password), { code: 'invalid_credentials' });
  const current = await identity.login(next.email, next.password);
  const admin = createAdministrationService(db, identity);
  const retired = await admin.getAccount(current.token, first.userId);
  assert.equal(retired.email, configuration.email);
  await assert.rejects(admin.setStatus(current.token, first.userId, { version: retired.version, status: 'active', reason: 'reactivate' }), { code: 'configuration_managed_account' });
  const restored = await identity.syncConfigurationAdministrator({ ...configuration, password: 'restored-configured-password' });
  assert.equal(restored.userId, first.userId);
  assert.equal(await identity.resolve(current.token), null);
  assert.equal(await identity.resolve(old.token), null);
  const installations = await db.query('SELECT enabled,revoked_at FROM installations WHERE id=$1', [installation.installation.id]);
  assert.equal(installations.rows[0]!.enabled, false); assert.ok(installations.rows[0]!.revoked_at);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE management_source='environment' AND status='active'")).rows[0]!.n, 1);
  assert.equal((await identity.login(configuration.email, 'restored-configured-password')).user.user_id, first.userId);
});

test('configuration account is protected on server while application-managed superadmins retain their lifecycle', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const fixed = await identity.syncConfigurationAdministrator(configuration);
  const login = await identity.login(configuration.email, configuration.password);
  const admin = createAdministrationService(db, identity), org = createOrganizationService(db, identity);
  const dept = await org.createDepartment(login.token, '测试部门');
  const person = await org.addMember(login.token, dept.id, { email: 'second@example.invalid', display_name: '应用超管' });
  await admin.setAccess(login.token, person.user_id, { version: 1, global_roles: ['super'] });
  const issued = await identity.resetPassword(login.token, person.user_id, 2);
  const temporary = await identity.login(person.email, issued.temporaryPassword);
  const other = await identity.changePassword(temporary.token, issued.temporaryPassword, 'second-admin-password');
  const version = (await admin.getAccount(other.token, fixed.userId)).version;
  for (const status of ['suspended', 'deleted'] as const) await assert.rejects(admin.setStatus(other.token, fixed.userId, { version, status, reason: 'test' }), { code: 'configuration_managed_account' });
  await assert.rejects(admin.setAccess(other.token, fixed.userId, { version, global_roles: [] }), { code: 'configuration_managed_account' });
  await assert.rejects(admin.correctEmail(other.token, fixed.userId, { version, email: 'wrong@example.invalid', verification_note: 'test' }), { code: 'configuration_managed_account' });
  await assert.rejects(identity.resetPassword(other.token, fixed.userId, version), { code: 'configuration_managed_account' });
  await assert.rejects(identity.changePassword(login.token, configuration.password, 'cannot-change-password'), { code: 'configuration_managed_account' });
  await org.addMember(other.token, dept.id, { email: configuration.email, attach_existing: true });
  assert.ok(await identity.resolve(login.token));
  await assert.rejects(identity.syncConfigurationAdministrator({ ...configuration, email: person.email }), { code: 'configuration_admin_email_conflict' });
  assert.ok(await identity.resolve(login.token)); assert.ok(await identity.resolve(other.token));
  await admin.setStatus(login.token, person.user_id, { version: (await admin.getAccount(login.token, person.user_id)).version, status: 'deleted', reason: 'test' });
  assert.equal(await identity.resolve(other.token), null);
});

test('configuration synchronization remains quarantined during recovery and concurrent sync keeps one active identity', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const synced = await Promise.all([identity.syncConfigurationAdministrator(configuration), identity.syncConfigurationAdministrator(configuration)]);
  assert.equal(synced[0].userId, synced[1].userId);
  await db.query("WITH r AS (INSERT INTO recovery_runs(id,dataset_id,state) SELECT gen_random_uuid(),dataset_id,'quarantined' FROM data_identity RETURNING id) UPDATE data_identity SET recovery_id=(SELECT id FROM r)");
  await assert.rejects(identity.syncConfigurationAdministrator(configuration), { code: 'recovery_quarantined' });
});
