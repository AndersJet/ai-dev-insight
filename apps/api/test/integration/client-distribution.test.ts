import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync} from 'fflate';
import {pluginFixture} from '../plugin-fixture.js';
import {createApi} from '../../src/app.js';
import {loadClientDistribution} from '../../src/client-distribution.js';

test('plugin personal ZIP has reusable independent Hook credentials and actual digest; only explicit Hook reset changes them',async t=>{
 const {app,headers,bearer,installations,root}=await pluginFixture(t);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers:{...headers,origin:'http://attacker.invalid'},payload:{}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{user_id:root.user.user_id}})).statusCode,400);
 const download=async()=>{const issued=await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}});assert.equal(issued.statusCode,200);return app.inject({url:issued.json().data.download_path,headers:{authorization:'Bearer '+issued.json().data.authorization}});};
 const setup=await app.inject({url:'/api/v1/plugin/collection-setup',headers:bearer});assert.equal(setup.statusCode,200);
 const first=await download();assert.equal(first.statusCode,200);assert.equal(first.headers['content-type'],'application/zip');assert.equal(first.headers['cache-control'],'no-store, private');
 assert.equal(Number(first.headers['content-length']),first.rawPayload.length);assert.equal(first.headers['x-archive-sha256'],createHash('sha256').update(first.rawPayload).digest('hex'));
 assert.match(String(first.headers['content-disposition']),/adi-hook-client-[0-9.]+-personal.zip/);
 const files=unzipSync(first.rawPayload);assert.deepEqual(Object.keys(files).sort(),['INSTALL.md','LICENSE','NOTICE','adi-installation.json','install-hook.ps1','install-hook.sh','native-macos.js','native-windows.ps1','send-hook.ps1','send-hook.sh','send-worker.ps1']);
 assert.match(Buffer.from(files['LICENSE']!).toString('utf8'),/Apache License/);assert.match(Buffer.from(files['NOTICE']!).toString('utf8'),/AI Dev Insight/);
 const credential=JSON.parse(Buffer.from(files['adi-installation.json']!).toString('utf8'));assert.equal(credential.endpoint,'http://web.example.invalid/hooks');assert.match(credential.token,/^adi_[A-Za-z0-9_-]{43}$/);
 assert.equal((await installations.status(root.token)).installation?.id,credential.installation_id);
 const repeated=await Promise.all([download(),download(),download()]);for(const next of repeated)assert.deepEqual(next.rawPayload,first.rawPayload);assert.ok(!setup.body.includes(credential.token));
 await installations.reset(root.token);const after=JSON.parse(Buffer.from(unzipSync((await download()).rawPayload)['adi-installation.json']!).toString('utf8'));assert.notEqual(after.token,credential.token);assert.notEqual(after.installation_id,credential.installation_id);
 await installations.revoke(root.token);assert.equal((await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}})).json().error.code,'collection_reset_required');
});

test('missing endpoint, a foreign origin or tampered package cannot issue a Hook credential',async t=>{
 const {db,identity,installations,bearer,root}=await pluginFixture(t);
 const directory=await mkdtemp(join(tmpdir(),'adi-bad-release-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(join(directory,'manifest.json'),await readFile(new URL('../../../hook-client/dist/release/manifest.json',import.meta.url)));await writeFile(join(directory,'client.zip'),'tampered');
 for(const distribution of [await loadClientDistribution({directory,collectorUrl:'http://web.example.invalid/hooks'}),await loadClientDistribution({collectorUrl:'http://example.invalid/hooks?token=never-return-this'}),await loadClientDistribution({collectorUrl:'http://foreign.example.invalid/hooks'})]){
  const app=createApi(undefined,{identity,installations,clientDistribution:distribution,plugin:{db,signingKey:Buffer.alloc(32,17)},allowedOrigin:'http://web.example.invalid'});t.after(()=>app.close());
  const reply=await app.inject({method:'POST',url:'/api/v1/plugin/collection-grant',headers:bearer,payload:{}});assert.equal(reply.statusCode,503);assert.ok(!reply.body.includes('never-return-this'));
 }
 assert.equal((await installations.status(root.token)).installation,null);
});
