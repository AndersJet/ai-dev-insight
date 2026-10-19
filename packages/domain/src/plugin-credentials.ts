import {createHash,createHmac,randomBytes,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import type {Database,Queryable,Transaction} from '@adi/storage';
import type {IdentityService} from './identity.js';
import {DomainError} from './errors.js';
import type {PluginCredentialDto,PluginCredentialStatusDto,PluginSourceRegistration} from '@adi/contracts';
type Owner={id:string;email_key:string;display_name:string;status:string;registered_at:Date|null;cleanup_generation:number};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function createPluginCredentialService(db:Database,identity:Pick<IdentityService,'mutate'|'requireUser'|'normalizeEmail'>,options:{encryptionKey:Buffer;clock?:()=>Date}){
  const now=options.clock??(()=>new Date());
  if(options.encryptionKey.length!==32)throw new Error('Invalid plugin encryption key');
  const key=createHmac('sha256',options.encryptionKey).update('adi:plugin:account-encryption:v2').digest();
  function encrypt(value:string,owner:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(`adi:plugin:account:v2:${owner}`));const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64');}
  function decrypt(value:string,owner:string){try{const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(`adi:plugin:account:v2:${owner}`));cipher.setAuthTag(bytes.subarray(12,28));const token=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');if(!/^adi_api_v2\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error('invalid');return token;}catch{throw new DomainError('plugin_key_unavailable',503);}}
  async function eligible(sql:Queryable,userId:string){
    const state=(await sql.query<{recovery_id:string|null;collection_enabled:boolean;collection_baseline_at:Date|null}>('SELECT recovery_id,collection_enabled,collection_baseline_at FROM data_identity FOR SHARE')).rows[0];
    if(!state||state.recovery_id)throw new DomainError('recovery_quarantined',503);
    if(!state.collection_enabled||state.collection_baseline_at&&state.collection_baseline_at>now())throw new DomainError('collection_disabled',503);
    const owner=(await sql.query<Owner>('SELECT id,email_key,display_name,status,registered_at,cleanup_generation FROM users WHERE id=$1',[userId])).rows[0];
    if(!owner||owner.status!=='active')throw new DomainError('plugin_account_unavailable',403);
    try{identity.normalizeEmail(owner.email_key);}catch{throw new DomainError('plugin_account_unavailable',403);}if(!owner.registered_at)throw new DomainError('registration_required',409);return owner;
  }
  async function status(webToken:string):Promise<PluginCredentialStatusDto>{
    const actor=await identity.requireUser(webToken);await eligible(db,actor.user_id);
    const credential=(await db.query<{created_at:Date}>('SELECT created_at FROM plugin_account_credentials WHERE user_id=$1',[actor.user_id])).rows[0];
    const sources=(await db.query<{collector_id:string;source_config_id:string;platform:'windows'|'macos'|'linux';plugin_version:string;created_at:Date;last_seen:Date|null}>('SELECT collector_id,source_config_id,platform,plugin_version,created_at,last_seen FROM plugin_collectors WHERE user_id=$1 ORDER BY created_at,collector_id',[actor.user_id])).rows;
    await identity.requireUser(webToken);
    return {credential:credential?{created_at:credential.created_at.toISOString()}:null,sources:sources.map(source=>({...source,created_at:source.created_at.toISOString(),last_seen:source.last_seen?.toISOString()??null}))};
  }
  async function credential(webToken:string):Promise<PluginCredentialDto>{return identity.mutate(webToken,async(sql,actor)=>{
    const owner=await eligible(sql,actor.user_id);
    let row=(await sql.query<{credential_ciphertext:string;created_at:Date}>('SELECT credential_ciphertext,created_at FROM plugin_account_credentials WHERE user_id=$1',[actor.user_id])).rows[0];
    if(!row){const token=`adi_api_v2.${randomBytes(32).toString('base64url')}`;row=(await sql.query<{credential_ciphertext:string;created_at:Date}>('INSERT INTO plugin_account_credentials(user_id,token_hash,credential_ciphertext) VALUES($1,$2,$3) RETURNING credential_ciphertext,created_at',[actor.user_id,digest(token),encrypt(token,actor.user_id)])).rows[0]!;await sql.query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'plugin_account_credential_created',$1)",[actor.user_id]);}
    return {api_token:decrypt(row.credential_ciphertext,actor.user_id),user_id:owner.id,email:owner.email_key,created_at:row.created_at.toISOString()};
  });}
  function credentialHash(token:string){if(!/^adi_api_v2\.[A-Za-z0-9_-]{43}$/.test(token))throw new DomainError('plugin_unauthorized',401);return digest(token);}
  async function authorize(token:string){
    await db.assertNotRecovering();
    const row=(await db.query<{user_id:string}>('SELECT user_id FROM plugin_account_credentials WHERE token_hash=$1',[credentialHash(token)])).rows[0];
    if(!row)throw new DomainError('plugin_unauthorized',401);return eligible(db,row.user_id);
  }
  async function mutate<T>(token:string,work:(sql:Transaction,owner:Owner)=>Promise<T>){
    const hash=credentialHash(token);
    return db.transaction(async sql=>{
      const state=(await sql.query<{recovery_id:string|null}>('SELECT recovery_id FROM data_identity FOR SHARE')).rows[0];if(!state||state.recovery_id)throw new DomainError('recovery_quarantined',503);
      const row=(await sql.query<{user_id:string}>('SELECT p.user_id FROM plugin_account_credentials p JOIN users u ON u.id=p.user_id WHERE p.token_hash=$1 FOR UPDATE OF u',[hash])).rows[0];
      if(!row)throw new DomainError('plugin_unauthorized',401);return work(sql,await eligible(sql,row.user_id));
    });
  }
  function sourceHash(secret:string){const bytes=Buffer.from(secret,'base64url');if(!/^[A-Za-z0-9_-]{43}$/.test(secret)||bytes.length!==32||bytes.toString('base64url')!==secret)throw new DomainError('plugin_unauthorized',401);return digest('adi:plugin:source-proof:v2:'+secret);}
  async function registerSource(token:string,input:PluginSourceRegistration){return mutate(token,async(sql,owner)=>{
    const proof=sourceHash(input.source_secret),hex=digest('adi:plugin:collector:v2:'+input.source_secret).slice(0,32).split('');hex[12]='4';hex[16]=((parseInt(hex[16]!,16)&3)|8).toString(16);const text=hex.join(''),id=`${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
    const existing=(await sql.query<{user_id:string;source_secret_hash:string}>('SELECT user_id,source_secret_hash FROM plugin_collectors WHERE collector_id=$1 FOR UPDATE',[id])).rows[0];
    if(existing&&(existing.user_id!==owner.id||existing.source_secret_hash!==proof))throw new DomainError('plugin_unauthorized',401);
    const saved=await sql.query('INSERT INTO plugin_collectors(collector_id,user_id,source_config_id,source_secret_hash,platform,plugin_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(collector_id) DO UPDATE SET source_config_id=excluded.source_config_id,platform=excluded.platform,plugin_version=excluded.plugin_version WHERE plugin_collectors.user_id=excluded.user_id AND plugin_collectors.source_secret_hash=excluded.source_secret_hash RETURNING collector_id',[id,owner.id,input.source_config_id,proof,input.platform,input.plugin_version]);
    if(!saved.rowCount)throw new DomainError('plugin_unauthorized',401);
    return {collector_id:id,source_config_id:input.source_config_id,user_id:owner.id,email:owner.email_key};
  });}
  async function authorizeSource(token:string,collectorId:string,configId:string,secret:string,platform:string){
    const owner=await authorize(token),proof=sourceHash(secret);
    const source=(await db.query<{source_secret_hash:string}>('SELECT source_secret_hash FROM plugin_collectors WHERE collector_id=$1 AND user_id=$2 AND source_config_id=$3 AND platform=$4',[collectorId,owner.id,configId,platform])).rows[0];
    if(!source||!timingSafeEqual(Buffer.from(source.source_secret_hash,'hex'),Buffer.from(proof,'hex')))throw new DomainError('plugin_unauthorized',401);
    return owner;
  }
  async function markSaved(userId:string,collectorId:string,receivedAt:string){await db.query('UPDATE plugin_collectors SET last_seen=GREATEST(last_seen,$3::timestamptz) WHERE user_id=$1 AND collector_id=$2',[userId,collectorId,receivedAt]);}
  return {status,credential,authorize,mutate,registerSource,authorizeSource,markSaved};
}
export type PluginCredentialService=ReturnType<typeof createPluginCredentialService>;
