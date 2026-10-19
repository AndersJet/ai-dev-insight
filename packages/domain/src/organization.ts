import { randomUUID } from 'node:crypto';
import type { Database, Queryable, Transaction } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import type { IdentityService } from './identity.js';
import { authorize } from './authorization.js';
import { DomainError } from './errors.js';
import { createCursorCodec } from './cursor.js';

export interface Department { id: string; name: string; version: number; member_count: number; pending_member_count: number; admins: { user_id: string; display_name: string }[] }
interface ScheduledTransfer { department_id: string; department_name: string; effective_at: string }
export interface Member { user_id: string; email: string; display_name: string; status: string; version: number; department_id: string | null; department_name: string | null; eligible: boolean | null; scheduled_transfer: ScheduledTransfer | null }
export function createOrganizationService(db: Database, identity: IdentityService, options: { clock?: () => Date } = {}) {
  const now = options.clock ?? (() => new Date());
  const cursors = createCursorCodec(now);
  function name(value: string) { const result = value.trim(); if (!result || result.length > 128) throw new DomainError('invalid_name', 422); return result; }
  function membersPermission(actor: CurrentUser, id: string) { if (!authorize(actor, 'members:manage', { departmentId: id })) throw new DomainError('forbidden', 403); }
  function departmentPermission(actor: CurrentUser) { if (!authorize(actor, 'departments:manage')) throw new DomainError('forbidden', 403); }
  async function scheduled(sql: Queryable, userId: string, at: Date) {
    return (await sql.query<{ value: ScheduledTransfer }>("SELECT jsonb_build_object('department_id',m.department_id,'department_name',d.name,'effective_at',m.valid_from) AS value FROM membership_periods m JOIN departments d ON d.id=m.department_id WHERE m.user_id=$1 AND m.valid_from>$2 ORDER BY m.valid_from LIMIT 1", [userId, at])).rows[0]?.value ?? null;
  }
  async function department(sql: Queryable, id: string, lock = false) {
    const result = await sql.query<{ id: string; name: string; version: number }>(`SELECT id,name,version FROM departments WHERE id=$1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!result.rows[0]) throw new DomainError('not_found', 404); return result.rows[0];
  }
  async function audit(sql: Transaction, actor: CurrentUser, action: string, targetId: string, scopeId: string, metadata: Record<string, unknown> = {}) {
    await sql.query('INSERT INTO audit_events(actor_id,action,target_id,scope_id,metadata) VALUES($1,$2,$3,$4,$5)', [actor.user_id, action, targetId, scopeId, metadata]);
  }
  async function listDepartments(token: string): Promise<Department[]> {
    const actor = await identity.requireUser(token);
    const all = authorize(actor, 'departments:manage');
    return (await db.query<Department>(`SELECT d.id,d.name,d.version,count(m.id)::int AS member_count,
      (SELECT count(*)::int FROM membership_periods p WHERE p.department_id=d.id AND p.valid_from>$1) AS pending_member_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',u.id,'display_name',u.display_name) ORDER BY u.display_name,u.id) FROM role_grants g JOIN users u ON u.id=g.user_id WHERE g.scope_id=d.id AND g.valid_from<=$1 AND (g.valid_to IS NULL OR g.valid_to>$1)), '[]'::jsonb) AS admins FROM departments d
      LEFT JOIN membership_periods m ON m.department_id=d.id AND m.valid_from<=$1 AND (m.valid_to IS NULL OR m.valid_to>$1)
      WHERE d.deleted_at IS NULL AND ($2::boolean OR d.id=ANY($3::uuid[])) GROUP BY d.id ORDER BY d.name,d.id`, [now(), all, actor.managed_departments.map(item => item.id)])).rows;
  }
  async function createDepartment(token: string, value: string) {
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const id = randomUUID();
      const result = await client.query<{ id: string; name: string; version: number }>('INSERT INTO departments(id,name) VALUES($1,$2) RETURNING id,name,version', [id, name(value)]);
      await audit(client, actor, 'department_created', id, id); return result.rows[0]!;
    }, { serializeOrganization: true, checkAccess: departmentPermission });
  }
  async function renameDepartment(token: string, id: string, value: string, version: number) {
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const existing = await department(client, id, true);
      if (existing.version !== version) throw new DomainError('version_conflict', 409);
      const result = await client.query<{ id: string; name: string; version: number }>('UPDATE departments SET name=$2,version=version+1 WHERE id=$1 RETURNING id,name,version', [id, name(value)]);
      await audit(client, actor, 'department_renamed', id, id, { old_name: existing.name, new_name: name(value) }); return result.rows[0]!;
    }, { serializeOrganization: true, checkAccess: departmentPermission });
  }
  async function deleteDepartment(token: string, id: string, version: number) {
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const existing = await department(client, id, true);
      // Future scheduled memberships also prevent deleting the department they target.
      if ((await client.query('SELECT 1 FROM membership_periods WHERE department_id=$1 AND (valid_to IS NULL OR valid_to>$2) LIMIT 1', [id, now()])).rowCount) throw new DomainError('department_not_empty', 409);
      if (existing.version !== version) throw new DomainError('version_conflict', 409);
      await client.query('UPDATE departments SET deleted_at=$2,version=version+1 WHERE id=$1', [id, now()]);
      await client.query('UPDATE users SET auth_version=auth_version+1 WHERE id IN(SELECT user_id FROM role_grants WHERE scope_id=$1 AND (valid_to IS NULL OR valid_to>$2))', [id, now()]);
      await client.query('DELETE FROM role_grants WHERE scope_id=$1 AND valid_from>=$2', [id, now()]);
      await client.query('UPDATE role_grants SET valid_to=$2 WHERE scope_id=$1 AND valid_from<$2 AND (valid_to IS NULL OR valid_to>$2)', [id, now()]);
      await audit(client, actor, 'department_deleted', id, id);
    }, { serializeOrganization: true, checkAccess: departmentPermission, lockUserIds: async client => (await client.query<{ user_id: string }>('SELECT user_id FROM role_grants WHERE scope_id=$1', [id])).rows.map(row => row.user_id) });
  }
  async function listMembers(token: string, id: string | undefined, paging: { limit?: number; cursor?: string; search?: string; adoption?: 'pending'|'adopted'|'unregistered'; status?: 'active'|'suspended'|'deleted' } = {}) {
    const actor = await identity.requireUser(token);
    if (id) { membersPermission(actor, id); await department(db, id); } else departmentPermission(actor);
    const limit = paging.limit ?? 50; const search = paging.search?.trim() ?? '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || search.length > 128) throw new DomainError('invalid_request', 400);
    const scope = JSON.stringify([actor.user_id, id ?? null, search, limit, paging.adoption ?? null, paging.status ?? null]);
    const after = paging.cursor ? cursors.decode(paging.cursor, scope) : null;
    const pattern = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const rows = (await db.query<Member & { total: number }>(`SELECT * FROM (SELECT u.id AS user_id,u.email_key AS email,u.display_name,u.status,u.version,m.department_id,d.name AS department_name,CASE WHEN u.registered_at IS NULL THEN NULL ELSE u.adopted_at IS NOT NULL END AS eligible,u.registered_at,u.adopted_at,
      (SELECT created_at FROM audit_events WHERE target_id=u.id AND action='account_status_changed' ORDER BY created_at DESC,id DESC LIMIT 1) AS status_since,
      (SELECT metadata->>'reason' FROM audit_events WHERE target_id=u.id AND action='account_status_changed' ORDER BY created_at DESC,id DESC LIMIT 1) AS status_reason,
      (SELECT actor.display_name FROM audit_events a LEFT JOIN users actor ON actor.id=a.actor_id WHERE a.target_id=u.id AND a.action='account_status_changed' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS status_actor,(count(*) OVER())::int AS total,
      COALESCE((SELECT g.role FROM role_grants g LEFT JOIN departments gd ON gd.id=g.scope_id WHERE g.user_id=u.id AND g.valid_from<=$2 AND (g.valid_to IS NULL OR g.valid_to>$2) AND (g.scope_id IS NULL OR gd.deleted_at IS NULL) ORDER BY CASE g.role WHEN 'super' THEN 0 WHEN 'anc_admin' THEN 1 ELSE 2 END LIMIT 1),'employee') AS primary_role,
      (SELECT jsonb_build_object('department_id',p.department_id,'department_name',pd.name,'effective_at',p.valid_from) FROM membership_periods p JOIN departments pd ON pd.id=p.department_id WHERE p.user_id=u.id AND p.valid_from>$2 ORDER BY p.valid_from LIMIT 1) AS scheduled_transfer
      FROM users u LEFT JOIN membership_periods m ON m.user_id=u.id AND m.valid_from<=$2 AND (m.valid_to IS NULL OR m.valid_to>$2)

      LEFT JOIN departments d ON d.id=m.department_id WHERE ($1::uuid IS NULL OR m.department_id=$1)
      AND (u.email_key ILIKE $4 OR u.display_name ILIKE $4)
      AND ($6::text IS NULL OR ($6='pending' AND u.registered_at IS NOT NULL AND u.adopted_at IS NULL) OR ($6='adopted' AND u.adopted_at IS NOT NULL) OR ($6='unregistered' AND u.registered_at IS NULL)) AND ($7::text IS NULL OR u.status=$7)) matched WHERE ($3::uuid IS NULL OR user_id>$3) ORDER BY user_id LIMIT $5`, [id ?? null, now(), after, pattern, limit + 1, paging.adoption ?? null, paging.status ?? null])).rows;
    const items = rows.slice(0, limit); const has_more = rows.length > limit;
    return { items, total: rows[0]?.total ?? 0, has_more, next_cursor: has_more ? cursors.encode(scope, items.at(-1)!.user_id) : null };
  }
  async function addMember(token: string, id: string, input: { email: string; display_name?: string; eligible?: boolean | null; attach_existing?: boolean }): Promise<Member> {
    if (input.eligible !== undefined) throw new DomainError('manual_eligibility_removed',422);
    const email = identity.normalizeEmail(input.email);
    return identity.mutate(token, async (client, actor) => {
      membersPermission(actor, id); const targetDepartment = await department(client, id, true);
      const existing = (await client.query<Member>('SELECT id AS user_id,email_key AS email,display_name,status,version FROM users WHERE email_key=$1', [email])).rows[0];
      let member: Member;
      if (existing) {
        if (existing.status === 'deleted') throw new DomainError('account_deleted', 409);
        if ((await client.query('SELECT 1 FROM membership_periods WHERE user_id=$1 AND (valid_to IS NULL OR valid_to>$2) LIMIT 1', [existing.user_id, now()])).rowCount) throw new DomainError('membership_conflict', 409);
        if (!input.attach_existing) throw new DomainError('email_exists', 409);
        const updated = await client.query<Member>('UPDATE users SET version=version+1 WHERE id=$1 RETURNING id AS user_id,email_key AS email,display_name,status,version', [existing.user_id]); member = updated.rows[0]!;
      } else {
        const created = await client.query<Member>('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3) RETURNING id AS user_id,email_key AS email,display_name,status,version', [randomUUID(), email, name(input.display_name ?? '')]); member = created.rows[0]!;
        if (typeof input.eligible === 'boolean') await client.query('INSERT INTO eligibility_periods(user_id,included,valid_from) VALUES($1,$2,$3)', [member.user_id, input.eligible, now()]);
      }
      await client.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [member.user_id, id, now()]);
      await client.query('UPDATE departments SET version=version+1 WHERE id=$1', [id]);
      const qualification = (await client.query<{ included: boolean }>('SELECT included FROM eligibility_periods WHERE user_id=$1 AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)', [member.user_id, now()])).rows[0];
      await audit(client, actor, 'member_added', member.user_id, id); return { ...member, department_id: id, department_name: targetDepartment.name, eligible: qualification?.included ?? null, scheduled_transfer: null };
    }, { serializeOrganization: true, checkAccess: actor => membersPermission(actor, id), lockUserIds: async client => (await client.query<{ id: string }>('SELECT id FROM users WHERE email_key=$1', [email])).rows.map(row => row.id) });
  }
  async function removeMember(token: string, departmentId: string, userId: string, version: number) {
    return identity.mutate(token, async (client, actor) => {
      membersPermission(actor, departmentId); await department(client, departmentId, true);
      const user = (await client.query<{ version: number }>('SELECT version FROM users WHERE id=$1', [userId])).rows[0];
      const membership = (await client.query<{ id: string; valid_from: Date }>('SELECT id,valid_from FROM membership_periods WHERE user_id=$1 AND department_id=$2 AND valid_from<=$3 AND (valid_to IS NULL OR valid_to>$3) FOR UPDATE', [userId, departmentId, now()])).rows[0];
      if (!user || !membership) throw new DomainError('not_found', 404);
      if (user.version !== version) throw new DomainError('version_conflict', 409);
      const end = now();
      await client.query('UPDATE membership_periods SET valid_to=$2 WHERE id=$1', [membership.id, end]);
      await client.query('UPDATE users SET version=version+1 WHERE id=$1', [userId]);
      await client.query('UPDATE departments SET version=version+1 WHERE id=$1', [departmentId]);
      await audit(client, actor, 'member_removed', userId, departmentId);
    }, { serializeOrganization: true, checkAccess: actor => membersPermission(actor, departmentId), lockUserIds: [userId] });
  }
  async function setDepartmentAdmins(token: string, id: string, userIds: readonly string[], version: number) {
    if (userIds.length > 500 || new Set(userIds).size !== userIds.length) throw new DomainError('invalid_request', 400);
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const existing = await department(client, id, true);
      if (existing.version !== version) throw new DomainError('version_conflict', 409);
      const targets = await client.query<{ id: string }>("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active'", [userIds]);
      if (targets.rowCount !== userIds.length) throw new DomainError('invalid_admin', 422);
      const at = now();
      const old = await client.query<{ user_id: string; valid_from: Date }>('SELECT user_id,valid_from FROM role_grants WHERE scope_id=$1 AND (valid_to IS NULL OR valid_to>$2)', [id, at]);
      const current = new Set(old.rows.filter(row => row.valid_from <= at).map(row => row.user_id));
      const desired = new Set(userIds);
      const removed = [...new Set(old.rows.map(row => row.user_id))].filter(userId => !desired.has(userId));
      const added = userIds.filter(userId => !current.has(userId));
      const affected = [...new Set([...removed, ...added, ...old.rows.filter(row => row.valid_from > at).map(row => row.user_id)])];
      await client.query('DELETE FROM role_grants WHERE scope_id=$1 AND (valid_from>$2 OR (valid_from=$2 AND user_id=ANY($3::uuid[])))', [id, at, removed]);
      await client.query('UPDATE role_grants SET valid_to=$2 WHERE scope_id=$1 AND user_id=ANY($3::uuid[]) AND valid_from<$2 AND (valid_to IS NULL OR valid_to>$2)', [id, at, removed]);
      await client.query("INSERT INTO role_grants(user_id,role,scope_id,valid_from) SELECT unnest($1::uuid[]),'department_admin',$2,$3", [added, id, at]);
      await client.query('UPDATE users SET auth_version=auth_version+1,version=version+1 WHERE id=ANY($1::uuid[])', [affected]);
      const result = await client.query<{ id: string; name: string; version: number }>('UPDATE departments SET version=version+1 WHERE id=$1 RETURNING id,name,version', [id]);
      await audit(client, actor, 'department_admins_changed', id, id, { user_ids: userIds }); return result.rows[0]!;
    }, { serializeOrganization: true, checkAccess: departmentPermission, lockUserIds: async client => [...userIds, ...(await client.query<{ user_id: string }>('SELECT user_id FROM role_grants WHERE scope_id=$1', [id])).rows.map(row => row.user_id)] });
  }
  async function updateMember(token: string, departmentId: string, userId: string, input: { version: number; display_name?: string; eligible?: boolean | null }) {
    if (input.eligible !== undefined) throw new DomainError('manual_eligibility_removed',422);
    return identity.mutate(token, async (client, actor) => {
      membersPermission(actor, departmentId); const target = await department(client, departmentId, true); const at = now();
      const user = (await client.query<Member>(`SELECT u.id AS user_id,u.email_key AS email,u.display_name,u.status,u.version FROM users u JOIN membership_periods m ON m.user_id=u.id
        WHERE u.id=$1 AND m.department_id=$2 AND m.valid_from<=$3 AND (m.valid_to IS NULL OR m.valid_to>$3)`, [userId, departmentId, at])).rows[0];
      if (!user) throw new DomainError('not_found', 404);
      if (user.version !== input.version) throw new DomainError('version_conflict', 409);
      const old = (await client.query<{ id: string; included: boolean; valid_from: Date }>('SELECT id,included,valid_from FROM eligibility_periods WHERE user_id=$1 AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2) FOR UPDATE', [userId, at])).rows[0];
      if (input.eligible !== undefined && input.eligible !== (old?.included ?? null)) {
        if (old) {
          if (old.valid_from >= at) await client.query('DELETE FROM eligibility_periods WHERE id=$1', [old.id]);
          else await client.query('UPDATE eligibility_periods SET valid_to=$2 WHERE id=$1', [old.id, at]);
        }
        if (input.eligible !== null) await client.query('INSERT INTO eligibility_periods(user_id,included,valid_from) VALUES($1,$2,$3)', [userId, input.eligible, at]);
      }
      const updated = await client.query<Member>('UPDATE users SET display_name=$2,version=version+1 WHERE id=$1 RETURNING id AS user_id,email_key AS email,display_name,status,version', [userId, input.display_name === undefined ? user.display_name : name(input.display_name)]);
      await audit(client, actor, 'member_updated', userId, departmentId, { eligible_before: old?.included ?? null, eligible_after: input.eligible === undefined ? old?.included ?? null : input.eligible, qualification_changed: input.eligible !== undefined && input.eligible !== (old?.included ?? null) });
      return { ...updated.rows[0]!, department_id: departmentId, department_name: target.name, eligible: input.eligible === undefined ? old?.included ?? null : input.eligible, scheduled_transfer: await scheduled(client, userId, at) };
    }, { serializeOrganization: true, checkAccess: actor => membersPermission(actor, departmentId), lockUserIds: [userId] });
  }
  async function transferMember(token: string, userId: string, input: { target_department_id: string; version: number; effective_at?: string }) {
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const at = now(); const effective = input.effective_at ? new Date(input.effective_at) : at;
      if (!Number.isFinite(effective.getTime()) || effective < at) throw new DomainError('invalid_effective_at', 422);
      const user = (await client.query<{ version: number; status: string }>('SELECT version,status FROM users WHERE id=$1', [userId])).rows[0];
      if (!user) throw new DomainError('not_found', 404);
      if (user.status === 'deleted') throw new DomainError('account_deleted', 409);
      if (user.version !== input.version) throw new DomainError('version_conflict', 409);
      await department(client, input.target_department_id, true);
      if ((await client.query('SELECT 1 FROM membership_periods WHERE user_id=$1 AND valid_from>$2 LIMIT 1', [userId, at])).rowCount) throw new DomainError('pending_transfer', 409);
      const old = (await client.query<{ id: string; department_id: string; valid_from: Date }>('SELECT id,department_id,valid_from FROM membership_periods WHERE user_id=$1 AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2) FOR UPDATE', [userId, at])).rows[0];
      if (old?.department_id === input.target_department_id) throw new DomainError('same_department', 422);
      if (old && effective <= old.valid_from) throw new DomainError('invalid_effective_at', 422);
      if (old) await client.query('UPDATE membership_periods SET valid_to=$2 WHERE id=$1', [old.id, effective]);
      await client.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [userId, input.target_department_id, effective]);
      await client.query('UPDATE users SET version=version+1 WHERE id=$1', [userId]);
      await client.query('UPDATE departments SET version=version+1 WHERE id=ANY($1::uuid[])', [[input.target_department_id, ...(old ? [old.department_id] : [])]]);
      await audit(client, actor, 'member_transferred', userId, input.target_department_id, { from_department: old?.department_id ?? null, effective_at: effective.toISOString() });
      return { user_id: userId, target_department_id: input.target_department_id, effective_at: effective.toISOString(), version: input.version + 1 };
    }, { serializeOrganization: true, checkAccess: departmentPermission, lockUserIds: [userId] });
  }
  async function cancelTransfer(token: string, userId: string, version: number) {
    return identity.mutate(token, async (client, actor) => {
      departmentPermission(actor); const at = now();
      const user = (await client.query<{ version: number }>('SELECT version FROM users WHERE id=$1', [userId])).rows[0];
      if (!user) throw new DomainError('not_found', 404); if (user.version !== version) throw new DomainError('version_conflict', 409);
      const pending = (await client.query<{ id: string; department_id: string; valid_from: Date }>('SELECT id,department_id,valid_from FROM membership_periods WHERE user_id=$1 AND valid_from>$2 ORDER BY valid_from LIMIT 1 FOR UPDATE', [userId, at])).rows[0];
      if (!pending) throw new DomainError('not_found', 404);
      await client.query('DELETE FROM membership_periods WHERE id=$1', [pending.id]);
      const previous = await client.query<{ department_id: string }>('UPDATE membership_periods SET valid_to=NULL WHERE user_id=$1 AND valid_to=$2 AND valid_from<=$3 RETURNING department_id', [userId, pending.valid_from, at]);
      await client.query('UPDATE users SET version=version+1 WHERE id=$1', [userId]);
      await client.query('UPDATE departments SET version=version+1 WHERE id=ANY($1::uuid[])', [[pending.department_id, ...previous.rows.map(row => row.department_id)]]);
      await audit(client, actor, 'transfer_cancelled', userId, pending.department_id); return { version: version + 1 };
    }, { serializeOrganization: true, checkAccess: departmentPermission, lockUserIds: [userId] });
  }
  return { listDepartments, createDepartment, renameDepartment, deleteDepartment, listMembers, addMember, removeMember, setDepartmentAdmins, updateMember, transferMember, cancelTransfer };
}
export type OrganizationService = ReturnType<typeof createOrganizationService>;
