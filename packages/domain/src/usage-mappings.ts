import type {Database,Transaction} from '@adi/storage';import type {CurrentUser} from '@adi/contracts';import type {IdentityService} from './identity.js';import {DomainError} from './errors.js';
const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const allowed=(actor:CurrentUser)=>{if(!actor.roles.some(role=>['super','anc_admin'].includes(role)))throw new DomainError('forbidden',403);};
function start(date:string){const at=Date.parse(`${date}T00:00:00+08:00`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(at)||new Date(at+28800000).toISOString().slice(0,10)!==date)throw new DomainError('invalid_period',422);return at;}
export function createUsageMappingService(db:Database,identity:IdentityService,options:{providerAccount?:string}={}){
 const account=options.providerAccount??null;
 async function version(client:Transaction,expected:number){
  if(!account)throw new DomainError('usage_provider_unconfigured',503);
  await client.query('INSERT INTO usage_mapping_state(provider_account,version) VALUES($1,0) ON CONFLICT DO NOTHING',[account]);
  const row=(await client.query<{version:number}>('SELECT version FROM usage_mapping_state WHERE provider_account=$1 FOR UPDATE',[account])).rows[0]!;
  if(expected!==row.version)throw new DomainError('version_conflict',409);return row.version;
 }
 async function list(token:string,departmentId:string,query:{search?:string;after?:string;after_mapping?:string;limit?:number}={}){
  allowed(await identity.requireUser(token));if(!uuid(departmentId))throw new DomainError('invalid_department',422);const limit=query.limit??50;const search=query.search?.trim()??'';
  if(!Number.isInteger(limit)||limit<1||limit>100||search.length>128||(query.after_mapping&&!uuid(query.after_mapping))||(query.after&&query.after.length>256))throw new DomainError('invalid_request',400);
  if(!account)return {configured:false,version:0,items:[],candidates:[],next_cursor:null,next_mapping_cursor:null};
  const state=(await db.query<{version:number}>('SELECT version FROM usage_mapping_state WHERE provider_account=$1',[account])).rows[0]?.version??0;
  const items=(await db.query<{id:string;external_department_id:string;department_id:string;valid_from:Date;valid_to:Date|null}>(`SELECT id,external_department_id,department_id,valid_from,valid_to FROM usage_department_mappings WHERE provider_account=$1 AND department_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[account,departmentId,query.after_mapping??null,limit+1])).rows;
  const candidates=(await db.query<{external_department_id:string;name:string;full_path:string}>('SELECT external_department_id,name,full_path FROM usage_department_catalog WHERE provider_account=$1 AND ($2=\'\' OR external_department_id ILIKE $3 OR name ILIKE $3 OR full_path ILIKE $3) AND ($4::text IS NULL OR external_department_id COLLATE "C">$4 COLLATE "C") ORDER BY external_department_id COLLATE "C" LIMIT $5',[account,search,`%${search.replace(/[\\%_]/g,value=>`\\${value}`)}%`,query.after??null,limit+1])).rows;
  allowed(await identity.requireUser(token));return {configured:true,version:state,items:items.slice(0,limit).map(row=>({...row,valid_from:row.valid_from.toISOString(),valid_to:row.valid_to?.toISOString()??null})),candidates:candidates.slice(0,limit),next_cursor:candidates.length>limit?candidates[limit-1]!.external_department_id:null,next_mapping_cursor:items.length>limit?items[limit-1]!.id:null};
 }
 async function create(token:string,input:{department_id:string;external_department_id:string;from_date:string;to_date?:string;version:number}){
  return identity.mutate(token,async(client,actor)=>{
   allowed(actor);if(!uuid(input.department_id)||!input.external_department_id||input.external_department_id.length>256||!Number.isInteger(input.version)||input.version<0)throw new DomainError('invalid_request',400);
   const from=start(input.from_date),to=input.to_date===undefined?null:start(input.to_date)+86400000;if(to!==null&&to<=from)throw new DomainError('invalid_period',422);
   const oldVersion=await version(client,input.version);
   if(!(await client.query('SELECT id FROM departments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[input.department_id])).rowCount)throw new DomainError('invalid_department',422);
   if(!(await client.query('SELECT 1 FROM usage_department_catalog WHERE provider_account=$1 AND external_department_id=$2',[account,input.external_department_id])).rowCount)throw new DomainError('usage_department_unobserved',422);
   const row=(await client.query<{id:string}>('INSERT INTO usage_department_mappings(provider_account,external_department_id,department_id,valid_from,valid_to,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[account,input.external_department_id,input.department_id,new Date(from),to===null?null:new Date(to),actor.user_id])).rows[0]!;
   const next=oldVersion+1;await client.query('UPDATE usage_mapping_state SET version=$2 WHERE provider_account=$1',[account,next]);
   await client.query('INSERT INTO audit_events(actor_id,action,target_id,scope_id,metadata) VALUES($1,$2,$3,$4,$5)',[actor.user_id,'usage_department_mapping_created',row.id,input.department_id,{provider_account:account,external_department_id:input.external_department_id,from_date:input.from_date,to_date:input.to_date??null}]);return {...row,version:next};
  },{serializeOrganization:true,checkAccess:allowed});
 }
 async function remove(token:string,id:string,expected:number){
  return identity.mutate(token,async(client,actor)=>{allowed(actor);if(!uuid(id)||!Number.isInteger(expected)||expected<1)throw new DomainError('version_conflict',409);const oldVersion=await version(client,expected);const row=(await client.query<{department_id:string;external_department_id:string;valid_from:Date;valid_to:Date|null}>('DELETE FROM usage_department_mappings WHERE id=$1 AND provider_account=$2 RETURNING department_id,external_department_id,valid_from,valid_to',[id,account])).rows[0];if(!row)throw new DomainError('not_found',404);await client.query('UPDATE usage_mapping_state SET version=version+1 WHERE provider_account=$1',[account]);await client.query('INSERT INTO audit_events(actor_id,action,target_id,scope_id,metadata) VALUES($1,$2,$3,$4,$5)',[actor.user_id,'usage_department_mapping_removed',id,row.department_id,{provider_account:account,...row}]);return {version:oldVersion+1};},{serializeOrganization:true,checkAccess:allowed});
 }
 return {list,create,remove};
}
export type UsageMappingService=ReturnType<typeof createUsageMappingService>;
