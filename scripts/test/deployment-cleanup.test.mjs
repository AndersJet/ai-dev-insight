import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { cleanupCandidates } from '../../deploy/manual/site-config.mjs';

const tool=fileURLToPath(new URL('../../deploy/manual/site-config.mjs',import.meta.url));
const archiver=fileURLToPath(new URL('../../deploy/manual/archive.sh',import.meta.url));
test('cleanup only selects known obsolete files and excludes live mount ancestors',()=>{
  const old='ai-dev-insight-0123456789ab-amd64-20261014T075442Z.tar.gz';
  const entries=[{name:'images.tar',type:'file'},{name:old,type:'file'},{name:'migration-data-20261010.tar.gz',type:'file'},{name:'backup.tar.gz',type:'file'},{name:'.env',type:'file'},{name:'unknown.sh',type:'file'},{name:'data',type:'bundle'}];
  assert.deepEqual(cleanupCandidates('/site',entries,['/site/images.tar']),[old]);
});
test('preview, archive and guarded 14-day purge operate on the real filesystem',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'adi-archive-')),site=join(root,'site'),work=join(root,'work');
  await mkdir(site);await mkdir(work);t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(site,'images.tar'),'rebuildable-image-archive');await writeFile(join(site,'.env'),'private configuration');
  const configured=join(site,'ai-dev-insight-0123456789ab-amd64-20261014T075442Z');await mkdir(configured);
  await writeFile(join(configured,'images.manifest'),'old bundle');await writeFile(join(configured,'.env.example'),'ADI_APP_DB_PASSWORD=\n');await writeFile(join(configured,'.env'),'ADI_APP_DB_PASSWORD=synthetic-private\n');
  const referenceFile=join(work,'protected-paths');await writeFile(referenceFile,'');
  const plan=join(work,'plan');
  const generate=async()=>{
    const result=spawnSync(process.execPath,[tool,'cleanup',site],{encoding:'utf8',env:{...process.env,ADI_DEPLOY_TOOL_WORK:work,ADI_DEPLOY_TOOL_SITE:site}});
    assert.equal(result.status,0,result.stderr);await writeFile(plan,result.stdout);return result.stdout;
  };
  const apply=mode=>spawnSync('/bin/bash',[archiver,site,plan,mode],{encoding:'utf8'});
  assert.ok(!(await generate()).includes('archive\tai-dev-insight-'));assert.equal(apply('preview').status,0);await access(join(site,'images.tar'));
  assert.equal(apply('archive').status,0);await assert.rejects(access(join(site,'images.tar')));
  const name=(await readdir(join(site,'archive')))[0],archive=join(site,'archive',name);
  assert.ok(!(await generate()).includes('purge\t'));
  await writeFile(join(archive,'.adi-managed-archive'),String(Math.floor(Date.now()/1000)-15*86400));
  await writeFile(referenceFile,join(archive,'images.tar')+'\n');assert.ok(!(await generate()).includes('purge\t'));
  await writeFile(referenceFile,'');assert.match(await generate(),/purge\tarchive\//);
  assert.equal(apply('purge').status,0);await assert.rejects(access(archive));assert.equal(await readFile(join(site,'.env'),'utf8'),'private configuration');
});
