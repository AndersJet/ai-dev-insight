import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';

test('initial temporary password requires change and changing it revokes the old session', async t => {
  const db = await testDatabase(t); await db.migrate();
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const initial = await identity.bootstrap({ email: ' Root@Example.Invalid ', name: '合成管理员' });
  const first = await identity.login('root@example.invalid', initial.temporaryPassword);
  assert.equal(first.user.email, 'root@example.invalid');
  assert.equal(first.user.must_change_password, true); assert.ok(first.user.roles.includes('super'));
  assert.equal((await identity.resolve(first.token))?.user.user_id, initial.userId);
  const changed = await identity.changePassword(first.token, initial.temporaryPassword, 'a-strong-new-test-password');
  assert.equal(changed.user.must_change_password, false);
  assert.equal(await identity.resolve(first.token), null);
  await assert.rejects(identity.login('root@example.invalid', initial.temporaryPassword), { code: 'invalid_credentials' });
  assert.equal((await identity.login('root@example.invalid', 'a-strong-new-test-password')).user.user_id, initial.userId);
  await assert.rejects(identity.bootstrap({ email: 'other@example.invalid', name: '第二个初始化' }), { code: 'already_initialized' });
});
test('login throttling is per account and recovers after its bounded window', async t => {
  const db = await testDatabase(t); await db.migrate(); let instant = new Date('2026-09-23T00:00:00Z');
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock: () => instant, loginMaxAttempts: 2, loginWindowMs: 60_000 });
  const user = await identity.bootstrap({ email: 'limit@example.invalid', name: '登录限速' });
  for (let i = 0; i < 2; i++) await assert.rejects(identity.login('limit@example.invalid', 'wrong'), { code: 'invalid_credentials' });
  await assert.rejects(identity.login('limit@example.invalid', user.temporaryPassword), { code: 'rate_limited' });
  await assert.rejects(identity.login('another@example.invalid', 'wrong'), { code: 'invalid_credentials' });
  instant = new Date('2026-09-23T00:01:01Z');
  assert.equal((await identity.login('limit@example.invalid', user.temporaryPassword)).user.user_id, user.userId);
});

test('a temporary session opened just before password expiry cannot keep the password-change page usable', async t => {
  const db=await testDatabase(t);await db.migrate();let instant=new Date('2026-09-23T00:00:00Z');
  const identity=createIdentityService(db,{emailDomains:['example.invalid'],clock:()=>instant});
  const issued=await identity.bootstrap({email:'expiry@example.invalid',name:'临时密码过期验证'});
  instant=new Date('2026-09-23T23:59:00Z');
  const session=await identity.login('expiry@example.invalid',issued.temporaryPassword);
  assert.equal(session.user.must_change_password,true);
  assert.equal(session.expiresAt.toISOString(),'2026-09-24T00:00:00.000Z');
  instant=new Date('2026-09-24T00:00:00Z');
  assert.equal(await identity.resolve(session.token),null);
  await assert.rejects(identity.changePassword(session.token,issued.temporaryPassword,'new-synthetic-expiry-password'),{code:'unauthenticated'});
  await assert.rejects(identity.login('expiry@example.invalid',issued.temporaryPassword),{code:'invalid_credentials'});
});
test('configured email domains remain fail-closed for provisioning and login', async t => {
  const db = await testDatabase(t); await db.migrate();
  await assert.rejects(createIdentityService(db,{emailDomains:['allowed.invalid']}).bootstrap({ email: 'outside@example.invalid', name: '域名测试' }), { code: 'invalid_email_domain' });
  const allowed = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const user = await allowed.bootstrap({ email: 'allowed@example.invalid', name: '域名测试' });
  const session = await allowed.login('allowed@example.invalid', user.temporaryPassword);
  assert.equal(session.user.user_id, user.userId);
  await assert.rejects(createIdentityService(db, { emailDomains: ['denied.invalid'] }).login('allowed@example.invalid', user.temporaryPassword), { code: 'invalid_credentials' });
  assert.equal(await createIdentityService(db, { emailDomains: ['denied.invalid'] }).resolve(session.token), null);
});
test('only a superadmin can issue a temporary reset and reset immediately revokes existing sessions', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const initial = await identity.bootstrap({ email: 'super@example.invalid', name: '超管' });
  const first = await identity.login('super@example.invalid', initial.temporaryPassword);
  const root = await identity.changePassword(first.token, initial.temporaryPassword, 'super-regular-password');
  const ancId = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [ancId, 'anc@example.invalid', '事业部管理员']);
  await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'anc_admin',$2)", [ancId, new Date()]);
  const issued = await identity.resetPassword(root.token, ancId, 1);
  const ancTemporary = await identity.login('anc@example.invalid', issued.temporaryPassword);
  const anc = await identity.changePassword(ancTemporary.token, issued.temporaryPassword, 'anc-regular-password');
  await assert.rejects(identity.resetPassword(anc.token, initial.userId, 2), { code: 'forbidden' });
  const reset = await identity.resetPassword(root.token, ancId, 3);
  assert.equal(await identity.resolve(anc.token), null);
  await assert.rejects(identity.login('anc@example.invalid', 'anc-regular-password'), { code: 'invalid_credentials' });
  assert.equal((await identity.login('anc@example.invalid', reset.temporaryPassword)).user.must_change_password, true);
  const audit = await db.query('SELECT action,metadata FROM audit_events WHERE action=$1', ['password_reset']);
  assert.equal(audit.rowCount, 2); assert.ok(!JSON.stringify(audit.rows).includes(reset.temporaryPassword));
});
