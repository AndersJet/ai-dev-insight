import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database, Transaction, Queryable } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import { DomainError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {configuredEmailDomains,emailDomainAllowed} from './email-domains.js';

async function serving(sql: Queryable, lock = false) {
  const row = (await sql.query<{ recovery_id: string | null }>('SELECT recovery_id FROM data_identity' + (lock ? ' FOR SHARE' : ''))).rows[0];
  if (!row || row.recovery_id) throw new DomainError('recovery_quarantined', 503);
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const dummyHash = hashPassword(randomBytes(24).toString('base64url'));
type Sql = Queryable;
interface Account { registered_at: Date | null; management_source: 'system' | 'environment'; id: string; email_key: string; display_name: string; status: string; auth_version: number; password_hash: string; must_change: boolean; temporary_expires_at: Date | null }
export interface SessionIdentity { user: CurrentUser; authVersion: number; csrfHash: string; expiresAt: Date }
export interface LoginResult { token: string; csrfToken: string; expiresAt: Date; user: CurrentUser }

export function createIdentityService(db: Database, options: { clock?: () => Date; emailDomains?: readonly string[]; loginMaxAttempts?: number; loginWindowMs?: number } = {}) {
  const now = options.clock ?? (() => new Date());
  const attempts = options.loginMaxAttempts ?? 10; const windowMs = options.loginWindowMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('Invalid login rate limits');
  const loginBuckets = new Map<string, { count: number; expires: number }>();
  function consume(key: string, maximum: number, duration: number) {
    const time = now().getTime(); let bucket = loginBuckets.get(key);
    if (bucket && bucket.expires <= time) { loginBuckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (loginBuckets.size >= 10_000) for (const [oldKey, entry] of loginBuckets) if (entry.expires <= time) loginBuckets.delete(oldKey);
      if (loginBuckets.size >= 10_000) throw new DomainError('rate_limited', 429);
      bucket = { count: 0, expires: time + duration }; loginBuckets.set(key, bucket);
    }
    if (bucket.count >= maximum) throw new DomainError('rate_limited', 429);
    bucket.count++;
  }
  const emailDomains = configuredEmailDomains(options.emailDomains);
  function normalizeEmail(value: string) {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || Array.from(email).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new DomainError('invalid_identity');
    if (!emailDomainAllowed(emailDomains,email)) throw new DomainError('invalid_email_domain');
    return email;
  }
  async function account(sql: Sql, userId: string, lock = false) {
    const result = await sql.query<Account>(`SELECT u.id,u.email_key,u.display_name,u.status,u.auth_version,u.management_source,u.registered_at,c.password_hash,c.must_change,c.temporary_expires_at
      FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=$1 ${lock ? 'FOR UPDATE OF u,c' : ''}`, [userId]);
    return result.rows[0];
  }
  async function currentUser(sql: Sql, row: Account): Promise<CurrentUser> {
    const grants = await sql.query<{ role: 'super' | 'anc_admin' | 'department_admin'; scope_id: string | null; name: string | null }>(`SELECT g.role,g.scope_id,d.name FROM role_grants g
      LEFT JOIN departments d ON d.id=g.scope_id AND d.deleted_at IS NULL WHERE g.user_id=$1 AND g.valid_from <= $2 AND (g.valid_to IS NULL OR g.valid_to>$2) AND (g.scope_id IS NULL OR d.id IS NOT NULL) ORDER BY g.role,g.scope_id`, [row.id, now()]);
    const roles = [...new Set<CurrentUser['roles'][number]>(['employee', ...grants.rows.map(grant => grant.role)])];
    let departments = grants.rows.filter(grant => grant.role === 'department_admin' && grant.scope_id && grant.name).map(grant => ({ id: grant.scope_id!, name: grant.name! }));
    const global = roles.includes('super') || roles.includes('anc_admin');
    if (global) departments = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM departments WHERE deleted_at IS NULL ORDER BY name,id')).rows;
    const actions = ['self:read', 'self:installations', 'content:read', 'statistics:read'];
    if (row.management_source === 'system') actions.push('self:password');
    if (global || departments.length) actions.push('members:manage');
    if (global) actions.push('departments:manage');
    if (roles.includes('super')) actions.push('users:security', 'system:manage', 'content:all');
    return { registered:row.registered_at!==null&&row.registered_at!==undefined, management_source: row.management_source, user_id: row.id, display_name: row.display_name, email: row.email_key, roles, managed_departments: departments, allowed_actions: actions,
      default_route: row.must_change ? '/change-password' : global ? '/organization' : departments[0] ? `/organization/${departments[0].id}` : '/my/overview', must_change_password: row.must_change };
  }
  function usable(row: Account | undefined): row is Account {
    return !!row && (row.management_source !== 'environment' || !row.must_change) && row.status === 'active' && emailDomainAllowed(emailDomains,row.email_key) && (!row.must_change || !!row.temporary_expires_at && row.temporary_expires_at > now());
  }
  async function issueSession(sql: Transaction, row: Account): Promise<LoginResult> {
    const token = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(now().getTime() + 8 * 3600_000, row.must_change ? row.temporary_expires_at!.getTime() : Infinity));
    await sql.query('INSERT INTO login_sessions(token_hash,user_id,auth_version,csrf_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [digest(token), row.id, row.auth_version, digest(csrfToken), expiresAt]);
    return { token, csrfToken, expiresAt, user: await currentUser(sql, row) };
  }
  async function bootstrap(input: { email: string; name: string }) {
    const email = normalizeEmail(input.email);
    if (!input.name.trim()) throw new DomainError('invalid_identity');
    const temporaryPassword = randomBytes(24).toString('base64url'); const hash = await hashPassword(temporaryPassword);
    return db.transaction(async client => {
      await serving(client, true);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:bootstrap:${db.schema}`]);
      if ((await client.query("SELECT 1 FROM role_grants WHERE role='super' LIMIT 1")).rowCount) throw new DomainError('already_initialized', 409);
      const userId = randomUUID();
      await client.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [userId, email, input.name.trim()]);
      await client.query('INSERT INTO credentials(user_id,password_hash,must_change,temporary_expires_at) VALUES($1,$2,true,$3)', [userId, hash, new Date(now().getTime() + 24 * 3600_000)]);
      await client.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super',$2)", [userId, now()]);
      return { userId, temporaryPassword };
    });
  }
  /** Trusted startup boundary; never exposed as an HTTP operation. */
  async function syncConfigurationAdministrator(input: { email: string; name: string; password: string }) {
    const email = normalizeEmail(input.email), name = input.name.trim();
    if (!name || name.length > 128) throw new DomainError('invalid_identity');
    const hash = await hashPassword(input.password);
    return db.transaction(async client => {
      await serving(client, true);
      // Same order as organization mutations: serialize first, then ordered user locks.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:organization:${db.schema}`]);
      const users = (await client.query<{ id: string; email_key: string; status: string; management_source: string }>(
        "SELECT id,email_key,status,management_source FROM users WHERE management_source='environment' OR email_key=$1 ORDER BY id FOR UPDATE", [email])).rows;
      const selected = users.find(user => user.email_key === email);
      if (selected && selected.management_source !== 'environment') throw new DomainError('configuration_admin_email_conflict', 409);
      const at = now();
      for (const previous of users.filter(user => user.management_source === 'environment' && user.status === 'active' && user.email_key !== email)) {
        await client.query("UPDATE users SET status='suspended',auth_version=auth_version+1,ingest_epoch=ingest_epoch+1,version=version+1 WHERE id=$1", [previous.id]);
        await client.query('DELETE FROM login_sessions WHERE user_id=$1', [previous.id]);
        await client.query('DELETE FROM credentials WHERE user_id=$1', [previous.id]);
        await client.query('UPDATE installations SET enabled=false,revoked_at=$2 WHERE user_id=$1 AND enabled', [previous.id, at]);
        await client.query('UPDATE departments SET version=version+1 WHERE id IN(SELECT scope_id FROM role_grants WHERE user_id=$1 AND (valid_to IS NULL OR valid_to>$2))', [previous.id, at]);
        await client.query('DELETE FROM role_grants WHERE user_id=$1 AND valid_from>=$2', [previous.id, at]);
        await client.query('UPDATE role_grants SET valid_to=$2 WHERE user_id=$1 AND valid_from<$2 AND (valid_to IS NULL OR valid_to>$2)', [previous.id, at]);
        await client.query("INSERT INTO audit_events(action,target_id) VALUES('configuration_admin_retired',$1)", [previous.id]);
      }
      const userId = selected?.id ?? randomUUID();
      if (!selected) await client.query("INSERT INTO users(id,email_key,display_name,management_source) VALUES($1,$2,$3,'environment')", [userId, email, name]);
      const existing = selected ? await account(client, userId) : undefined;
      const unchanged = selected?.status === 'active' && existing && !existing.must_change && existing.temporary_expires_at === null && await verifyPassword(input.password, existing.password_hash);
      if (!unchanged) {
        await client.query(`INSERT INTO credentials(user_id,password_hash,must_change,temporary_expires_at) VALUES($1,$2,false,NULL)
          ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,must_change=false,temporary_expires_at=NULL,updated_at=$3`, [userId, hash, at]);
        if (selected) await client.query("UPDATE users SET status='active',auth_version=auth_version+1,version=version+1 WHERE id=$1", [userId]);
        await client.query('DELETE FROM login_sessions WHERE user_id=$1', [userId]);
        await client.query("INSERT INTO audit_events(action,target_id,metadata) VALUES('configuration_admin_synchronized',$1,$2)", [userId, { reason: !selected ? 'created' : selected.status !== 'active' ? 'reactivated' : 'password_changed' }]);
      }
      if (!(await client.query("SELECT 1 FROM role_grants WHERE user_id=$1 AND role='super' AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)", [userId, at])).rowCount) {
        await client.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'super',$2)", [userId, at]);
      }
      return { userId };
    });
  }
  async function login(email: string, password: string, source = 'internal'): Promise<LoginResult> {
    await serving(db);
    consume(`source:${digest(source)}`, 1000, 60_000);
    const attemptKey = `account:${digest(email.trim().toLowerCase())}`;
    consume(attemptKey, attempts, windowMs);
    let normalized: string;
    try { normalized = normalizeEmail(email); } catch { await verifyPassword(password, await dummyHash); throw new DomainError('invalid_credentials', 401); }
    const match = await db.query<{ id: string }>('SELECT id FROM users WHERE email_key=$1', [normalized]);
    const initial = match.rows[0] ? await account(db, match.rows[0].id) : undefined;
    const valid = await verifyPassword(password, initial?.password_hash ?? await dummyHash);
    if (!valid || !usable(initial)) throw new DomainError('invalid_credentials', 401);
    return db.transaction(async client => {
      await serving(client, true);
      const latest = await account(client, initial.id, true);
      if (!usable(latest) || latest.password_hash !== initial.password_hash || latest.auth_version !== initial.auth_version) throw new DomainError('invalid_credentials', 401);
      const session = await issueSession(client, latest); loginBuckets.delete(attemptKey); return session;
    });
  }
  async function resolve(token: string): Promise<SessionIdentity | null> {
    await serving(db);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessions = await db.query<{ user_id: string; auth_version: number; csrf_hash: string; expires_at: Date }>('SELECT user_id,auth_version,csrf_hash,expires_at FROM login_sessions WHERE token_hash=$1 AND expires_at>$2', [digest(token), now()]);
    const session = sessions.rows[0]; if (!session) return null;
    const row = await account(db, session.user_id);
    if (!usable(row) || row.auth_version !== session.auth_version) return null;
    return { user: await currentUser(db, row), authVersion: row.auth_version, csrfHash: session.csrf_hash, expiresAt: session.expires_at };
  }
  async function changePassword(token: string, currentPassword: string, newPassword: string): Promise<LoginResult> {
    const session = await resolve(token); if (!session) throw new DomainError('unauthenticated', 401);
    const initial = await account(db, session.user.user_id);
    if (!initial || !await verifyPassword(currentPassword, initial.password_hash)) throw new DomainError('invalid_credentials', 401);
    if (initial.management_source === 'environment') throw new DomainError('configuration_managed_account', 403);
    if (newPassword === currentPassword) throw new DomainError('password_unchanged');
    const hash = await hashPassword(newPassword);
    return db.transaction(async client => {
      await serving(client, true);
      const latest = await account(client, initial.id, true);
      if (!usable(latest) || latest.auth_version !== session.authVersion || latest.password_hash !== initial.password_hash) throw new DomainError('unauthenticated', 401);
      if (latest.management_source === 'environment') throw new DomainError('configuration_managed_account', 403);
      const stillValid = await client.query('SELECT 1 FROM login_sessions WHERE token_hash=$1 AND user_id=$2 AND auth_version=$3 AND expires_at>$4 FOR UPDATE', [digest(token), latest.id, latest.auth_version, now()]);
      if (!stillValid.rowCount) throw new DomainError('unauthenticated', 401);
      await client.query('UPDATE credentials SET password_hash=$2,must_change=false,temporary_expires_at=NULL,updated_at=$3 WHERE user_id=$1', [latest.id, hash, now()]);
      await client.query('UPDATE users SET auth_version=auth_version+1,version=version+1 WHERE id=$1', [latest.id]);
      await client.query('DELETE FROM login_sessions WHERE user_id=$1', [latest.id]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'password_changed',$1)", [latest.id]);
      return issueSession(client, { ...latest, password_hash: hash, must_change: false, temporary_expires_at: null, auth_version: latest.auth_version + 1 });
    });
  }
  async function resetPassword(token: string, targetId: string, version: number, reason = 'administrative') {
    if (!['initial_issue', 'forgotten', 'expired', 'security', 'administrative'].includes(reason)) throw new DomainError('invalid_request', 400);
    const session = await resolve(token);
    if (!session) throw new DomainError('unauthenticated', 401);
    if (session.user.must_change_password) throw new DomainError('password_change_required', 403);
    if (!session.user.roles.includes('super')) throw new DomainError('forbidden', 403);
    const temporaryPassword = randomBytes(24).toString('base64url'); const hash = await hashPassword(temporaryPassword);
    return db.transaction(async client => {
      await serving(client, true);
      const locked = await client.query<{ id: string; version: number; auth_version: number; management_source: string }>('SELECT id,version,auth_version,management_source FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[session.user.user_id, targetId]]);
      const actor = await account(client, session.user.user_id);
      if (!usable(actor) || actor.auth_version !== session.authVersion) throw new DomainError('unauthenticated', 401);
      const stillValid = await client.query('SELECT 1 FROM login_sessions WHERE token_hash=$1 AND auth_version=$2 AND expires_at>$3 FOR UPDATE', [digest(token), actor.auth_version, now()]);
      if (!stillValid.rowCount) throw new DomainError('unauthenticated', 401);
      if (!(await currentUser(client, actor)).roles.includes('super')) throw new DomainError('forbidden', 403);
      const target = locked.rows.find(row => row.id === targetId);
      if (!target) throw new DomainError('not_found', 404);
      if (target.management_source === 'environment') throw new DomainError('configuration_managed_account', 403);
      if (target.version !== version) throw new DomainError('version_conflict', 409);
      await client.query(`INSERT INTO credentials(user_id,password_hash,must_change,temporary_expires_at) VALUES($1,$2,true,$3)
        ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,must_change=true,temporary_expires_at=excluded.temporary_expires_at,updated_at=$4`, [targetId, hash, new Date(now().getTime() + 24 * 3600_000), now()]);
      await client.query('UPDATE users SET auth_version=auth_version+1,version=version+1 WHERE id=$1', [targetId]);
      await client.query('DELETE FROM login_sessions WHERE user_id=$1', [targetId]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'password_reset',$2,$3)", [actor.id, targetId, { version: version + 1, temporary: true, reason }]);
      return { temporaryPassword, version: version + 1 };
    });
  }
  async function logout(token: string) { await db.query('DELETE FROM login_sessions WHERE token_hash=$1', [digest(token)]); }
  function validCsrf(session: SessionIdentity, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(session.csrfHash, 'hex'), Buffer.from(digest(token), 'hex'));
  }
  async function requireUser(token: string) {
    const session = await resolve(token);
    if (!session) throw new DomainError('unauthenticated', 401);
    if (session.user.must_change_password) throw new DomainError('password_change_required', 403);
    return session.user;
  }
  async function mutate<T>(token: string, work: (client: Transaction, actor: CurrentUser) => Promise<T>, settings: { checkAccess?: (actor: CurrentUser) => void; serializeOrganization?: boolean; lockUserIds?: readonly string[] | ((client: Transaction) => Promise<string[]>) } = {}) {
    const session = await resolve(token);
    if (!session) throw new DomainError('unauthenticated', 401);
    if (session.user.must_change_password) throw new DomainError('password_change_required', 403);
    settings.checkAccess?.(session.user);
    return db.transaction(async client => {
      await serving(client, true);
      if (settings.serializeOrganization) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:organization:${db.schema}`]);
      const targets = typeof settings.lockUserIds === 'function' ? await settings.lockUserIds(client) : settings.lockUserIds ?? [];
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[session.user.user_id, ...targets]]);
      const row = await account(client, session.user.user_id);
      if (!usable(row) || row.auth_version !== session.authVersion) throw new DomainError('unauthenticated', 401);
      if (row.must_change) throw new DomainError('password_change_required', 403);
      const active = await client.query('SELECT 1 FROM login_sessions WHERE token_hash=$1 AND user_id=$2 AND auth_version=$3 AND expires_at>$4 FOR UPDATE', [digest(token), row.id, row.auth_version, now()]);
      if (!active.rowCount) throw new DomainError('unauthenticated', 401);
      const actor = await currentUser(client, row); settings.checkAccess?.(actor);
      return work(client, actor);
    });
  }
  async function mutateJob<T>(actorId: string, authVersion: number, work: (client: Transaction, actor: CurrentUser) => Promise<T>, settings: { checkAccess: (actor: CurrentUser) => void; lockUserIds: readonly string[] } ) {
    await serving(db);
    const initial = await account(db, actorId);
    if (!usable(initial) || initial.must_change || initial.auth_version !== authVersion) throw new DomainError('job_authorization_changed', 403);
    settings.checkAccess(await currentUser(db, initial));
    return db.transaction(async client => {
      await serving(client, true);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:organization:${db.schema}`]);
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[actorId, ...settings.lockUserIds]]);
      const fresh = await account(client, actorId);
      if (!usable(fresh) || fresh.must_change || fresh.auth_version !== authVersion) throw new DomainError('job_authorization_changed', 403);
      const actor = await currentUser(client, fresh); settings.checkAccess(actor);
      return work(client, actor);
    });
  }
  return { bootstrap, syncConfigurationAdministrator, login, resolve, changePassword, resetPassword, logout, validCsrf, normalizeEmail, requireUser, mutate, mutateJob };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
