import { authRoutes, type MeResponse } from '@adi/contracts';
import { request, ApiFailure } from './http.js';
export { ApiFailure } from './http.js';
export async function getMe(): Promise<MeResponse | null> {
  try { return await request<MeResponse>('/api/v1/me'); } catch (error) { if (error instanceof ApiFailure && error.status === 401) return null; throw error; }
}
export const login = (email: string, password: string, signal?:AbortSignal) => request<MeResponse>(authRoutes.login.path, 'POST', { email, password }, {}, signal);
export const changePassword = (current_password: string, new_password: string, signal?:AbortSignal) => request<MeResponse>(authRoutes.changePassword.path, 'POST', { current_password, new_password }, {}, signal);
export const logout = () => request<void>(authRoutes.logout.path, 'POST');
