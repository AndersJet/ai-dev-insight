import type { CollectionCredentialDto, PluginCredentialStatusDto, PluginCredentialDto } from '@adi/contracts';
import { request } from './http.js';
const base = (ownerId?: string) => ownerId ? `/api/v1/admin/users/${encodeURIComponent(ownerId)}/collection-credential` : '/api/v1/me/collection-credential';
export const collectionCredential = (ownerId?: string) => request<{ data: CollectionCredentialDto }>(base(ownerId));
export const pluginCredentialStatus = () => request<{ data: PluginCredentialStatusDto }>('/api/v1/me/plugin-credential');
export const pluginCredential = () => request<{ data: PluginCredentialDto }>('/api/v1/me/plugin-credential', 'POST', {});
