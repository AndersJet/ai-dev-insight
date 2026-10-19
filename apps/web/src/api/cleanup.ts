import type {CleanupRangeDto,CleanupPreviewDto,CleanupSubmitDto,CleanupJobDto} from '@adi/contracts';import {request} from './http.js';
export const preview=(body:CleanupRangeDto)=>request<{data:CleanupPreviewDto}>('/api/v1/admin/cleanup/previews','POST',body);
export const submit=(body:CleanupSubmitDto,key:string)=>request<{data:{job_id:string;status:string}}>('/api/v1/admin/cleanup/jobs','POST',body,{'Idempotency-Key':key});
export const status=(id:string)=>request<{data:CleanupJobDto}>(`/api/v1/jobs/${encodeURIComponent(id)}`);
export const list=(user:string,cursor?:string)=>request<{data:{items:CleanupJobDto[];next_cursor:string|null}}>(`/api/v1/admin/cleanup/jobs?user_id=${encodeURIComponent(user)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
export const resume=(id:string,email:string)=>request<{data:{job_id:string;status:string}}>(`/api/v1/admin/cleanup/jobs/${encodeURIComponent(id)}/resume`,'POST',{confirmation_email:email});
