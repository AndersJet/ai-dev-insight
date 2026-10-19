import type { Database, Transaction } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';
import { createOrganizationService } from './organization.js';
type Status = 'active' | 'suspended' | 'deleted';
type GlobalRole = 'super' | 'anc_admin';
export function createAdministrationService(db: Database, identity: IdentityService, options: { clock?: () => Date } = {}) {
  const now = options.clock ?? (() => new Date());
  const directory = createOrganizationService(db, identity, options);
  function check(actor: CurrentUser) { if (!actor.roles.includes('super')) throw new DomainError('forbidden', 403); }
  function reason(value: string) { const clean = value.trim(); if (!clean || clean.length > 500) throw new DomainError('reason_required', 422); return clean; }
  async function target(client: Transaction, id: string, version: number) {
    const row = (await client.query<{ id: string; email_key: string; display_name: string; status: Status; management_source: string; version: number }>('SELECT id,email_key,display_name,status,management_source,version FROM users WHERE id=$1', [id])).rows[0];
    if (!row) throw new DomainError('not_found', 404); if (row.version !== version) throw new DomainError('version_conflict', 409); return row;
  }
  async function ensureSuper(client: Transaction, at: Date) {
    const candidates = await client.query<{ email_key: string }>(`SELECT DISTINCT u.email_key FROM users u JOIN credentials c ON c.user_id=u.id JOIN role_grants g ON g.user_id=u.id
      WHERE u.status='active' AND g.role='super' AND g.valid_from<=$1 AND (g.valid_to IS NULL OR g.valid_to>$1)
      AND (NOT c.must_change OR c.temporary_expires_at>$1)`, [at]);
    const valid = candidates.rows.some(row => { try { identity.normalizeEmail(row.email_key); return true; } catch { return false; } });
    if (!valid) throw new DomainError('last_super_admin', 409);
  }
  async function closeGrants(client: Transaction, id: string, at: Date, scope: 'all' | 'global' | 'department') {
    const clause = scope === 'all' ? '' : scope === 'global' ? ' AND scope_id IS NULL' : ' AND scope_id IS NOT NULL';
    await client.query(`DELETE FROM role_grants WHERE user_id=$1 AND valid_from>=$2${clause}`, [id, at]);
    await client.query(`UPDATE role_grants SET valid_to=$2 WHERE user_id=$1 AND valid_from<$2 AND (valid_to IS NULL OR valid_to>$2)${clause}`, [id, at]);
  }
  async function getAccount(token: string, id: string) {
    check(await identity.requireUser(token)); const at = now();
    const row = (await db.query<{ id: string; email: string; display_name: string; status: Status; management_source: string; version: number; credential_state: string }>(`SELECT u.id,u.email_key AS email,u.display_name,u.status,u.management_source,u.version,
      CASE WHEN c.user_id IS NULL THEN 'unissued' WHEN NOT c.must_change THEN 'ready' WHEN c.temporary_expires_at<=$2 THEN 'expired' ELSE 'temporary' END AS credential_state
      FROM users u LEFT JOIN credentials c ON c.user_id=u.id WHERE u.id=$1`, [id, at])).rows[0];
    if (!row) throw new DomainError('not_found', 404);
    const grants = (await db.query<{ role: GlobalRole | 'department_admin'; scope_id: string | null }>('SELECT role,scope_id FROM role_grants WHERE user_id=$1 AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)', [id, at])).rows;
    return { ...row, global_roles: grants.filter(grant => grant.role !== 'department_admin').map(grant => grant.role as GlobalRole), department_ids: grants.filter(grant => grant.scope_id).map(grant => grant.scope_id!) };
  }
  async function setAccess(token: string, id: string, input: { version: number; global_roles: GlobalRole[]; department_ids?: string[] }) {
    if (input.global_roles.some(role => !['super', 'anc_admin'].includes(role)) || new Set(input.global_roles).size !== input.global_roles.length || (input.department_ids && (input.department_ids.length > 500 || new Set(input.department_ids).size !== input.department_ids.length))) throw new DomainError('invalid_request', 400);
    return identity.mutate(token, async (client, actor) => {
      check(actor); const user = await target(client, id, input.version); const at = now();
      if (user.management_source === 'environment' && !input.global_roles.includes('super')) throw new DomainError('configuration_managed_account', 403);
      if (user.status !== 'active') throw new DomainError('account_inactive', 409);
      if (input.department_ids) {
        const departments = await client.query('SELECT id FROM departments WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL FOR KEY SHARE', [input.department_ids]);
        if (departments.rowCount !== input.department_ids.length) throw new DomainError('invalid_department', 422);
      }
      await closeGrants(client, id, at, 'global');
      for (const role of input.global_roles) await client.query('INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,$2,$3)', [id, role, at]);
      if (input.department_ids) {
        const oldScopes = (await client.query<{ scope_id: string }>('SELECT DISTINCT scope_id FROM role_grants WHERE user_id=$1 AND scope_id IS NOT NULL AND (valid_to IS NULL OR valid_to>$2)', [id, at])).rows.map(row => row.scope_id);
        await closeGrants(client, id, at, 'department');
        await client.query("INSERT INTO role_grants(user_id,role,scope_id,valid_from) SELECT $1,'department_admin',unnest($2::uuid[]),$3", [id, input.department_ids, at]);
        await client.query('UPDATE departments SET version=version+1 WHERE id=ANY($1::uuid[])', [[...input.department_ids, ...oldScopes]]);
      }
      await ensureSuper(client, at);
      await client.query('UPDATE users SET auth_version=auth_version+1,version=version+1 WHERE id=$1', [id]);
      await client.query('DELETE FROM login_sessions WHERE user_id=$1', [id]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'access_changed',$2,$3)", [actor.user_id, id, { global_roles: input.global_roles, department_ids: input.department_ids ?? null }]);
      return { version: input.version + 1 };
    }, { checkAccess: check, serializeOrganization: true, lockUserIds: [id] });
  }
  async function setStatus(token: string, id: string, input: { version: number; status: Status; reason: string }) {
    if (!['active', 'suspended', 'deleted'].includes(input.status)) throw new DomainError('invalid_request', 400);
    const note = reason(input.reason);
    return identity.mutate(token, async (client, actor) => {
      check(actor); const user = await target(client, id, input.version); const at = now();
      if (user.management_source === 'environment') throw new DomainError('configuration_managed_account', 403);
      if (user.status === input.status) return { version: user.version, committed_at: at.toISOString() };
      if (user.status === 'deleted' && input.status !== 'active') throw new DomainError('account_deleted', 409);
      await client.query('UPDATE users SET status=$2,auth_version=auth_version+1,ingest_epoch=ingest_epoch+1,version=version+1 WHERE id=$1', [id, input.status]);
      if (input.status === 'deleted') {
        await client.query('UPDATE departments SET version=version+1 WHERE id IN(SELECT scope_id FROM role_grants WHERE user_id=$1 AND scope_id IS NOT NULL AND (valid_to IS NULL OR valid_to>$2))', [id, at]);
        await closeGrants(client, id, at, 'all');
      }
      await ensureSuper(client, at); await client.query('DELETE FROM login_sessions WHERE user_id=$1', [id]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'account_status_changed',$2,$3)", [actor.user_id, id, { before: user.status, after: input.status, reason: note }]);
      return { version: input.version + 1, committed_at: at.toISOString() };
    }, { checkAccess: check, serializeOrganization: true, lockUserIds: [id] });
  }
  async function correctEmail(token: string, id: string, input: { version: number; email: string; verification_note: string }) {
    const email = identity.normalizeEmail(input.email); const note = reason(input.verification_note);
    return identity.mutate(token, async (client, actor) => {
      check(actor); const user = await target(client, id, input.version);
      if (user.management_source === 'environment') throw new DomainError('configuration_managed_account', 403);
      if (user.email_key === email) return { version: user.version };
      await client.query('UPDATE users SET email_key=$2,auth_version=auth_version+1,version=version+1 WHERE id=$1', [id, email]);
      await ensureSuper(client, now()); await client.query('DELETE FROM login_sessions WHERE user_id=$1', [id]);
      await client.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'email_corrected',$2,$3)", [actor.user_id, id, { before: user.email_key, after: email, verification_note: note }]);
      return { version: input.version + 1 };
    }, { checkAccess: check, serializeOrganization: true, lockUserIds: [id] });
  }
  async function listAccounts(token: string, paging: { limit?: number; cursor?: string; search?: string } = {}) {
    check(await identity.requireUser(token)); return directory.listMembers(token, undefined, paging);
  }
  return { getAccount, listAccounts, setAccess, setStatus, correctEmail };
}
export type AdministrationService = ReturnType<typeof createAdministrationService>;
