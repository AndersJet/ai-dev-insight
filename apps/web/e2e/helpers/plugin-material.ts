import type {Page} from '@playwright/test';
import type {CurrentUser,PluginCredentialDto,PluginCollectionGrantDto} from '@adi/contracts';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';

// Normal authenticated Web session starts this synthetic plugin handoff; no
// password/token is put in a URL, generated command or browser storage.
export async function pluginHookMaterial(page:Page){
  const me=await page.request.get('/api/v1/me');assert.equal(me.status(),200,'normal Web authentication is required');
  const actor=(await me.json()).data as CurrentUser;assert.equal(actor.registered,true,'prepare an already-registered synthetic actor or exercise real registration first');
  const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='adi_csrf')?.value;assert.ok(csrf);
  const issued=await page.request.post('/api/v1/me/plugin-credential',{headers:{'x-csrf-token':csrf},data:{}});assert.equal(issued.status(),200,'authenticated shared plugin credential retrieval must succeed');
  const credential=(await issued.json()).data as PluginCredentialDto;assert.equal(credential.user_id,actor.user_id);
  const authorized=await page.request.post('/api/v1/plugin/collection-grant',{headers:{authorization:`Bearer ${credential.api_token}`},data:{}});assert.equal(authorized.status(),200,'a plugin-scoped collection grant is required');
  const grant=(await authorized.json()).data as PluginCollectionGrantDto;assert.equal(grant.download_path,'/api/v1/plugin/collection-client');
  const response=await page.request.get(grant.download_path,{headers:{authorization:`Bearer ${grant.authorization}`}});assert.equal(response.status(),200,'download must redeem its own scoped grant');
  const archive=await response.body();assert.equal(archive.length,grant.bytes);assert.equal(createHash('sha256').update(archive).digest('hex'),grant.sha256);
  assert.equal(response.headers()['x-archive-sha256'],grant.sha256);
  const config=JSON.parse(Buffer.from(unzipSync(archive)['adi-installation.json']!).toString('utf8')) as {installation_id:string;token:string;endpoint:string};
  assert.equal(config.installation_id,grant.installation_id);assert.equal(config.endpoint,grant.endpoint);
  const origin=new URL(page.url()).origin,runtimeOwner=createHash('sha256').update(JSON.stringify([actor.user_id,origin])).digest('hex');
  return {archive,config,runtimeOwner,issuedAt:Date.now(),origin,userId:actor.user_id};
}
