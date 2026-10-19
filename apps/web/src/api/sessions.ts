import type {BillingSimulationDto,BillingSimulationQueryDto,SessionTokenCheckDto} from '@adi/contracts';
import type { AllSessionQueryDto, SessionListDto, SessionDetailDto, SessionOfficialUsageDto, PersonalModelDto,PersonalModelBodyDto, RecentSessionQueryDto, SessionFragmentsDto, SessionFragmentQueryDto, SessionContentDto, SessionContentQueryDto, SessionTurnsDto, SessionTurnsQueryDto } from '@adi/contracts';
import { request,requestDownload } from './http.js';
const query = (input: object) => { const params = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value)); return params.toString(); };
const base = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;
export const list = (all: boolean, input: AllSessionQueryDto,signal?:AbortSignal) => request<{ data: SessionListDto }>(`/api/v1/${all ? 'admin' : 'me'}/sessions?${query(input)}`,'GET',undefined,{},signal);
export const detail = (id: string) => request<{ data: SessionDetailDto }>(base(id));
export const officialUsage=(id:string,input:RecentSessionQueryDto)=>request<{data:SessionOfficialUsageDto}>(`${base(id)}/official-usage?${query(input)}`);
export const personalModels=(id:string)=>request<{data:PersonalModelDto}>(`${base(id)}/personal-models`);
export const replacePersonalModels=(id:string,input:PersonalModelBodyDto)=>request<{data:PersonalModelDto}>(`${base(id)}/personal-models`,'PUT',input);
export const turns = (id: string, input: SessionTurnsQueryDto) => request<{ data: SessionTurnsDto }>(`${base(id)}/turns?${query(input)}`);
export const fragments = (id: string, input: SessionFragmentQueryDto) => request<{ data: SessionFragmentsDto }>(`${base(id)}/fragments?${query(input)}`);
export const content = (id: string, event: string, input: SessionContentQueryDto) => request<{ data: SessionContentDto }>(`${base(id)}/events/${encodeURIComponent(event)}/content?${query(input)}`);

export const simulation=(id:string,input:BillingSimulationQueryDto)=>request<{data:BillingSimulationDto}>(`${base(id)}/billing-simulation?${query(input)}`);
export const tokenCheck=(id:string)=>request<{data:SessionTokenCheckDto}>(`${base(id)}/token-check`);

export const downloadAnalysis=(session_ids:string[],signal?:AbortSignal)=>requestDownload('/api/v1/sessions/analysis-package',{session_ids},signal);
