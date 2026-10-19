import type { ImportBatchDto } from '@adi/contracts';
import { request } from './http.js';
export function preview(departmentId: string, mode: 'insert_only' | 'upsert', file: File) {
  const form = new FormData(); form.append('file', file);
  return request<{ data: ImportBatchDto }>(`/api/v1/member-imports/preview?${new URLSearchParams({ department_id: departmentId, mode })}`, 'POST', form);
}
export const get = (id: string) => request<{ data: ImportBatchDto }>(`/api/v1/member-imports/${id}`);
export const submit = (batch: ImportBatchDto, key: string) => request<{ data: { job_id: string } }>(`/api/v1/member-imports/${batch.id}/commit`, 'POST', { preview_hash: batch.preview_hash }, { 'Idempotency-Key': key });
export const recent = (departmentId: string) => request<{ data: { id: string; source_name: string; status: string; created_at: string; expires_at: string }[] }>(`/api/v1/member-imports?department_id=${departmentId}`);
