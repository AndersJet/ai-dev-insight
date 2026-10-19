import type { Database } from '@adi/storage';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';

export function createAdoptionService(db: Database, identity: IdentityService) {
  async function snapshot(token: string, input: { scope?: 'self' | 'organization'; department_id?: string } = {}) {
    const actor = await identity.requireUser(token);
    const self = input.scope !== 'organization';
    if (self && input.department_id) throw new DomainError('invalid_scope', 422);
    const global = actor.roles.includes('super') || actor.roles.includes('anc_admin');
    const authorized = actor.managed_departments.map(item => item.id);
    if (!self && !global && !authorized.length) throw new DomainError('forbidden',403);
    if (input.department_id && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.department_id) || (!global && !authorized.includes(input.department_id)))) throw new DomainError('forbidden',403);
    const departments = self ? null : input.department_id ? [input.department_id] : global ? null : authorized;
    const at = new Date();
    const row = (await db.query<{ registered: string; adopted: string; suspended: string; deleted: string }>(`SELECT
      count(*) FILTER(WHERE u.registered_at IS NOT NULL AND u.registered_at<=$1) AS registered,count(*) FILTER(WHERE u.registered_at IS NOT NULL AND u.registered_at<=$1 AND u.adopted_at IS NOT NULL) AS adopted,
      count(*) FILTER(WHERE u.status='suspended') AS suspended,count(*) FILTER(WHERE u.status='deleted') AS deleted
      FROM users u WHERE ($2::uuid IS NULL OR u.id=$2) AND ($3::uuid[] IS NULL OR EXISTS(
          SELECT 1 FROM membership_periods m WHERE m.user_id=u.id AND m.department_id=ANY($3) AND m.valid_from<=$1 AND (m.valid_to IS NULL OR m.valid_to>$1)))`, [at,self ? actor.user_id : null,departments])).rows[0]!;
    // A revocation during the read must not return the old actor's scope.
    const fresh = await identity.requireUser(token);
    if (JSON.stringify(fresh.roles) !== JSON.stringify(actor.roles) || JSON.stringify(fresh.managed_departments) !== JSON.stringify(actor.managed_departments)) throw new DomainError('forbidden',403);
    const registered=Number(row.registered), adopted=Number(row.adopted);
    return { as_of:at.toISOString(),registered,adopted,pending:registered-adopted,suspended:Number(row.suspended),deleted:Number(row.deleted),adoption_rate:registered ? adopted/registered : null };
  }
  return { snapshot };
}
export type AdoptionService = ReturnType<typeof createAdoptionService>;
