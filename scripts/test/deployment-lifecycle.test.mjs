import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';

const manual = fileURLToPath(new URL('../../deploy/manual/', import.meta.url));
const old = 'a'.repeat(40), next = 'b'.repeat(40), options = {skip:process.platform==='win32',timeout:60000};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'adi-lifecycle-')),bin=join(root,'bin'),source=join(root,'source');
  await mkdir(bin);await cp(manual,source,{recursive:true,filter:path=>!path.includes('/offline')&&!path.includes('/.export-lock')});
  const mock=await readFile(new URL('./fixtures/deployment-docker.mjs',import.meta.url),'utf8');
  await writeFile(join(bin,'docker'),'#!'+process.execPath+'\n'+mock,{mode:0o755});
  const f={root,source,bin,target:join(root,'test'),config:join(root,'config.env'),state:join(root,'docker.json'),calls:join(root,'calls.jsonl')};
  await writeFile(f.config,'COMPOSE_PROJECT_NAME=adi-fixture\nADI_PG_ADMIN_PASSWORD=synthetic\nADI_APP_DB_PASSWORD=synthetic\nADI_ADMIN_EMAIL=admin@example.test\nADI_ADMIN_PASSWORD=synthetic\nADI_WEB_ORIGIN=http://example.test:44182\nADI_PUBLIC_COLLECTOR_URL=http://example.test:44182/hooks\nADI_WEB_HOST_PORT=44182\nADI_COLLECTOR_HOST_PORT=44187\nNOT_CODE=$(touch '+join(root,'MUST_NOT_EXIST')+')\n');
  t.after(()=>rm(root,{recursive:true,force:true}));return f;
}
function run(f,file,args=[],fail=''){
  const result=spawnSync('/bin/bash',[file,...args],{encoding:'utf8',timeout:45000,env:{...process.env,PATH:f.bin+':'+process.env.PATH,FIXTURE_STATE:f.state,FIXTURE_CALLS:f.calls,FIXTURE_FAIL:fail,...(f.composeVersion?{FIXTURE_COMPOSE_VERSION:f.composeVersion}:{})}});
  if(result.status!==0){try{const logs=readdirSync(join(f.target,'logs')).sort();result.stderr+='\nFixture log:\n'+readFileSync(join(f.target,'logs',logs.at(-1)),'utf8');}catch{/* No application log for pre-extraction failures. */}}
  return result;
}
async function pack(f,sha,kind='upgrade'){
  const output=join(f.root,sha+kind);const r=run(f,join(f.source,'export-images.sh'),['--local','--tag',sha,'--kind',kind,'--image-prefix','candidate.local/work/ai-dev-insight','--output',output]);assert.equal(r.status,0,r.stderr);
  return join(output,(await readdir(output)).find(n=>n.endsWith('.run')));
}
const deploy=(f,file,action='upgrade',fail='')=>run(f,file,[action,'--env','test','--root',f.target,...(action==='install'?['--config',f.config]:[])],fail);
async function installed(t){const f=await fixture(t),file=await pack(f,old,'install'),r=deploy(f,file,'install');assert.equal(r.status,0,r.stdout+r.stderr);return f;}
const calls=async f=>(await readFile(f.calls,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

test('one executable package installs, isolates configuration, upgrades, backs up and skips a successful repeat',options,async t=>{
  const f=await installed(t),file=await pack(f,next),r=deploy(f,file);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/自动检查通过/);
  assert.ok(r.stdout.includes('当前版本：'+old));assert.ok(r.stdout.includes('目标版本：'+next));
  await assert.rejects(access(join(f.root,'MUST_NOT_EXIST')));
  const config=JSON.parse(await readFile(join(f.target,'docker-compose.yml'),'utf8'));assert.equal(config.name,'adi-fixture');assert.ok(config.services.api.image.endsWith(':'+next));
  const backup=(await readdir(join(f.target,'backups')))[0];await access(join(f.target,'backups',backup,'.complete'));
  const snapshot=JSON.parse(await readFile(join(f.target,'backups',backup,'docker-compose.yml'),'utf8'));assert.match(snapshot.services.api.image,/^sha256:/);
  const before=(await calls(f)).length,repeat=deploy(f,file);assert.equal(repeat.status,0,repeat.stderr);assert.match(repeat.stdout,/无需升级/);
  assert.ok(!(await calls(f)).slice(before).some(a=>a.includes('stop')||a.includes('up')));
  await assert.rejects(access(join(f.target,'.deployment-pending')));
});
for(const failure of ['backup','migration','startup'])test('failure '+failure+' stops writers, retains evidence and recovers with the same package',options,async t=>{
  const f=await installed(t),file=await pack(f,next),r=deploy(f,file,'upgrade',failure);
  assert.notEqual(r.status,0);assert.match(r.stderr,/应用保持停止/);
  const state=JSON.parse(await readFile(f.state,'utf8'));for(const c of Object.values(state.containers).filter(c=>c.Config.Labels['com.docker.compose.service']!=='postgres'))assert.equal(c.State.Status,'exited');
  const record=await readFile(join(f.target,'.deployment-pending'),'utf8');assert.match(record,/version=bbbb/);
  const recovered=deploy(f,file,'recover');assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);assert.match(recovered.stdout,/自动检查通过/);
  await assert.rejects(access(join(f.target,'.deployment-pending')));
});
test('preflight rejection leaves original running services untouched',options,async t=>{
  const f=await installed(t),file=await pack(f,next),before=(await calls(f)).length,r=deploy(f,file,'upgrade','config');assert.notEqual(r.status,0);
  assert.ok(!(await calls(f)).slice(before).some(a=>a.includes('stop')||a.includes('up')));
  const state=JSON.parse(await readFile(f.state,'utf8'));for(const c of Object.values(state.containers))assert.equal(c.State.Status,'running');
});
test('first installation can recover after migration failure without deleting initialized data',options,async t=>{
  const f=await fixture(t),file=await pack(f,old,'install');assert.notEqual(deploy(f,file,'install','migration').status,0);
  const r=deploy(f,file,'recover');assert.equal(r.status,0,r.stdout+r.stderr);assert.ok(!(await calls(f)).some(a=>a.includes('down')||(a[0]==='volume'&&a[1]==='rm')));
});
test('corrupt executable payload and omitted environment are rejected before Docker changes',options,async t=>{
  const f=await fixture(t),file=await pack(f,next);await writeFile(f.calls,'');
  const bytes=await readFile(file);bytes[bytes.length-10]^=1;const broken=join(f.root,'broken.run');await writeFile(broken,bytes);
  const r=deploy(f,broken);assert.notEqual(r.status,0);assert.match(r.stderr,/校验失败/);assert.equal(await readFile(f.calls,'utf8'),'');
  const missing=run(f,file,['upgrade']);assert.notEqual(missing.status,0);assert.match(missing.stderr,/必须用 --env/);assert.equal(await readFile(f.calls,'utf8'),'');
});
test('old project identity, bind volumes and Web compatibility survive adoption',options,async t=>{
  const f=await installed(t),cfg=JSON.parse(await readFile(join(f.target,'docker-compose.yml'),'utf8'));
  cfg.services.web.security_opt=['no-new-privileges:true','seccomp=unconfined'];cfg.volumes['postgres-data'].driver_opts={type:'none',o:'bind',device:f.target+'/data/postgres-data'};
  await writeFile(join(f.target,'docker-compose.yml'),JSON.stringify(cfg));
  const file=await pack(f,next),r=deploy(f,file);assert.equal(r.status,0,r.stdout+r.stderr);
  const updated=JSON.parse(await readFile(join(f.target,'docker-compose.yml'),'utf8'));assert.deepEqual(updated.volumes,cfg.volumes);assert.deepEqual(updated.services.web.security_opt,cfg.services.web.security_opt);assert.deepEqual(updated.services.postgres,cfg.services.postgres);
});

for(const version of ['5.5.0','2.27.0-desktop.2','v2.20.2','2.19.1','2.19.1-desktop.2','invalid'])test('installer enforces Compose minimum with version '+version,options,async t=>{
  const f=await fixture(t);f.composeVersion=version;
  const file=await pack(f,old,'install'),r=deploy(f,file,'install');
  if(['5.5.0','2.27.0-desktop.2','v2.20.2'].includes(version)){
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/自动检查通过/);
  }else{
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/2\.20/);
    assert.ok(!(await calls(f)).some(a=>a.includes('stop')||a.includes('up')));
  }
});

for(const failure of ['input-truncated','input-unreadable'])test('preflight identifies '+failure+' without exposing content or stopping writers',options,async t=>{
  const f=await installed(t),file=await pack(f,next),before=(await calls(f)).length,r=deploy(f,file,'upgrade',failure);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/containers\.json/);
  assert.match(r.stderr,failure==='input-truncated'?/JSON.*SHA256/:/EACCES/);
  assert.doesNotMatch(r.stderr,/SYNTHETIC_SECRET_DO_NOT_LOG/);
  assert.ok(!(await calls(f)).slice(before).some(a=>a.includes('stop')||a.includes('up')));
  const state=JSON.parse(await readFile(f.state,'utf8'));for(const c of Object.values(state.containers))assert.equal(c.State.Status,'running');
});
