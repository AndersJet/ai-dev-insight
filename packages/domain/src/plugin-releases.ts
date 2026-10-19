import {createHash} from 'node:crypto';
import type {Database,Queryable} from '@adi/storage';
import {PLUGIN_RELEASE_MAX_BYTES,type PluginReleaseDto,type PluginReleaseRecordDto,type PluginPilotBody,type PluginTesterDto,type CurrentUser} from '@adi/contracts';
import type {IdentityService} from './identity.js';
import {DomainError} from './errors.js';
export interface PluginArtifact {version:string;build_id:string;package:Buffer}
type Row={id:string;version:string;build_id:string;sha256:string;bytes:number;state:'draft'|'pilot'|'released';pilot_user_ids:string[];uploaded_at:Date;published_at:Date|null;current_stable:boolean;current_pilot:boolean};
const columns='r.id,r.version,r.build_id,r.sha256,r.bytes,r.state,r.pilot_user_ids,r.uploaded_at,r.published_at,(r.id=c.stable_id) IS TRUE AS current_stable,(r.id=c.pilot_id) IS TRUE AS current_pilot';
const from='plugin_releases r CROSS JOIN plugin_release_channels c';
const validHash=(v:string)=>/^[a-f0-9]{64}$/.test(v);
const allowed=(actor:CurrentUser)=>{if(!actor.roles.includes('super'))throw new DomainError('forbidden',403);};
const record=(r:Row):PluginReleaseRecordDto=>({...r,download_path:`/api/v1/plugin-releases/builds/${r.build_id}/download`,uploaded_at:r.uploaded_at.toISOString(),published_at:r.published_at?.toISOString()??null});
const descriptor=(r:Row,channel:'stable'|'trial'):PluginReleaseDto=>({version:r.version,build_id:r.build_id,sha256:r.sha256,bytes:r.bytes,download_path:`/api/v1/plugin-releases/builds/${r.build_id}/download`,channel});
export function comparePluginVersions(a:string,b:string){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){const d=x[i]!-y[i]!;if(d)return Math.sign(d);}return 0;}
export function createPluginReleaseService(db:Database,identity:IdentityService){
 async function lock(sql:Queryable){await sql.query('SELECT singleton FROM plugin_release_channels FOR UPDATE');}
 async function one(sql:Queryable,id:string){const row=(await sql.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.id=$1`,[id])).rows[0];if(!row)throw new DomainError('not_found',404);return row;}
 async function audit(sql:Queryable,actor:CurrentUser,action:string,r:Row){await sql.query('INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4)',[actor.user_id,action,r.id,{version:r.version,build_id:r.build_id}]);}
 async function upload(token:string,input:PluginArtifact){
  if(!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(input.version)||!validHash(input.build_id)||!Buffer.isBuffer(input.package)||!input.package.length||input.package.length>PLUGIN_RELEASE_MAX_BYTES)throw new DomainError('plugin_invalid_package',422);
  const sha=createHash('sha256').update(input.package).digest('hex');
  return identity.mutate(token,async(sql,actor)=>{
   allowed(actor);await lock(sql);
   const previous=(await sql.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.version=$1`,[input.version])).rows[0];
   if(previous?.state==='released')throw new DomainError('plugin_release_immutable',409);
   if(previous?.build_id===input.build_id){if(previous.sha256!==sha)throw new DomainError('plugin_build_reused',409);return record(previous);}
   if((await sql.query('SELECT 1 FROM plugin_releases WHERE build_id=$1',[input.build_id])).rowCount)throw new DomainError('plugin_build_reused',409);
   let id:string;
   if(previous){id=previous.id;await sql.query('UPDATE plugin_releases SET build_id=$2,sha256=$3,bytes=$4,artifact=$5,uploaded_at=clock_timestamp() WHERE id=$1',[id,input.build_id,sha,input.package.length,input.package]);}
   else{id=(await sql.query<{id:string}>('INSERT INTO plugin_releases(version,build_id,sha256,bytes,artifact,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[input.version,input.build_id,sha,input.package.length,input.package,actor.user_id])).rows[0]!.id;}
   const r=await one(sql,id);await audit(sql,actor,'plugin_release_uploaded',r);return record(r);
  },{checkAccess:allowed});
 }
 async function setPilot(token:string,id:string,input:PluginPilotBody){return identity.mutate(token,async(sql,actor)=>{
  allowed(actor);await lock(sql);const r=await one(sql,id);
  if(r.state==='released')throw new DomainError('plugin_release_immutable',409);if(r.build_id!==input.build_id)throw new DomainError('version_conflict',409);
  const users=[...new Set(input.user_ids)];if(!users.length||users.length>100)throw new DomainError('invalid_request',400);
  const eligible=await sql.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status=\'active\' AND registered_at IS NOT NULL FOR SHARE',[users]);
  if(eligible.rowCount!==users.length)throw new DomainError('invalid_plugin_testers',422);
  await sql.query("UPDATE plugin_releases SET state='pilot',pilot_user_ids=$2 WHERE id=$1",[id,users]);await sql.query('UPDATE plugin_release_channels SET pilot_id=$1',[id]);
  const after=await one(sql,id);await audit(sql,actor,'plugin_release_pilot',after);return record(after);
 },{checkAccess:allowed});}
 async function publish(token:string,id:string,build:string){return identity.mutate(token,async(sql,actor)=>{
  allowed(actor);await lock(sql);const r=await one(sql,id);
  if(r.state==='released'){if(r.current_stable&&r.build_id===build)return record(r);throw new DomainError('plugin_release_immutable',409);}if(r.build_id!==build)throw new DomainError('version_conflict',409);
  if(!r.current_pilot||r.state!=='pilot')throw new DomainError('plugin_release_not_pilot',409);
  const stable=(await sql.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.id=c.stable_id`)).rows[0];if(stable&&comparePluginVersions(r.version,stable.version)<=0)throw new DomainError('plugin_release_not_newer',409);
  await sql.query("UPDATE plugin_releases SET state='released',published_at=clock_timestamp() WHERE id=$1",[id]);
  await sql.query('UPDATE plugin_release_channels SET stable_id=$1,pilot_id=NULL',[id]);
  const after=await one(sql,id);await audit(sql,actor,'plugin_release_published',after);return record(after);
 },{checkAccess:allowed});}
 async function list(token:string){allowed(await identity.requireUser(token));const rows=(await db.query<Row>(`SELECT ${columns} FROM ${from} ORDER BY r.uploaded_at DESC LIMIT 200`)).rows;allowed(await identity.requireUser(token));return {items:rows.map(record)};}
 async function current(){await db.assertNotRecovering();const r=(await db.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.id=c.stable_id AND r.state='released'`)).rows[0];return r?descriptor(r,'stable'):null;}
 async function testers(token:string,search='',releaseId?:string):Promise<PluginTesterDto[]>{allowed(await identity.requireUser(token));if(search.length>128)throw new DomainError('invalid_request',400);const pattern='%'+search.replace(/[\\%_]/g,x=>'\\'+x)+'%';const rows=(await db.query<PluginTesterDto>("SELECT id AS user_id,email_key AS email,display_name FROM users WHERE status='active' AND registered_at IS NOT NULL AND (email_key ILIKE $1 OR display_name ILIKE $1 OR id=ANY(COALESCE((SELECT pilot_user_ids FROM plugin_releases WHERE id=$2::uuid),'{}'::uuid[]))) ORDER BY (id=ANY(COALESCE((SELECT pilot_user_ids FROM plugin_releases WHERE id=$2::uuid),'{}'::uuid[]))) DESC,email_key LIMIT 150",[pattern,releaseId??null])).rows;allowed(await identity.requireUser(token));return rows;}
 async function updateOwner(sql:Queryable,token:string){
  const state=(await sql.query<{recovery_id:string|null}>('SELECT recovery_id FROM data_identity FOR SHARE')).rows[0];if(!state||state.recovery_id)throw new DomainError('recovery_quarantined',503);
  if(!/^adi_api_v2\.[A-Za-z0-9_-]{43}$/.test(token))throw new DomainError('plugin_unauthorized',401);
  const owner=(await sql.query<{id:string;email_key:string;status:string;registered_at:Date|null}>('SELECT u.id,u.email_key,u.status,u.registered_at FROM plugin_account_credentials p JOIN users u ON u.id=p.user_id WHERE p.token_hash=$1 FOR SHARE OF u',[createHash('sha256').update(token).digest('hex')])).rows[0];
  if(!owner)throw new DomainError('plugin_unauthorized',401);if(owner.status!=='active')throw new DomainError('plugin_account_unavailable',403);if(!owner.registered_at)throw new DomainError('registration_required',409);
  try{identity.normalizeEmail(owner.email_key);}catch{throw new DomainError('plugin_account_unavailable',403);}return owner;
 }
 async function trial(token:string){return db.transaction(async sql=>{const owner=await updateOwner(sql,token);const r=(await sql.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.id=c.pilot_id AND r.state='pilot' FOR SHARE OF r,c`)).rows[0];return r&&r.pilot_user_ids.includes(owner.id)?descriptor(r,'trial'):null;});}
 async function permitted(sql:Queryable,build:string,token?:string){
  if(!validHash(build))throw new DomainError('invalid_request',400);
  const r=(await sql.query<Row>(`SELECT ${columns} FROM ${from} WHERE r.build_id=$1 FOR SHARE OF r,c`,[build])).rows[0];if(!r)throw new DomainError('not_found',404);
  if(r.state!=='released'){const owner=await updateOwner(sql,token??'');if(!r.current_pilot||r.state!=='pilot'||!r.pilot_user_ids.includes(owner.id))throw new DomainError('forbidden',403);}
  return r;
 }
 async function describe(build:string,token?:string){await db.assertNotRecovering();return db.transaction(async sql=>{const r=await permitted(sql,build,token);return descriptor(r,r.state==='released'?'stable':'trial');});}
 async function download(build:string,token?:string){await db.assertNotRecovering();return db.transaction(async sql=>{const r=await permitted(sql,build,token);const artifact=(await sql.query<{artifact:Buffer}>('SELECT artifact FROM plugin_releases WHERE id=$1',[r.id])).rows[0]!;return {release:descriptor(r,r.state==='released'?'stable':'trial'),package:artifact.artifact};});}
 return {upload,setPilot,publish,list,current,testers,trial,describe,download};
}
export type PluginReleaseService=ReturnType<typeof createPluginReleaseService>;
