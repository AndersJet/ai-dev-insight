import type {UsageMappingPageDto,UsageMappingQueryDto,UsageMappingBodyDto} from '@adi/contracts';import {request} from './http.js';
export const list=(input:UsageMappingQueryDto)=>request<{data:UsageMappingPageDto}>(`/api/v1/usage/department-mappings?${new URLSearchParams(Object.entries(input).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]))}`);
export const create=(input:UsageMappingBodyDto)=>request<{data:{id:string;version:number}}>('/api/v1/usage/department-mappings','POST',input);
export const remove=(id:string,version:number)=>request<{data:{version:number}}>(`/api/v1/usage/department-mappings/${id}`,'DELETE',{version});
