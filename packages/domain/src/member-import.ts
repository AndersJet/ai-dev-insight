import { createHash, randomUUID } from 'node:crypto';
import type { Database, Queryable, Transaction } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import type { IdentityService } from './identity.js';
import type { FileMember, ParsedMembers } from './member-file.js';
import { authorize } from './authorization.js';
import { DomainError } from './errors.js';
type Mode = 'insert_only' | 'upsert';
type Action = 'create' | 'update' | 'skip' | 'unchanged' | 'error';
export interface ImportRow extends FileMember { action: Action; user_id?: string; expected_version?: number; expected_department_id?: string | null; expected_eligible?: boolean | null; retained_eligibility_to?: string | null; attach?: boolean; changes: string[]; before?: { display_name: string; eligible: boolean | null; department_id: string | null } }
export interface ImportCounts { create: number; update: number; skip: number; unchanged: number; error: number }
interface Batch { id: string; creator_id: string; creator_auth_version: number; department_id: string; department_version: number; mode: Mode; source_name: string; rows: ImportRow[]; counts: ImportCounts; preview_hash: string; status: 'previewed' | 'queued' | 'succeeded' | 'failed'; expires_at: Date; job_id: string | null }
interface Existing { id: string; version: number; status: string; display_name: string; department_id: string | null; eligible: boolean | null; eligible_until: Date | null; future: boolean }
export function createMemberImportService(db: Database, identity: IdentityService, options: { clock?: () => Date } = {}) {
  const now = options.clock ?? (() => new Date());
  function access(actor: CurrentUser, departmentId: string) { if (!authorize(actor, 'members:manage', { departmentId })) throw new DomainError('forbidden', 403); }
  async function existing(sql: Queryable, email: string): Promise<Existing | undefined> {
    return (await sql.query<Existing>(`SELECT u.id,u.version,u.status,u.display_name,
      (SELECT department_id FROM membership_periods WHERE user_id=u.id AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)) AS department_id,
      (SELECT included FROM eligibility_periods WHERE user_id=u.id AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)) AS eligible,
      (SELECT valid_to FROM eligibility_periods WHERE user_id=u.id AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2)) AS eligible_until,
      EXISTS(SELECT 1 FROM membership_periods WHERE user_id=u.id AND valid_from>$2) AS future FROM users u WHERE email_key=$1`, [email, now()])).rows[0];
  }
  async function batch(sql: Queryable, id: string, lock = false): Promise<Batch> {
    const value = (await sql.query<Batch>(`SELECT * FROM import_batches WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!value) throw new DomainError('not_found', 404); return value;
  }
  async function validateSnapshot(sql: Transaction, value: Batch) {
    if (value.expires_at <= now()) throw new DomainError('preview_expired', 409);
    const dept = (await sql.query<{ version: number }>('SELECT version FROM departments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [value.department_id])).rows[0];
    if (!dept || dept.version !== value.department_version) throw new DomainError('preview_stale', 409);
    for (const row of value.rows) {
      const current = await existing(sql, row.email);
      if (row.user_id ? !current || current.id !== row.user_id || current.version !== row.expected_version : !!current) throw new DomainError('preview_stale', 409);
      if (current && (current.status === 'deleted' || current.department_id !== row.expected_department_id || (row.eligible !== undefined && current.eligible !== row.expected_eligible))) throw new DomainError('preview_stale', 409);
    }
  }
  async function preview(token: string, departmentId: string, mode: Mode, parsed: ParsedMembers, filename: string) {
    const actor = await identity.requireUser(token); access(actor, departmentId);
    if (!['insert_only', 'upsert'].includes(mode) || !parsed.rows.length || parsed.rows.length > 2000) throw new DomainError('invalid_import', 422);
    if (parsed.departmentId && parsed.departmentId !== departmentId) throw new DomainError('template_department_mismatch', 422);
    const dept = (await db.query<{ version: number }>('SELECT version FROM departments WHERE id=$1 AND deleted_at IS NULL', [departmentId])).rows[0]; if (!dept) throw new DomainError('not_found', 404);
    if (parsed.rows.some(row => row.eligible !== undefined || row.eligibility_from !== undefined || row.eligibility_to !== undefined)) throw new DomainError('manual_eligibility_removed',422);
    const rows: ImportRow[] = []; const seen = new Map<string, number>();
    for (const input of parsed.rows) {
      const row: ImportRow = { ...input, errors: [...input.errors], action: 'create', changes: [] };
      try { row.email = identity.normalizeEmail(row.email); } catch { row.errors.push('invalid_email'); }
      if (row.display_name && (row.display_name.length > 128 || Array.from(row.display_name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) row.errors.push('invalid_name');
      if (row.eligibility_to && Date.parse(row.eligibility_to) <= Date.parse(row.eligibility_from ?? now().toISOString())) row.errors.push('invalid_date_range');
      const current = row.errors.length ? undefined : await existing(db, row.email);
      if (current) {
        row.user_id = current.id; row.expected_version = current.version; row.expected_department_id = current.department_id; row.expected_eligible = current.eligible;
        row.retained_eligibility_to = current.eligible_until?.toISOString() ?? null;
        const until = row.eligibility_to === undefined ? row.retained_eligibility_to : row.eligibility_to;
        if (row.eligible !== undefined && until && Date.parse(until) <= Date.parse(row.eligibility_from ?? now().toISOString())) row.errors.push('invalid_date_range');
        if (current.status === 'deleted') row.errors.push('account_deleted');
        else if (current.department_id && current.department_id !== departmentId || !current.department_id && current.future) row.errors.push('cross_department');
        else if (mode === 'insert_only') row.action = 'skip';
        else {
          if (!current.department_id) { row.attach = true; row.changes.push('department'); }
          if (row.display_name !== undefined && row.display_name !== current.display_name) row.changes.push('display_name');
          if (row.eligible !== undefined && (row.eligible !== current.eligible || row.eligibility_from !== undefined || row.eligibility_to !== undefined)) row.changes.push('eligibility');
          row.action = row.changes.length ? 'update' : 'unchanged';
        }
        if (!row.errors.length) row.before = { display_name: current.display_name, eligible: current.eligible, department_id: current.department_id };
      } else if (!row.display_name) row.errors.push('name_required');
      seen.set(row.email, (seen.get(row.email) ?? 0) + 1); rows.push(row);
    }
    const counts: ImportCounts = { create: 0, update: 0, skip: 0, unchanged: 0, error: 0 };
    for (const row of rows) { if ((seen.get(row.email) ?? 0) > 1) row.errors.push('duplicate_email'); if (row.errors.length) row.action = 'error'; counts[row.action]++; }
    const id = randomUUID(); const hash = createHash('sha256').update(JSON.stringify({ departmentId, version: dept.version, mode, rows })).digest('hex');
    await identity.mutate(token, async (client, fresh) => {
      access(fresh, departmentId); const auth = (await client.query<{ auth_version: number }>('SELECT auth_version FROM users WHERE id=$1', [fresh.user_id])).rows[0]!;
      const currentDept = (await client.query<{ version: number }>('SELECT version FROM departments WHERE id=$1 AND deleted_at IS NULL', [departmentId])).rows[0]; if (currentDept?.version !== dept.version) throw new DomainError('preview_stale', 409);
      await client.query('INSERT INTO import_batches(id,creator_id,creator_auth_version,department_id,department_version,mode,source_name,rows,counts,preview_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, fresh.user_id, auth.auth_version, departmentId, dept.version, mode, filename.replaceAll('\\', '/').split('/').at(-1)!.slice(0, 255), JSON.stringify(rows), counts, hash, new Date(now().getTime() + 24 * 3600_000)]);
    }, { checkAccess: user => access(user, departmentId), serializeOrganization: true });
    return get(token, id);
  }
  async function get(token: string, id: string) {
    const actor = await identity.requireUser(token); const value = await batch(db, id);
    if (actor.user_id !== value.creator_id && !actor.roles.includes('super')) throw new DomainError('not_found', 404); access(actor, value.department_id);
    if (value.expires_at <= now()) throw new DomainError('preview_expired', 409);
    const storedJob = value.job_id ? (await db.query<{ status: string; error_code: string | null; progress: Partial<ImportCounts>; attempt: number }>('SELECT status,error_code,progress,attempt FROM jobs WHERE id=$1', [value.job_id])).rows[0] ?? null : null;
    const progress: Partial<ImportCounts> = {};
    for (const key of ['create', 'update', 'skip', 'unchanged', 'error'] as const) if (typeof storedJob?.progress[key] === 'number') progress[key] = storedJob.progress[key];
    const job = storedJob ? { ...storedJob, progress } : null;
    return { ...value, job, can_submit: actor.user_id === value.creator_id && value.status === 'previewed' && value.counts.error === 0 };
  }
  async function submit(token: string, id: string, previewHash: string, key: string) {
    const value = await get(token, id); if (!key || key.length > 128) throw new DomainError('invalid_request', 400);
    return identity.mutate(token, async (client, actor) => {
      const current = await batch(client, id, true); if (actor.user_id !== current.creator_id) throw new DomainError('forbidden', 403);
      const authority = (await client.query<{ auth_version: number }>('SELECT auth_version FROM users WHERE id=$1', [actor.user_id])).rows[0];
      if (authority?.auth_version !== current.creator_auth_version) throw new DomainError('preview_stale', 409);
      if (current.preview_hash !== previewHash) throw new DomainError('preview_stale', 409);
      if (current.job_id) return { job_id: current.job_id };
      if (current.counts.error) throw new DomainError('import_has_errors', 422);
      await validateSnapshot(client, current);
      const jobId = randomUUID();
      await client.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'member_import',$2,$3)", [jobId, `import:${id}`, { batch_id: id }]);
      await client.query("UPDATE import_batches SET status='queued',job_id=$2,idempotency_key=$3 WHERE id=$1", [id, jobId, key]);
      return { job_id: jobId };
    }, { checkAccess: actor => access(actor, value.department_id), serializeOrganization: true, lockUserIds: value.rows.flatMap(row => row.user_id ? [row.user_id] : []) });
  }
  async function qualification(client: Transaction, userId: string, row: ImportRow, at: Date) {
    if (row.eligible === undefined) return;
    const from = new Date(row.eligibility_from ?? at); const until = row.eligibility_to === undefined ? row.retained_eligibility_to : row.eligibility_to; const to = until ? new Date(until) : null;
    const overlaps = (await client.query<{ id: string; included: boolean; valid_from: Date; valid_to: Date | null }>("SELECT id,included,valid_from,valid_to FROM eligibility_periods WHERE user_id=$1 AND tstzrange(valid_from,valid_to,'[)') && tstzrange($2,$3,'[)') FOR UPDATE", [userId, from, to])).rows;
    for (const old of overlaps) {
      await client.query('DELETE FROM eligibility_periods WHERE id=$1', [old.id]);
      if (old.valid_from < from) await client.query('INSERT INTO eligibility_periods(user_id,included,valid_from,valid_to) VALUES($1,$2,$3,$4)', [userId, old.included, old.valid_from, from]);
      if (to && (!old.valid_to || old.valid_to > to)) await client.query('INSERT INTO eligibility_periods(user_id,included,valid_from,valid_to) VALUES($1,$2,$3,$4)', [userId, old.included, to, old.valid_to]);
    }
    if (row.eligible !== null) await client.query('INSERT INTO eligibility_periods(user_id,included,valid_from,valid_to) VALUES($1,$2,$3,$4)', [userId, row.eligible, from, to]);
  }
  async function runOne(): Promise<boolean> {
    const claimed = await db.transaction(async client => {
      const row = (await client.query<{ id: string; payload: { batch_id: string }; attempt: number }>("SELECT id,payload,attempt FROM jobs WHERE kind='member_import' AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!row) return null; const lease = randomUUID();
      await client.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '30 seconds',attempt=attempt+1 WHERE id=$1", [row.id, lease]); return { ...row, lease };
    });
    if (!claimed) return false;
    try {
      const initial = await batch(db, claimed.payload.batch_id);
      await identity.mutateJob(initial.creator_id, initial.creator_auth_version, async (client, actor) => {
        const job = (await client.query<{ lease_token: string; status: string }>('SELECT lease_token,status FROM jobs WHERE id=$1 FOR UPDATE', [claimed.id])).rows[0];
        if (job?.lease_token !== claimed.lease || job.status !== 'running') throw new DomainError('stale_job', 409);
        const current = await batch(client, initial.id, true);
        if (current.job_id !== claimed.id || current.status !== 'queued' || current.counts.error) throw new DomainError('invalid_import_job', 409);
        await validateSnapshot(client, current); const at = now();
        for (const row of current.rows) {
          if (!['create', 'update'].includes(row.action)) continue;
          const userId = row.user_id ?? randomUUID();
          if (row.action === 'create') await client.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [userId, row.email, row.display_name]);
          else await client.query('UPDATE users SET display_name=COALESCE($2,display_name),version=version+1 WHERE id=$1', [userId, row.display_name ?? null]);
          if (row.action === 'create' || row.attach) await client.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [userId, current.department_id, at]);
          if (row.action === 'create' || row.changes.includes('eligibility')) await qualification(client, userId, row, at);
          await client.query("INSERT INTO audit_events(actor_id,action,target_id,scope_id,metadata) VALUES($1,'member_imported',$2,$3,$4)", [actor.user_id, userId, current.department_id, { batch_id: current.id, row: row.row, action: row.action }]);
        }
        if (current.counts.create || current.rows.some(row => row.attach)) await client.query('UPDATE departments SET version=version+1 WHERE id=$1', [current.department_id]);
        await client.query("UPDATE import_batches SET status='succeeded' WHERE id=$1", [current.id]);
        await client.query("UPDATE jobs SET status='succeeded',progress=$2,lease_until=NULL WHERE id=$1", [claimed.id, current.counts]);
      }, { checkAccess: actor => access(actor, initial.department_id), lockUserIds: initial.rows.flatMap(row => row.user_id ? [row.user_id] : []) });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'import_failed';
      const retry = ['55P03', '40001', '40P01', '57014', 'database_io_timeout', 'database_unavailable'].includes(code) && claimed.attempt < 2;
      await db.transaction(async client => {
        const updated = await client.query("UPDATE jobs SET status=$3,error_code=$4,lease_until=NULL,available_at=now()+interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id", [claimed.id, claimed.lease, retry ? 'queued' : 'failed', code]);
        if (updated.rowCount && !retry) await client.query("UPDATE import_batches SET status='failed' WHERE job_id=$1", [claimed.id]);
      });
    }
    return true;
  }
  async function authorizeDepartment(token: string, departmentId: string) {
    access(await identity.requireUser(token), departmentId);
    const department = (await db.query<{ id: string; name: string }>('SELECT id,name FROM departments WHERE id=$1 AND deleted_at IS NULL', [departmentId])).rows[0];
    if (!department) throw new DomainError('not_found', 404); return department;
  }
  async function getJob(token: string, id: string) {
    const row = (await db.query<{ payload: { batch_id: string } }>("SELECT payload FROM jobs WHERE id=$1 AND kind='member_import'", [id])).rows[0];
    if (!row) throw new DomainError('not_found', 404); const value = await get(token, row.payload.batch_id);
    return { id, ...value.job!, batch_id: value.id };
  }
  async function recent(token: string, departmentId: string) {
    const actor = await identity.requireUser(token); access(actor, departmentId);
    return (await db.query<{ id: string; source_name: string; status: string; created_at: Date; expires_at: Date }>('SELECT id,source_name,status,created_at,expires_at FROM import_batches WHERE department_id=$1 AND (creator_id=$2 OR $3::boolean) ORDER BY created_at DESC,id LIMIT 10', [departmentId, actor.user_id, actor.roles.includes('super')])).rows;
  }
  return { preview, get, submit, runOne, authorizeDepartment, getJob, recent };
}
export type MemberImportService = ReturnType<typeof createMemberImportService>;
