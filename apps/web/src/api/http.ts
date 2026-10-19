import type { ApiError } from '@adi/contracts';
export class ApiFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
/** Only temporary transport/service failures may keep a result in the same reading scope. */
export function isTransientReadFailure(reason: unknown): boolean {
  if (reason instanceof ApiFailure) {
    if (['recovery_quarantined', 'content_changed', 'forbidden', 'unauthorized', 'not_found', 'invalid_cursor', 'invalid_period', 'session_snapshot_expired', 'session_snapshot_pending'].includes(reason.code)) return false;
    return reason.status === 408 || reason.status === 429 || (reason.status >= 500 && reason.status < 600);
  }
  return reason instanceof TypeError || (reason instanceof Error && reason.name === 'AbortError');
}
async function fetchResponse(path: string, method = 'GET', data?: unknown, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  const multipart = typeof FormData !== 'undefined' && data instanceof FormData;
  if (data !== undefined && !multipart) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && typeof document !== 'undefined') headers['X-CSRF-Token'] = /(?:^|;\s*)adi_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? '';
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, ...(signal ? {signal} : {}), ...(data === undefined ? {} : { body: multipart ? data : JSON.stringify(data) }) });
  if (!response.ok) {
    const problem: ApiError | null = await response.json().catch(() => null);
    throw new ApiFailure(response.status, typeof problem?.error?.code === 'string' ? problem.error.code : 'request_failed', typeof problem?.error?.message === 'string' ? problem.error.message : '请求失败，请稍后重试');
  }
  return response;
}

export async function request<T>(path:string,method='GET',data?:unknown,extraHeaders:Record<string,string>={},signal?:AbortSignal):Promise<T>{
  const response=await fetchResponse(path,method,data,extraHeaders,signal);
  return response.status===204?undefined as T:response.json() as Promise<T>;
}
export async function requestDownload(path:string,data:unknown,signal?:AbortSignal):Promise<Blob>{
  const response=await fetchResponse(path,'POST',data,{Accept:'application/zip'},signal);
  if(!response.headers.get('content-type')?.startsWith('application/zip'))throw new ApiFailure(502,'invalid_response','分析包格式不正确');
  return response.blob();
}
