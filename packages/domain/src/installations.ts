import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import type { Database, Queryable, Transaction } from '@adi/storage';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';
import type { CurrentUser } from '@adi/contracts';

type InstallationRow = { id: string; label: string; enabled: boolean; created_at: Date; last_seen: Date | null; revoked_at: Date | null; credential_ciphertext: string | null };
const columns = 'id,label,enabled,created_at,last_seen,revoked_at,credential_ciphertext';
function dto(row: InstallationRow) {
  return { id: row.id, label: row.label, enabled: row.enabled, created_at: row.created_at.toISOString(), last_seen: row.last_seen?.toISOString() ?? null, revoked_at: row.revoked_at?.toISOString() ?? null };
}
export function createInstallationService(db: Database, identity: IdentityService, options: { encryptionKey?: Buffer; clock?: () => Date } = {}) {
  const now = options.clock ?? (() => new Date());
  const key = options.encryptionKey && Buffer.from(options.encryptionKey);
  if (key && key.length !== 32) throw new Error('Invalid installation encryption key');
  const grantKey = key && createHmac('sha256', key).update('adi-online-install-grant-key-v1').digest();
  const scope = (actor: CurrentUser, targetId?: string) => {
    if (targetId !== undefined && !actor.roles.includes('super')) throw new DomainError('forbidden', 403);
    return targetId ?? actor.user_id;
  };
  function encrypt(secret: string, owner: string, id: string) {
    if (!key) throw new DomainError('collection_key_unavailable', 503);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${owner}:${id}`));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  function decrypt(value: string, owner: string, id: string) {
    if (!key) throw new DomainError('collection_key_unavailable', 503);
    try {
      const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(`${owner}:${id}`)); cipher.setAuthTag(bytes.subarray(12, 28));
      const secret = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
      if (!/^adi_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid secret');
      return secret;
    } catch { throw new DomainError('collection_key_unavailable', 503); }
  }
  async function snapshot(sql: Queryable, owner: string) {
    const row = (await sql.query<InstallationRow>(`SELECT ${columns} FROM installations WHERE user_id=$1 AND credential_ciphertext IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`, [owner])).rows[0];
    const stats = (await sql.query<{ legacy: string; total: string; last_seen: Date | null }>('SELECT count(*) FILTER (WHERE enabled AND credential_ciphertext IS NULL) AS legacy,count(*) AS total,max(last_seen) AS last_seen FROM installations WHERE user_id=$1', [owner])).rows[0]!;
    return { installation: row ? dto(row) : null, legacy_installations: Number(stats.legacy), reset_required: row ? !row.enabled : Number(stats.total) > 0, last_seen: stats.last_seen?.toISOString() ?? null };
  }
  async function registered(sql: Queryable, owner: string) {
    const user = (await sql.query<{ status: string; registered_at: Date | null }>('SELECT status,registered_at FROM users WHERE id=$1', [owner])).rows[0];
    if (!user) throw new DomainError('not_found', 404);
    if (user.status !== 'active') throw new DomainError('account_inactive', 409);
    if (!user.registered_at) throw new DomainError('registration_required', 409);
  }
  async function issue(sql: Transaction, owner: string) {
    const id = randomUUID(), secret = `adi_${randomBytes(32).toString('base64url')}`;
    const encrypted = encrypt(secret, owner, id);
    const row = (await sql.query<InstallationRow>(`INSERT INTO installations(id,user_id,token_hash,label,credential_ciphertext) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`, [id, owner, createHash('sha256').update(secret).digest('hex'), '账号共用采集凭据', encrypted])).rows[0]!;
    await sql.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'installation_created',$2,$3)", [owner, id, { user_id: owner }]);
    return { installation: dto(row), token: secret };
  }
  async function disable(sql: Transaction, actor: string, owner: string) {
    const rows = await sql.query<{ id: string }>('UPDATE installations SET enabled=false,revoked_at=clock_timestamp() WHERE user_id=$1 AND enabled RETURNING id', [owner]);
    for (const row of rows.rows) await sql.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'installation_revoked',$2,$3)", [actor, row.id, { user_id: owner }]);
  }
  // Identity mutations serialize on the account row: simultaneous first downloads
  // issue exactly one credential; resets and revocations share the same lock.
  async function accountCredential(sql: Transaction, owner: string) {
    await registered(sql, owner);
    const row = (await sql.query<InstallationRow>(`SELECT ${columns} FROM installations WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [owner])).rows[0];
    if (!row) return issue(sql, owner);
    const current = (await sql.query<InstallationRow>(`SELECT ${columns} FROM installations WHERE user_id=$1 AND enabled AND credential_ciphertext IS NOT NULL`, [owner])).rows[0];
    if (!current) throw new DomainError('collection_reset_required', 409);
    return { installation: dto(current), token: decrypt(current.credential_ciphertext!, owner, current.id) };
  }
  async function credential(token: string) {
    return identity.mutate(token, (sql, actor) => accountCredential(sql, actor.user_id));
  }
  function grantSignature(payload: string) {
    if (!grantKey) throw new DomainError('collection_key_unavailable', 503);
    return createHmac('sha256', grantKey).update('adi-online-install-v1\0' + payload).digest();
  }
  async function issueDownloadGrant(token: string) {
    return identity.mutate(token, async (sql, actor) => {
      const current = await accountCredential(sql, actor.user_id);
      const auth = (await sql.query<{ auth_version: number }>('SELECT auth_version FROM users WHERE id=$1', [actor.user_id])).rows[0]!;
      const expires = new Date(now().getTime() + 30 * 60_000);
      const payload = Buffer.from(JSON.stringify({ i: current.installation.id, a: auth.auth_version, e: expires.getTime(), n: randomBytes(16).toString('hex') })).toString('base64url');
      const authorization = `adi_dl_${payload}.${grantSignature(payload).toString('base64url')}`;
      await sql.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'installation_command_issued',$2,$3)", [actor.user_id, current.installation.id, { expires_at: expires.toISOString() }]);
      return { authorization, expires_at: expires.toISOString(), installation_id: current.installation.id };
    });
  }
  function parseGrant(value: string) {
    const match = /^adi_dl_([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match || !timingSafeEqual(grantSignature(match[1]!), Buffer.from(match[2]!, 'base64url'))) throw new DomainError('invalid_installation_command', 401);
    let claim: { i: string; a: number; e: number; n: string };
    try { claim = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); }
    catch { throw new DomainError('invalid_installation_command', 401); }
    if (!claim || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(claim.i) || !Number.isSafeInteger(claim.a) || !Number.isSafeInteger(claim.e) || !/^[0-9a-f]{32}$/.test(claim.n)) throw new DomainError('invalid_installation_command', 401);
    if (claim.e <= now().getTime()) throw new DomainError('installation_command_expired', 410);
    return claim;
  }
  async function redeemDownloadGrant(authorization: string) {
    const claim = parseGrant(authorization);
    return db.transaction(async sql => {
      const state = (await sql.query<{ recovery_id: string | null }>('SELECT recovery_id FROM data_identity FOR SHARE')).rows[0];
      if (!state || state.recovery_id) throw new DomainError('recovery_quarantined', 503);
      const source = (await sql.query<{ user_id: string }>('SELECT user_id FROM installations WHERE id=$1', [claim.i])).rows[0];
      if (!source) throw new DomainError('invalid_installation_command', 401);
      // Same lock order as reset/revoke: account first, then installation.
      const user = (await sql.query<{ status: string; registered_at: Date | null; auth_version: number; email_key: string }>('SELECT status,registered_at,auth_version,email_key FROM users WHERE id=$1 FOR SHARE', [source.user_id])).rows[0];
      if (!user || user.status !== 'active' || !user.registered_at || user.auth_version !== claim.a) throw new DomainError('invalid_installation_command', 401);
      identity.normalizeEmail(user.email_key);
      const row = (await sql.query<InstallationRow>(`SELECT ${columns} FROM installations WHERE id=$1 AND user_id=$2 AND enabled FOR SHARE`, [claim.i, source.user_id])).rows[0];
      if (!row?.credential_ciphertext) throw new DomainError('invalid_installation_command', 401);
      if (claim.e <= now().getTime()) throw new DomainError('installation_command_expired', 410);
      return { installation: dto(row), token: decrypt(row.credential_ciphertext, source.user_id, row.id) };
    });
  }
  async function reset(token: string) {
    return identity.mutate(token, async (sql, actor) => {
      await registered(sql, actor.user_id);
      await disable(sql, actor.user_id, actor.user_id);
      await issue(sql, actor.user_id);
      await sql.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'collection_credentials_reset',$1,'{}')", [actor.user_id]);
      return snapshot(sql, actor.user_id);
    });
  }
  // Called only inside the account plugin credential's authenticated user lock.
  async function issuePluginDownloadGrant(sql:Transaction,owner:string){
    const issued=await accountCredential(sql,owner);
    const state=(await sql.query<{dataset_id:string;auth_version:number}>('SELECT d.dataset_id,u.auth_version FROM data_identity d CROSS JOIN users u WHERE u.id=$1',[owner])).rows[0]!;
    const expires=new Date(now().getTime()+30*60_000);
    const payload=Buffer.from(JSON.stringify({i:issued.installation.id,a:state.auth_version,d:state.dataset_id,e:expires.getTime(),n:randomBytes(16).toString('hex')})).toString('base64url');
    if(!grantKey)throw new DomainError('collection_key_unavailable',503);
    const signature=createHmac('sha256',grantKey).update('adi-plugin-package-v2\0'+payload).digest('base64url');
    await sql.query("INSERT INTO audit_events(actor_id,action,target_id,metadata) VALUES($1,'plugin_installation_material_issued',$2,$3)",[owner,issued.installation.id,{expires_at:expires.toISOString()}]);
    return {authorization:`adi_pkg_v2.${payload}.${signature}`,expires_at:expires.toISOString(),installation_id:issued.installation.id,issued};
  }
  async function redeemPluginDownloadGrant(authorization:string){
    const match=/^adi_pkg_v2\.([A-Za-z0-9_-]{1,700})\.([A-Za-z0-9_-]{43})$/.exec(authorization);
    if(!match)throw new DomainError('invalid_installation_command',401);if(!grantKey)throw new DomainError('collection_key_unavailable',503);
    const expected=createHmac('sha256',grantKey).update('adi-plugin-package-v2\0'+match[1]!).digest(),actual=Buffer.from(match[2]!,'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new DomainError('invalid_installation_command',401);
    let claim:{i:string;a:number;d:string;e:number;n:string};try{claim=JSON.parse(Buffer.from(match[1]!,'base64url').toString('utf8'));}catch{throw new DomainError('invalid_installation_command',401);}
    const validUuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
    if(!claim||!validUuid(claim.i)||!validUuid(claim.d)||!Number.isSafeInteger(claim.a)||!Number.isSafeInteger(claim.e)||!/^[a-f0-9]{32}$/.test(claim.n))throw new DomainError('invalid_installation_command',401);
    if(claim.e<=now().getTime())throw new DomainError('installation_command_expired',410);
    return db.transaction(async sql=>{
      const state=(await sql.query<{dataset_id:string;recovery_id:string|null;collection_enabled:boolean;collection_baseline_at:Date|null}>('SELECT dataset_id,recovery_id,collection_enabled,collection_baseline_at FROM data_identity FOR SHARE')).rows[0];
      if(!state||state.recovery_id)throw new DomainError('recovery_quarantined',503);if(state.dataset_id!==claim.d)throw new DomainError('invalid_installation_command',401);
      if(!state.collection_enabled||state.collection_baseline_at&&state.collection_baseline_at>now())throw new DomainError('collection_disabled',503);
      const installation=(await sql.query<{user_id:string}>('SELECT user_id FROM installations WHERE id=$1',[claim.i])).rows[0];if(!installation)throw new DomainError('invalid_installation_command',401);
      const owner=(await sql.query<{status:string;registered_at:Date|null;auth_version:number;email_key:string}>('SELECT status,registered_at,auth_version,email_key FROM users WHERE id=$1 FOR SHARE',[installation.user_id])).rows[0];
      if(!owner||owner.status!=='active'||!owner.registered_at||owner.auth_version!==claim.a)throw new DomainError('invalid_installation_command',401);identity.normalizeEmail(owner.email_key);
      const row=(await sql.query<InstallationRow>(`SELECT ${columns} FROM installations WHERE id=$1 AND user_id=$2 AND enabled FOR SHARE`,[claim.i,installation.user_id])).rows[0];
      if(!row?.credential_ciphertext)throw new DomainError('invalid_installation_command',401);if(claim.e<=now().getTime())throw new DomainError('installation_command_expired',410);
      return {installation:dto(row),token:decrypt(row.credential_ciphertext,installation.user_id,row.id)};
    });
  }
  async function status(token: string, targetId?: string) {
    const actor = await identity.requireUser(token), owner = scope(actor, targetId);
    if (!(await db.query('SELECT 1 FROM users WHERE id=$1', [owner])).rowCount) throw new DomainError('not_found', 404);
    return snapshot(db, owner);
  }
  async function revoke(token: string, targetId?: string) {
    await identity.mutate(token, async (sql, actor) => {
      const owner = scope(actor, targetId);
      if (!(await sql.query('SELECT 1 FROM users WHERE id=$1', [owner])).rowCount) throw new DomainError('not_found', 404);
      await disable(sql, actor.user_id, owner);
    }, { checkAccess: actor => { scope(actor, targetId); }, lockUserIds: targetId ? [targetId] : [] });
  }
  return { credential, issueDownloadGrant, redeemDownloadGrant,issuePluginDownloadGrant,redeemPluginDownloadGrant, reset, status: (token: string) => status(token), revoke: (token: string) => revoke(token),
    statusForUser: (token: string, owner: string) => status(token, owner), revokeForUser: (token: string, owner: string) => revoke(token, owner) };
}
export type InstallationService = ReturnType<typeof createInstallationService>;
