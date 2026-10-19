import type { DepartmentDto, MemberDto, MemberPage, NewMember, EditMember, TransferMember } from '@adi/contracts';
import { request } from './http.js';
type Result<T> = { data: T };
export const departments = () => request<Result<DepartmentDto[]>>('/api/v1/departments');
export const createDepartment = (name: string) => request('/api/v1/departments', 'POST', { name });
export const renameDepartment = (id: string, name: string, version: number) => request(`/api/v1/departments/${id}`, 'PATCH', { name, version });
export const deleteDepartment = (id: string, version: number) => request<void>(`/api/v1/departments/${id}`, 'DELETE', { version });
export const setAdmins = (id: string, user_ids: string[], version: number) => request(`/api/v1/departments/${id}/admins`, 'PUT', { user_ids, version });
export function members(id: string | undefined, input: { limit?: number; search?: string; cursor?: string } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') query.set(key, String(value));
  return request<Result<MemberPage>>(`${id ? `/api/v1/departments/${id}/members` : '/api/v1/members'}?${query}`);
}
export const addMember = (id: string, input: NewMember) => request<Result<MemberDto>>(`/api/v1/departments/${id}/members`, 'POST', input);
export const updateMember = (id: string, userId: string, input: EditMember) => request<Result<MemberDto>>(`/api/v1/departments/${id}/members/${userId}`, 'PATCH', input);
export const removeMember = (id: string, userId: string, version: number) => request<void>(`/api/v1/departments/${id}/members/${userId}`, 'DELETE', { version });
export const transferMember = (userId: string, input: TransferMember) => request(`/api/v1/members/${userId}/transfers`, 'POST', input);
export const cancelTransfer = (userId: string, version: number) => request(`/api/v1/members/${userId}/transfers`, 'DELETE', { version });
