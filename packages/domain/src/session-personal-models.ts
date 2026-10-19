import type { Database, Transaction } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';
import { recentPeriod } from './recent-period.js';

type Row={user_id:string;cleanup_generation:number;models:string[]|null;version:number|null;model_generation:number|null;updated_at:Date|null};
function hasControl(value:string){for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code<32||code===127)return true;}return false;}
export function createSessionPersonalModelService(db:Database,identity:IdentityService,options:{clock?:()=>Date}={}){
 const now=options.clock??(()=>new Date());
 async function context(client:Transaction,actor:CurrentUser,id:string){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new DomainError('not_found',404);
  const period=recentPeriod({},now(),45);
  const row=(await client.query<Row>(`SELECT s.user_id,u.cleanup_generation,p.models,p.version,p.cleanup_generation AS model_generation,p.updated_at FROM sessions s JOIN users u ON u.id=s.user_id
   LEFT JOIN session_personal_models p ON p.session_id=s.id AND p.user_id=u.id
   WHERE s.id=$1 AND (s.user_id=$2 OR $3::boolean) AND EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id=s.id AND e.occurred_at>=$4 AND e.occurred_at<$5
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))`,[id,actor.user_id,actor.roles.includes('super'),period.from,period.to])).rows[0];
  if(!row)throw new DomainError('not_found',404);return row;
 }
 function output(row:Row,actor:CurrentUser){const current=row.model_generation===row.cleanup_generation;return {version:row.version??0,cleanup_generation:row.cleanup_generation,models:current?row.models??[]:[],source:'user_declared' as const,scope:'session' as const,can_edit:actor.user_id===row.user_id,updated_at:current?row.updated_at?.toISOString()??null:null};}
 async function read(token:string,id:string){
  const actor=await identity.requireUser(token);const row=await context(db,actor,id);const latest=await identity.requireUser(token);
  if(latest.user_id!==row.user_id&&!latest.roles.includes('super'))throw new DomainError('not_found',404);
  if((await db.query<{cleanup_generation:number}>('SELECT cleanup_generation FROM users WHERE id=$1',[row.user_id])).rows[0]?.cleanup_generation!==row.cleanup_generation)throw new DomainError('content_changed',409);
  return output(row,latest);
 }
 async function replace(token:string,id:string,input:{version:number;cleanup_generation:number;models:string[]}){
  if(!Number.isSafeInteger(input.version)||input.version<0||!Number.isSafeInteger(input.cleanup_generation)||input.cleanup_generation<0||!Array.isArray(input.models)||input.models.length>10||input.models.some(value=>typeof value!=='string'||!value.trim()||value.trim().length>120||hasControl(value)))throw new DomainError('invalid_model_declaration',422);
  const models=[...new Set(input.models.map(value=>value.trim()))];
  return identity.mutate(token,async(client,actor)=>{
   const row=await context(client,actor,id);if(actor.user_id!==row.user_id)throw new DomainError('forbidden',403);
   if(row.cleanup_generation!==input.cleanup_generation)throw new DomainError('content_changed',409);
   if((row.version??0)!==input.version)throw new DomainError('version_conflict',409);
   const updated=now();const version=input.version+1;
   await client.query(`INSERT INTO session_personal_models(session_id,user_id,models,version,cleanup_generation,updated_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(session_id) DO UPDATE SET models=excluded.models,version=excluded.version,cleanup_generation=excluded.cleanup_generation,updated_at=excluded.updated_at`,[id,row.user_id,JSON.stringify(models),version,row.cleanup_generation,updated]);
   await client.query('INSERT INTO personal_model_revisions(user_id,revision) VALUES($1,1) ON CONFLICT(user_id) DO UPDATE SET revision=personal_model_revisions.revision+1',[row.user_id]);
   await client.query('INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4)',[actor.user_id,models.length?'personal_models_confirmed':'personal_models_revoked',id,{source:'user_declared',scope:'session',before_count:row.model_generation===row.cleanup_generation?row.models?.length??0:0,after_count:models.length}]);
   return output({...row,models,version,model_generation:row.cleanup_generation,updated_at:updated},actor);
  });
 }
 return {read,replace};
}
export type SessionPersonalModelService=ReturnType<typeof createSessionPersonalModelService>;
