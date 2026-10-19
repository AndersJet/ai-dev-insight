import type { AccountDto, AccessBody, StatusBody, EmailCorrection, ResetReason } from '@adi/contracts';
import { request } from './http.js';
export const getAccount = (id: string) => request<{ data: AccountDto }>(`/api/v1/admin/users/${id}`);
export const setAccess = (id: string, input: AccessBody) => request(`/api/v1/admin/users/${id}/global-roles`, 'PUT', input);
export const setStatus = (id: string, input: StatusBody) => request(`/api/v1/admin/users/${id}/status`, 'PATCH', input);
export const correctEmail = (id: string, input: EmailCorrection) => request(`/api/v1/admin/users/${id}/email`, 'PATCH', input);
export const resetPassword = (id: string, version: number, reason: ResetReason) => request<{ data: { temporary_password: string; version: number } }>(`/api/v1/admin/users/${id}/reset-password`, 'POST', { version, reason });
