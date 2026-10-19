import type { AnalyticsContentEstimateDto, AnalyticsOverviewDto, AnalyticsTrendsDto, AnalyticsGroupsDto, AnalyticsPurposesDto, AnalyticsPageQueryDto,AnalyticsModelQueryDto,ModelsDto,DeclaredModelsDto } from '@adi/contracts';
import { request } from './http.js';
function query(input: AnalyticsPageQueryDto) { const values = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined) values.set(key, String(value)); return values.toString(); }
export const overview = (input: AnalyticsPageQueryDto) => request<{ data: AnalyticsOverviewDto }>(`/api/v1/analytics/overview?${query(input)}`);
export const trends = (input: AnalyticsPageQueryDto) => request<{ data: AnalyticsTrendsDto }>(`/api/v1/analytics/trends?${query(input)}`);
export const purposes = (input: AnalyticsPageQueryDto) => request<{ data: AnalyticsPurposesDto }>(`/api/v1/analytics/purposes?${query(input)}`);
export const groups = (kind: 'members' | 'departments', input: AnalyticsPageQueryDto) => request<{ data: AnalyticsGroupsDto }>(`/api/v1/analytics/${kind}?${query(input)}`);

export const contentEstimate = (input: AnalyticsPageQueryDto) => request<{ data: AnalyticsContentEstimateDto }>(`/api/v1/analytics/content-estimate?${query(input)}`);
export const officialUsage = (input: AnalyticsPageQueryDto) => request<{ data: import('@adi/contracts').OfficialUsageDto }>(`/api/v1/analytics/official-usage?${query(input)}`);
export const models=(input:AnalyticsModelQueryDto)=>request<{data:ModelsDto}>(`/api/v1/analytics/models?${query(input)}`);
export const declaredModels=(input:AnalyticsPageQueryDto)=>request<{data:DeclaredModelsDto}>(`/api/v1/analytics/declared-models?${query(input)}`);

export const member=(id:string,input:AnalyticsPageQueryDto)=>{const params={...input};delete params.member_id;return request<{data:AnalyticsOverviewDto}>(`/api/v1/analytics/members/${encodeURIComponent(id)}?${query(params)}`);};
