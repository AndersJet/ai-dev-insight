import {emailDomainAllowed} from './email-domains.js';
import type {CleanupCheckpointRef,Queryable} from '@adi/storage';
import {createHash} from 'node:crypto';
import {DomainError} from './errors.js';
export interface AccessUser{management_source:'system'|'environment';id:string;email_key:string;display_name:string;status:'active'|'suspended'|'deleted';version:number;cleanup_generation:number;created_at:string}
export interface AccessDepartment{id:string;name:string;version:number;deleted_at:string|null}
export interface AccessPeriod{id:string;user_id:string;valid_from:string;valid_to:string|null}
export interface AccessMembership extends AccessPeriod{department_id:string}
export interface AccessEligibility extends AccessPeriod{included:boolean}
export interface AccessGrant extends AccessPeriod{role:'super'|'anc_admin'|'department_admin';scope_id:string|null}
export interface AccessMapping{id:string;provider_account:string;external_department_id:string;department_id:string;valid_from:string;valid_to:string|null;created_by:string;created_at:string}
export interface AccessBinding{provider_account:string;user_id:string;provider_user_id:string;verified_email:string;verified_at:string}
export interface AccessMetadata{users:AccessUser[];departments:AccessDepartment[];memberships:AccessMembership[];eligibility:AccessEligibility[];grants:AccessGrant[];usage_mappings:AccessMapping[];provider_identities:AccessBinding[]}
export interface RecoveryAccessSnapshot extends AccessMetadata{version:1;dataset_id:string;exported_at:string;checkpoint:CleanupCheckpointRef}
export const accessDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const invalid=()=>new DomainError('invalid_recovery_access_snapshot',422);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max&&!Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127);
export function accessTime(value:string):bigint{
 const match=/^([0-9]{4})-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.([0-9]{1,6}))?(?:Z|\+00(?::00)?)$/.exec(value),parsed=Date.parse(value);
 if(!match||Number(match[1])<1||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,19)!==value.slice(0,19).replace(' ','T'))throw invalid();
 return BigInt(parsed)*1000n+BigInt((match[2]??'').padEnd(6,'0').slice(3));
}
function shape(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw invalid();return value as Record<string,unknown>;}
function rows(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||value.length>max)throw invalid();return value;}
const email=(value:unknown):value is string=>text(value,254)&&value===value.toLowerCase()&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const integer=(value:unknown,min=0)=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<2147483647;
function periods<T extends {valid_from:string;valid_to:string|null}>(values:T[],key:(row:T)=>string,empty=false){
 const groups=new Map<string,{start:bigint;end:bigint|null}[]>();for(const row of values){const start=accessTime(row.valid_from),end=row.valid_to===null?null:accessTime(row.valid_to);if(end!==null&&(empty?end<start:end<=start))throw invalid();if(start===end)continue;const id=key(row);const group=groups.get(id)??[];group.push({start,end});groups.set(id,group);}
 for(const group of groups.values()){group.sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);for(let index=1;index<group.length;index++)if(group[index-1]!.end===null||group[index-1]!.end!>group[index]!.start)throw invalid();}
}
export function validateAccessSnapshot(value:unknown,domains:ReadonlySet<string>):RecoveryAccessSnapshot{
 if(Buffer.byteLength(JSON.stringify(value)??'')>16777216)throw invalid();const s=shape(value,['version','dataset_id','exported_at','checkpoint','users','departments','memberships','eligibility','grants','usage_mappings','provider_identities']);
 if(s.version!==1||!validUuid(s.dataset_id)||typeof s.exported_at!=='string')throw invalid();accessTime(s.exported_at);const cp=shape(s.checkpoint,['checkpoint_id','digest']);if(!validUuid(cp.checkpoint_id)||typeof cp.digest!=='string'||!/^[0-9a-f]{64}$/.test(cp.digest))throw invalid();
 const userIds=new Set<string>(),emails=new Set<string>(),departmentIds=new Set<string>(),names=new Set<string>();
 for(const value of rows(s.users,10000)){const r=shape(value,['id','email_key','display_name','status','management_source','version','cleanup_generation','created_at']);if(!validUuid(r.id)||userIds.has(r.id)||!email(r.email_key)||emails.has(r.email_key)||!emailDomainAllowed(domains,r.email_key)||!text(r.display_name,128)||(typeof r.status!=='string'||!['active','suspended','deleted'].includes(r.status))||!['system','environment'].includes(String(r.management_source))||!integer(r.version,1)||!integer(r.cleanup_generation)||typeof r.created_at!=='string')throw invalid();accessTime(r.created_at);userIds.add(r.id);emails.add(r.email_key);}
 for(const value of rows(s.departments,10000)){const r=shape(value,['id','name','version','deleted_at']);if(!validUuid(r.id)||departmentIds.has(r.id)||!text(r.name,128)||!integer(r.version,1)||(r.deleted_at!==null&&typeof r.deleted_at!=='string'))throw invalid();if(r.deleted_at===null){if(names.has(r.name.toLowerCase()))throw invalid();names.add(r.name.toLowerCase());}else accessTime(r.deleted_at as string);departmentIds.add(r.id);}
 const unique=(values:unknown[],keys:string[],check:(r:Record<string,unknown>)=>boolean)=>{const ids=new Set<string>();for(const value of values){const r=shape(value,keys);if(!validUuid(r.id)||ids.has(r.id)||!check(r))throw invalid();ids.add(r.id);}};
 const owned=(r:Record<string,unknown>)=>typeof r.user_id==='string'&&userIds.has(r.user_id)&&typeof r.valid_from==='string'&&(r.valid_to===null||typeof r.valid_to==='string');
 unique(rows(s.memberships,100000),['id','user_id','department_id','valid_from','valid_to'],r=>owned(r)&&typeof r.department_id==='string'&&departmentIds.has(r.department_id));
 unique(rows(s.eligibility,100000),['id','user_id','included','valid_from','valid_to'],r=>owned(r)&&typeof r.included==='boolean');
 unique(rows(s.grants,100000),['id','user_id','role','scope_id','valid_from','valid_to'],r=>owned(r)&&typeof r.role==='string'&&['super','anc_admin','department_admin'].includes(r.role)&&(r.role==='department_admin'?typeof r.scope_id==='string'&&departmentIds.has(r.scope_id):r.scope_id===null));
 unique(rows(s.usage_mappings,100000),['id','provider_account','external_department_id','department_id','valid_from','valid_to','created_by','created_at'],r=>{if(!text(r.provider_account,256)||!text(r.external_department_id,256)||typeof r.department_id!=='string'||!departmentIds.has(r.department_id)||typeof r.created_by!=='string'||!userIds.has(r.created_by)||typeof r.created_at!=='string'||typeof r.valid_from!=='string'||(r.valid_to!==null&&typeof r.valid_to!=='string'))return false;accessTime(r.created_at);return true;});
 const bindings=new Set<string>(),providerIds=new Set<string>();for(const value of rows(s.provider_identities,100000)){const r=shape(value,['provider_account','user_id','provider_user_id','verified_email','verified_at']);if(!text(r.provider_account,256)||typeof r.user_id!=='string'||!userIds.has(r.user_id)||!text(r.provider_user_id,256)||!email(r.verified_email)||typeof r.verified_at!=='string')throw invalid();const key=JSON.stringify([r.provider_account,r.user_id]),provider=JSON.stringify([r.provider_account,r.provider_user_id]);if(bindings.has(key)||providerIds.has(provider))throw invalid();bindings.add(key);providerIds.add(provider);accessTime(r.verified_at);}
 const snapshot=value as RecoveryAccessSnapshot;
 if(snapshot.users.filter(user=>user.management_source==='environment'&&user.status==='active').length>1)throw invalid();
 periods(snapshot.memberships,r=>r.user_id,true);periods(snapshot.eligibility,r=>r.user_id);periods(snapshot.grants,r=>JSON.stringify([r.user_id,r.role,r.scope_id]));periods(snapshot.usage_mappings,r=>JSON.stringify([r.provider_account,r.external_department_id]));return snapshot;
}
export async function accessMetadata(sql:Queryable):Promise<AccessMetadata>{
 const data={
  users:(await sql.query<AccessUser>('SELECT id,email_key,display_name,status,management_source,version,cleanup_generation,created_at::text FROM users ORDER BY id LIMIT 10001')).rows,
  departments:(await sql.query<AccessDepartment>('SELECT id,name,version,deleted_at::text FROM departments ORDER BY id LIMIT 10001')).rows,
  memberships:(await sql.query<AccessMembership>('SELECT id,user_id,department_id,valid_from::text,valid_to::text FROM membership_periods ORDER BY id LIMIT 100001')).rows,
  eligibility:(await sql.query<AccessEligibility>('SELECT id,user_id,included,valid_from::text,valid_to::text FROM eligibility_periods ORDER BY id LIMIT 100001')).rows,
  grants:(await sql.query<AccessGrant>('SELECT id,user_id,role,scope_id,valid_from::text,valid_to::text FROM role_grants ORDER BY id LIMIT 100001')).rows,
  usage_mappings:(await sql.query<AccessMapping>('SELECT id,provider_account,external_department_id,department_id,valid_from::text,valid_to::text,created_by,created_at::text FROM usage_department_mappings ORDER BY id LIMIT 100001')).rows,
  provider_identities:(await sql.query<AccessBinding>('SELECT provider_account,user_id,provider_user_id,verified_email,verified_at::text FROM usage_provider_identities ORDER BY provider_account,user_id LIMIT 100001')).rows,
 }; if(data.users.length>10000||data.departments.length>10000||[data.memberships,data.eligibility,data.grants,data.usage_mappings,data.provider_identities].some(rows=>rows.length>100000)||Buffer.byteLength(JSON.stringify(data))>16777216)throw new DomainError('recovery_access_limit',409);
 return data;
}
