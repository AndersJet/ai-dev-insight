import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@adi/storage';
import type { IdentityService } from './identity.js';
import { hashPassword } from './password.js';
import { DomainError } from './errors.js';

export interface RegistrationInput { email: string; password: string; display_name: string; department_id: string }
export interface ActivationInput { department_id?: string }
export function createRegistrationService(db: Database, identity: IdentityService, options: { clock?: () => Date } = {}) {
  const now = options.clock ?? (() => new Date());
  function emailAddress(value: string) {
    const email = identity.normalizeEmail(value);
    return email;
  }
  async function available(sql: { query: Database['query'] }) {
    const state = await sql.query<{ recovery_id: string | null }>('SELECT recovery_id FROM data_identity FOR SHARE');
    if (!state.rows[0] || state.rows[0].recovery_id) throw new DomainError('recovery_quarantined', 503);
  }
  async function departments() {
    await db.assertNotRecovering();
    return (await db.query<{ id: string; name: string }>('SELECT id,name FROM departments WHERE deleted_at IS NULL ORDER BY name,id LIMIT 1000')).rows;
  }
  async function consumeRegistration(source: string) {
    const at = now(), bucket = createHash('sha256').update(source).digest('hex');
    const allowed = await db.transaction(async client => {
      await available(client);
      await client.query("DELETE FROM registration_rate_limits WHERE window_start < $1::timestamptz - interval '1 day'", [at]);
      const rate = await client.query<{ attempts: number }>(`INSERT INTO registration_rate_limits(bucket,window_start,attempts) VALUES($1,$2,1)
        ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN registration_rate_limits.window_start < $2::timestamptz-interval '10 minutes' THEN 1 ELSE registration_rate_limits.attempts+1 END,
        window_start=CASE WHEN registration_rate_limits.window_start < $2::timestamptz-interval '10 minutes' THEN $2 ELSE registration_rate_limits.window_start END RETURNING attempts`, [bucket, at]);
      return rate.rows[0]!.attempts <= 100;
    });
    if (!allowed) throw new DomainError('rate_limited', 429);
  }
  async function attachDepartment(client: Transaction, userId: string, departmentId: string | undefined, at: Date) {
    const membership = await client.query('SELECT 1 FROM membership_periods WHERE user_id=$1 AND (valid_to IS NULL OR valid_to>$2)', [userId, at]);
    if (membership.rowCount) return;
    if (!departmentId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(departmentId)) throw new DomainError('department_unavailable', 422);
    const department = await client.query('SELECT id FROM departments WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [departmentId]);
    if (!department.rowCount) throw new DomainError('department_unavailable', 422);
    await client.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [userId, departmentId, at]);
    await client.query('UPDATE departments SET version=version+1 WHERE id=$1', [departmentId]);
  }
  async function register(input: RegistrationInput, source = 'internal') {
    const email = emailAddress(input.email), name = input.display_name.trim();
    if (!name || name.length > 128 || Array.from(name).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) throw new DomainError('invalid_identity', 422);
    if (input.password.length < 12 || input.password.length > 128) throw new DomainError('password_length',422);
    await consumeRegistration(source);
    const password = await hashPassword(input.password);
    return db.transaction(async client => {
      await available(client);
      // Serialize with provisioning and membership changes: an existing email
      // must never be claimed through anonymous registration, whatever its role.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:organization:${db.schema}`]);
      const existing = await client.query('SELECT id FROM users WHERE email_key=$1 FOR UPDATE', [email]);
      if (existing.rowCount) throw new DomainError('registration_not_allowed', 409);
      const userId = randomUUID(), at = now();
      await client.query('INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,$2,$3,$4)', [userId, email, name, at]);
      await attachDepartment(client, userId, input.department_id, at);
      await client.query('INSERT INTO credentials(user_id,password_hash,must_change,temporary_expires_at) VALUES($1,$2,false,NULL)', [userId, password]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'registration_completed',$1,$2)", [userId, { claimed: false }]);
      return { user_id: userId };
    });
  }
  async function activate(token: string, input: ActivationInput) {
    // mutate rechecks the session, status and completed password change under
    // locks. The target is always the logged-in user, never a submitted email.
    return identity.mutate(token, async (client, actor) => {
      emailAddress(actor.email);
      if (actor.registered) throw new DomainError('registration_not_allowed', 409);
      const at = now();
      await attachDepartment(client, actor.user_id, input.department_id, at);
      await client.query('UPDATE users SET registered_at=$2,version=version+1 WHERE id=$1', [actor.user_id, at]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'registration_completed',$1,$2)", [actor.user_id, { claimed: true }]);
      return { user_id: actor.user_id };
    }, { serializeOrganization: true });
  }
  return { departments, register, activate };
}
export type RegistrationService = ReturnType<typeof createRegistrationService>;
