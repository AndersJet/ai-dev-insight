import {createHash} from 'node:crypto';
import {parseRepositoryAddress,normalizeRepositoryHost,type CurrentUser} from '@adi/contracts';
import type {Database} from '@adi/storage';
import type {IdentityService} from './identity.js';
import {DomainError} from './errors.js';
import {createPageCursor,cursorScope} from './page-cursor.js';
export interface RepositoryRule { kind: 'host' | 'repository'; value: string }
export interface RepositoryClassification { address: string | null; host: string | null; source_tag: 'department' | 'personal' | null; reason: 'internal_ipv4' | 'allowlist' | 'unmatched' | 'unrecognized' }
export function classifyRepositoryAddress(input: string, rules: readonly RepositoryRule[] = []): RepositoryClassification {
  return createRepositoryClassifier(rules)(input);
}
/** Compile a rule snapshot once for the entire bounded result page. */
export function createRepositoryClassifier(rules:readonly RepositoryRule[]){
  const hosts=new Set<string>(),repositories=new Set<string>();
  for(const rule of rules){const value=rule.kind==='host'?normalizeRepositoryHost(rule.value):parseRepositoryAddress(rule.value)?.address;if(value)(rule.kind==='host'?hosts:repositories).add(value);}
  return (input:string):RepositoryClassification=>{
    const parsed=parseRepositoryAddress(input);if(!parsed)return {address:null,host:null,source_tag:null,reason:'unrecognized'};
    const allowed=hosts.has(parsed.host)||repositories.has(parsed.address);
    return {address:parsed.address,host:parsed.host,source_tag:parsed.internal_ipv4||allowed?'department':'personal',reason:parsed.internal_ipv4?'internal_ipv4':allowed?'allowlist':'unmatched'};
  };
}

type RuleRow=RepositoryRule & {id:string;version:number;created_at:Date;updated_at:Date};
const allowed=(actor:CurrentUser)=>{if(!actor.roles.includes('super'))throw new DomainError('forbidden',403);};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function target(id:string,version:number){if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)||!Number.isInteger(version)||version<1)throw new DomainError('invalid_request',400);}
function normalized(input:RepositoryRule):RepositoryRule{
  if(!input||!['host','repository'].includes(input.kind)||typeof input.value!=='string'||input.value.length>4096)throw new DomainError('invalid_request',400);
  const raw=input.value.trim(),value=input.kind==='host'?normalizeRepositoryHost(raw):parseRepositoryAddress(raw)?.address;
  if(!value)throw new DomainError('invalid_repository_address',422);
  return {kind:input.kind,value};
}
const present=(row:RuleRow)=>({...row,created_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString()});

export function createRepositoryAllowlistService(db:Database,identity:IdentityService){
  const cursors=createPageCursor(()=>new Date());
  async function create(token:string,input:RepositoryRule){
    return identity.mutate(token,async(client,actor)=>{
      allowed(actor);const rule=normalized(input);
      const row=(await client.query<RuleRow>('INSERT INTO repository_allowlist(kind,value,value_hash,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(kind,value_hash) DO NOTHING RETURNING id,kind,value,version,created_at,updated_at',[rule.kind,rule.value,hash(rule.value),actor.user_id])).rows[0];
      if(!row)throw new DomainError('repository_rule_exists',409);
      await client.query('INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4)',[actor.user_id,'repository_rule_created',row.id,rule]);
      return present(row);
    },{checkAccess:allowed});
  }
  async function list(token:string,input:{search?:string;limit?:number;cursor?:string}={}){
    const actor=await identity.requireUser(token);allowed(actor);
    const limit=input.limit??50,search=input.search?.trim()??'';
    if(!Number.isInteger(limit)||limit<1||limit>100||search.length>128)throw new DomainError('invalid_request',400);
    const pattern=`%${search.replace(/[\\%_]/g,value=>`\\${value}`)}%`;
    const revision=async()=>(await db.query<{revision:string;total:number}>("SELECT md5(COALESCE(string_agg(id::text||':'||version::text,',' ORDER BY id),'')) AS revision,count(*) FILTER(WHERE value ILIKE $1)::int AS total FROM repository_allowlist",[pattern])).rows[0]!;
    const before=await revision(),binding=cursorScope(['repository-allowlist',actor.user_id,search,limit,before.revision]);
    const after=input.cursor?cursors.decode(input.cursor,binding):null;
    if(after&&(typeof after.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(after.id)))throw new DomainError('invalid_cursor',400);
    const rows=(await db.query<RuleRow>('SELECT id,kind,value,version,created_at,updated_at FROM repository_allowlist WHERE value ILIKE $1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[pattern,after?.id??null,limit+1])).rows;
    allowed(await identity.requireUser(token));
    if(before.revision!==(await revision()).revision)throw new DomainError('content_changed',409);
    const shown=rows.slice(0,limit),last=shown.at(-1);
    return {items:shown.map(present),total:before.total,next_cursor:rows.length>limit&&last?cursors.encode(binding,{id:last.id}):null};
  }
  async function update(token:string,id:string,input:RepositoryRule & {version:number}){
    return identity.mutate(token,async(client,actor)=>{
      allowed(actor);target(id,input.version);const rule=normalized(input);
      const before=(await client.query<RuleRow>('SELECT id,kind,value,version,created_at,updated_at FROM repository_allowlist WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!before)throw new DomainError('not_found',404);
      if(before.version!==input.version)throw new DomainError('version_conflict',409);
      let row:RuleRow;
      try{row=(await client.query<RuleRow>('UPDATE repository_allowlist SET kind=$2,value=$3,value_hash=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,kind,value,version,created_at,updated_at',[id,rule.kind,rule.value,hash(rule.value)])).rows[0]!;}
      catch(reason){if(reason&&typeof reason==='object'&&'code' in reason&&reason.code==='23505')throw new DomainError('repository_rule_exists',409);throw reason;}
      await client.query('INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4)',[actor.user_id,'repository_rule_updated',id,{before:{kind:before.kind,value:before.value},after:rule}]);
      return present(row);
    },{checkAccess:allowed});
  }
  async function remove(token:string,id:string,version:number){
    return identity.mutate(token,async(client,actor)=>{
      allowed(actor);target(id,version);
      const row=(await client.query<RuleRow>('SELECT id,kind,value,version,created_at,updated_at FROM repository_allowlist WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new DomainError('not_found',404);
      if(row.version!==version)throw new DomainError('version_conflict',409);
      await client.query('DELETE FROM repository_allowlist WHERE id=$1',[id]);
      await client.query('INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4)',[actor.user_id,'repository_rule_removed',id,{kind:row.kind,value:row.value}]);
    },{checkAccess:allowed});
  }
  return {create,list,update,remove};
}
export type RepositoryAllowlistService=ReturnType<typeof createRepositoryAllowlistService>;
