import type { CurrentUser } from '@adi/contracts';

export type Actor = Pick<CurrentUser, 'user_id' | 'roles' | 'managed_departments'>;
export type AccessTarget = { userId?: string; departmentId?: string };
export type Action = 'statistics:read' | 'content:read' | 'members:manage' | 'departments:manage' | 'system:manage' | 'users:security';
export function authorize(actor: Actor, action: Action, target: AccessTarget = {}): boolean {
  if (!['statistics:read', 'content:read', 'members:manage', 'departments:manage', 'system:manage', 'users:security'].includes(action)) return false;
  if (actor.roles.includes('super')) return true;
  if (action === 'content:read') return target.userId === actor.user_id;
  if (actor.roles.includes('anc_admin') && ['departments:manage', 'members:manage', 'statistics:read'].includes(action)) return true;
  if (action === 'statistics:read' && !target.departmentId && target.userId === actor.user_id) return true;
  if (action === 'statistics:read' || action === 'members:manage') return actor.roles.includes('department_admin') && actor.managed_departments.some(department => department.id === target.departmentId);
  return false;
}
