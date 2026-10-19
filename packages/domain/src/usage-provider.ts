import { createHash } from 'node:crypto';
import { jsonBudgetFailure } from '@adi/contracts';

export class UsageProviderError extends Error {
  constructor(public readonly code: 'invalid_provider_config' | 'invalid_provider_query' | 'invalid_provider_response' | 'provider_unavailable' | 'provider_timeout' | 'provider_auth_failed' | 'provider_rejected' | 'provider_rate_limited' | 'provider_response_limit', public readonly httpStatus: number | null = null, public readonly providerCode: number | null = null, public readonly retryAfterSeconds: number | null = null) { super(code); this.name = 'UsageProviderError'; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function hasControl(value: string) { for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true; return false; }
const invalid = () => new UsageProviderError('invalid_provider_response');
function text(value: unknown, maximum = 256): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || hasControl(value)) throw invalid();
  return value;
}
function integer(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw invalid();
  return BigInt(value).toString();
}
function smallInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = integer(value); if (parsed === null || BigInt(parsed) > BigInt(maximum)) throw invalid(); return Number(parsed);
}
function item(value: unknown) {
  if (!object(value)) throw invalid();
  const usage = value.usage == null ? {} : value.usage; if (!object(usage)) throw invalid();
  const departmentValues = value.departments;
  if (departmentValues != null && (!Array.isArray(departmentValues) || departmentValues.length > 100)) throw invalid();
  const departments = departmentValues == null ? null : (departmentValues as unknown[]).map(department => {
    if (!object(department)) throw invalid(); const id = text(department.department_id); if (!id) throw invalid();
    return { id, name: text(department.name, 1024), full_path: text(department.full_path, 4096) };
  });
  const amountText = text(value.total_cost, 128);
  const amountReason = value.total_cost === undefined ? 'missing' as const : value.total_cost === null ? 'null' as const : amountText === '-' ? 'not_priced' as const : null;
  if (!amountReason && (!amountText || !/^-?\d{1,26}(?:\.\d{1,18})?$/.test(amountText) || amountText.replace(/[-.]/g, '').length > 38)) throw invalid();
  const start = integer(value.start_time); if (start !== null && BigInt(start) > 8640000000000n) throw invalid();
  const normalized = { billing_session_id: text(value.session_id), provider_user_id: text(value.user_id), email: text(value.email, 254)?.trim().toLowerCase() ?? null,
    start_time: start, client: text(value.client), scene: text(value.scene), model_name: text(value.model_name, 1024), model_type: text(value.model_type), model_source: text(value.model_source), consumption_source: text(value.consumption_source), model_call_count: integer(value.model_call_count), departments,
    usage: { prompt_tokens: integer(usage.prompt_tokens), completion_tokens: integer(usage.completion_tokens), total_tokens: integer(usage.total_tokens), cache_creation_input_tokens: integer(usage.cache_creation_input_tokens), cache_read_input_tokens: integer(usage.cache_read_input_tokens) },
    amount: amountReason ? null : amountText, amount_reason: amountReason, currency: text(value.total_cost_currency, 32) };
  const quality: string[] = []; const tokens = normalized.usage;
  if (tokens.prompt_tokens === null || tokens.completion_tokens === null || tokens.total_tokens === null) quality.push('tokens_incomplete');
  else if (BigInt(tokens.prompt_tokens) + BigInt(tokens.completion_tokens) !== BigInt(tokens.total_tokens)) quality.push('token_sum_mismatch');
  if (tokens.prompt_tokens !== null && BigInt(tokens.cache_read_input_tokens ?? '0') + BigInt(tokens.cache_creation_input_tokens ?? '0') > BigInt(tokens.prompt_tokens)) quality.push('cache_exceeds_input');
  if (normalized.amount !== null && !normalized.currency) quality.push('amount_currency_missing');
  if (!['Trae', 'Custom'].includes(normalized.model_source ?? '')) quality.push('model_source_unknown');
  if (!['basic', 'pay_go', 'mixed', 'enterprise_builtin'].includes(normalized.consumption_source ?? '')) quality.push('consumption_source_unknown');
  return { ...normalized, quality, token_basis: 'provider_reported' as const };
}
export type ProviderUsageItem = ReturnType<typeof item>;
export interface MemberUsageQuery { start_time: number; end_time: number; emails?: string[]; user_ids?: string[]; page?: number; page_size?: number }
export type MemberUsageRequest = MemberUsageQuery & { page: number; page_size: number };
export type MemberModelUsageQuery = Pick<MemberUsageQuery,'start_time'|'end_time'|'emails'|'user_ids'>;
function memberScope(input:MemberModelUsageQuery){
 const rawEmails=input.emails??[],rawIds=input.user_ids??[];
 if(!Number.isSafeInteger(input.start_time)||!Number.isSafeInteger(input.end_time)||input.start_time<0||input.end_time<input.start_time||input.end_time>8640000000000||input.end_time-input.start_time>180*86400||!Array.isArray(rawEmails)||!Array.isArray(rawIds)||rawEmails.length>1000||rawIds.length>1000)throw new UsageProviderError('invalid_provider_query');
 if(rawEmails.some(email=>typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))||rawIds.some(id=>typeof id!=='string'||!id||id.length>256||hasControl(id)))throw new UsageProviderError('invalid_provider_query');
 const emails=[...new Set(rawEmails.map(email=>email.trim().toLowerCase()))].sort(),ids=[...new Set(rawIds)].sort();
 if(emails.length+ids.length<1||emails.length+ids.length>100)throw new UsageProviderError('invalid_provider_query');
 return {start_time:input.start_time,end_time:input.end_time,...(emails.length?{emails}:{}),...(ids.length?{user_ids:ids}:{})};
}
function modelMember(value:unknown){
 if(!object(value)||!Array.isArray(value.model_usage)||value.model_usage.length>5000)throw invalid();
 const providerId=text(value.user_id);if(!providerId)throw invalid();
 return {provider_user_id:providerId,email:text(value.email,254)?.trim().toLowerCase()??null,model_usage:value.model_usage.map(model=>{
  if(!object(model))throw invalid();const usage=model.usage??{};if(!object(usage))throw invalid();
  return {model_name:text(model.model_name,1024),model_type:text(model.model_type),model_source:text(model.model_source),usage:{input_tokens:integer(usage.input_tokens),output_tokens:integer(usage.output_tokens)}};
 })};
}

export interface UsageProviderOptions { baseUrl: string; appId: string; appSecret: string; timeoutMs?: number; maxResponseBytes?: number; clock?: () => number; beforeRequest?: (signal: AbortSignal) => Promise<void> }
/** Read-only OpenAPI boundary. Member times are native inclusive Unix seconds;
 * canonical [from,to) day conversion belongs to the scoped synchronization job.
 * This adapter never classifies pay_go as cash or Custom as personal BYOK.
 */
export function createTraeUsageProvider(options: UsageProviderOptions) {
  let url: URL; try { url = new URL(options.baseUrl); } catch { throw new UsageProviderError('invalid_provider_config'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !options.appId || !options.appSecret || options.appId.length > 4096 || options.appSecret.length > 4096) throw new UsageProviderError('invalid_provider_config');
  const timeout = options.timeoutMs ?? 10_000; const maximum = options.maxResponseBytes ?? 4 * 1024 * 1024; const now = options.clock ?? Date.now;
  if (!Number.isSafeInteger(timeout) || timeout < 20 || timeout > 30_000 || !Number.isSafeInteger(maximum) || maximum < 128 || maximum > 8 * 1024 * 1024) throw new UsageProviderError('invalid_provider_config');
  let cached: { value: string; expiresAt: number } | null = null;
  let authentication: Promise<string> | null = null;
  async function post(path: string, body: object, signal: AbortSignal, token?: string) {
    signal.throwIfAborted();
    if(options.beforeRequest)await new Promise<void>((resolve,reject)=>{
      const aborted=()=>reject(new UsageProviderError('provider_timeout'));
      signal.addEventListener('abort',aborted,{once:true});
      Promise.resolve().then(()=>options.beforeRequest!(signal)).then(()=>{signal.removeEventListener('abort',aborted);resolve();},error=>{signal.removeEventListener('abort',aborted);reject(error);});
    });
    signal.throwIfAborted();
    const response = await fetch(url.origin + path, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? Math.ceil((Date.parse(header) - now()) / 1000) : NaN;
      const retry = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, seconds)) : null;
      const code = response.status === 429 ? 'provider_rate_limited' : [401, 403].includes(response.status) ? 'provider_auth_failed' : response.status < 500 ? 'provider_rejected' : 'provider_unavailable';
      throw new UsageProviderError(code, response.status, null, retry);
    }
    if (!response.body || Number(response.headers.get('content-length') ?? 0) > maximum) { await response.body?.cancel(); throw new UsageProviderError('provider_response_limit', response.status); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); throw new UsageProviderError('provider_response_limit', response.status); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    let raw: string; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw invalid(); }
    if (jsonBudgetFailure(raw, { wireBytes: maximum, expandedBytes: maximum * 2 })) throw new UsageProviderError('provider_response_limit', response.status);
    let parsed: unknown;
    try { parsed = JSON.parse(raw, (_key: string, value: unknown, context?: { source?: string }) => typeof value === 'number' && context?.source ? context.source : value); } catch { throw invalid(); }
    if (!object(parsed)) throw invalid();
    return { data: parsed, code: smallInteger(parsed.code, 2147483647), http: response.status, hash: createHash('sha256').update(raw).digest('hex') };
  }
  async function fetchToken(signal: AbortSignal) {
    const started = now(); const result = await post('/openapi/v1/auth/token', { app_id: options.appId, app_secret: options.appSecret }, signal);
    if (result.code === 64290) throw new UsageProviderError('provider_rate_limited', result.http, result.code);
    if (result.code !== 0 || !object(result.data.data)) throw new UsageProviderError('provider_auth_failed', result.http, result.code);
    const value = text(result.data.data.access_token, 4096); if (!value) throw new UsageProviderError('provider_auth_failed', result.http, result.code);
    const expiry = result.data.data.expire === undefined ? 7200 : smallInteger(result.data.data.expire, 86400);
    cached = { value, expiresAt: started + Math.max(0, expiry - Math.min(300, expiry / 10)) * 1000 }; return value;
  }
  async function accessToken(signal: AbortSignal) {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!authentication) authentication = fetchToken(signal).finally(() => { authentication = null; });
    return authentication;
  }
  async function queryResponse(endpoint:'session_usage_detail'|'user_usage_detail'|'user-model-usage',body:{session_ids:string[]}|MemberModelUsageQuery|MemberUsageRequest) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let token = await accessToken(controller.signal);
      let result = await post(`/openapi/v1/statistics/${endpoint}`, body, controller.signal, token);
      if (result.code === 1002) {
        if (cached?.value === token) cached = null;
        token = await accessToken(controller.signal);
        result = await post(`/openapi/v1/statistics/${endpoint}`, body, controller.signal, token);
      }
      if (result.code === 1002) { if (cached?.value === token) cached = null; throw new UsageProviderError('provider_auth_failed', result.http, result.code); }
      if (result.code === 64290) throw new UsageProviderError('provider_rate_limited', result.http, result.code);
      if (result.code !== 0) throw new UsageProviderError('provider_rejected', result.http, result.code);
      if (!object(result.data.data) || !Array.isArray(result.data.data.items) || result.data.data.items.length > 5000) throw invalid();
      return {data:result.data.data,request_id:text(result.data.request_id),observed_at:new Date(now()).toISOString(),response_hash:result.hash};
    } catch (error) {
      if (error instanceof UsageProviderError) throw error;
      throw new UsageProviderError(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable');
    } finally { clearTimeout(timer); }
  }
  async function query(kind:'session'|'member',body:{session_ids:string[]}|MemberUsageRequest){
    const result=await queryResponse(kind==='session'?'session_usage_detail':'user_usage_detail',body);
      const data = result.data; const rows = data.items as unknown[]; let pagination: { page: number; page_size: number; total: number; total_pages: number } | null = null;
      if (data.pagination !== undefined && data.pagination !== null) {
        if (!object(data.pagination)) throw invalid();
        pagination = { page: smallInteger(data.pagination.page), page_size: smallInteger(data.pagination.page_size, 500), total: smallInteger(data.pagination.total), total_pages: smallInteger(data.pagination.total_pages) };
        if (pagination.page < 1 || pagination.page_size < 1) throw invalid();
      }
      if (kind === 'member') {
        if (!pagination || !('page' in body) || pagination.page !== body.page || pagination.page_size !== body.page_size || pagination.total < rows.length || rows.length > pagination.page_size || (pagination.total > 0 && pagination.total_pages < pagination.page)) throw invalid();
        const expected = Math.min(pagination.page_size, Math.max(0, pagination.total - (pagination.page - 1) * pagination.page_size));
        const pages = Math.ceil(pagination.total / pagination.page_size);
        if (rows.length !== expected || (pagination.total ? pagination.total_pages !== pages : ![0, 1].includes(pagination.total_pages))) throw invalid();
      }
      return { items: rows.map(item), pagination, request_id: result.request_id, observed_at: result.observed_at, response_hash: result.response_hash, query: { endpoint: kind === 'session' ? 'session_usage_detail' as const : 'user_usage_detail' as const, parameters: structuredClone(body) } };
  }
  return {
    getSessionUsage(sessionId: string) {
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || hasControl(sessionId)) return Promise.reject(new UsageProviderError('invalid_provider_query'));
      return query('session', { session_ids: [sessionId] });
    },
    async getMemberUsage(input: MemberUsageQuery) {
      const page=input.page??1,size=input.page_size??200;
      if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(size)||size<1||size>500)throw new UsageProviderError('invalid_provider_query');
      return query('member',{...memberScope(input),page,page_size:size});
    },
    async getMemberModelUsage(input:MemberModelUsageQuery){
      const body=memberScope(input),result=await queryResponse('user-model-usage',body),rows=result.data.items as unknown[];
      if(rows.length>100)throw invalid();
      const pagination=result.data.pagination;
      if(pagination!==undefined&&pagination!==null){
        if(!object(pagination)||smallInteger(pagination.page)!==1||smallInteger(pagination.total)!==rows.length||smallInteger(pagination.total_pages)>1)throw invalid();
      }
      const items=rows.map(modelMember);
      if(items.reduce((total,member)=>total+member.model_usage.length,0)>5000||new Set(items.map(member=>member.provider_user_id)).size!==items.length)throw invalid();
      return {items,pagination:null,request_id:result.request_id,observed_at:result.observed_at,response_hash:result.response_hash,query:{endpoint:'user-model-usage' as const,parameters:body}};
    },
  };
}
export type TraeUsageProvider = ReturnType<typeof createTraeUsageProvider>;
export type ProviderUsagePage = Awaited<ReturnType<TraeUsageProvider['getMemberUsage']>>;

export type ProviderModelUsagePage=Awaited<ReturnType<TraeUsageProvider['getMemberModelUsage']>>;
