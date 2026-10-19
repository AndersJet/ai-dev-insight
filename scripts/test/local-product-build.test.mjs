import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
import {URL} from 'node:url';
const exec=promisify(execFile),options={skip:process.platform==='win32'};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'adi-local-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'deploy/product'),{recursive:true});await mkdir(join(root,'bin'));
  await copyFile(new URL('../../deploy/product/build-local.sh',import.meta.url),join(root,'deploy/product/build-local.sh'));
  await writeFile(join(root,'deploy/product/Dockerfile'),'FROM scratch\n');await writeFile(join(root,'.gitignore'),'.run/\n');
  await writeFile(join(root,'bin/docker'),'#!'+process.execPath+'\n'+String.raw`
const fs=require('node:fs'),args=process.argv.slice(2),state=process.env.FIXTURE_ROOT+'/.run';fs.mkdirSync(state,{recursive:true});fs.appendFileSync(state+'/calls',JSON.stringify(args)+'\n');
if(args[0]==='build'){if(args[args.indexOf('--target')+1]===process.env.FIXTURE_FAIL)process.exit(7);process.exit(0);}
if(args[0]==='image'&&args[1]==='inspect'){const format=args.at(-1);if(format.includes('.Architecture'))console.log('arm64');else if(format.includes('revision'))console.log(process.env.FIXTURE_REVISION);else console.log('sha256:'+'a'.repeat(64));}
if(args[0]==='run'&&args.includes('process.arch'))console.log('arm64');
`,{mode:0o755});
  const env={...process.env,GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.org',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.org'};
  for(const args of [['init','-q'],['add','.'],['commit','-qm','fixture']])await exec('git',args,{cwd:root,env});
  const sha=(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
  return {root,sha,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,FIXTURE_ROOT:root,FIXTURE_REVISION:sha}};
}

test('local build creates four verified images with one revision and keeps them for offline export without publication',options,async t=>{
  const f=await fixture(t);await exec('/bin/sh',['deploy/product/build-local.sh','--platform','linux/arm64'],{cwd:f.root,env:f.env});
  const report=await readFile(join(f.root,'.run/local-product-images.txt'),'utf8');assert.ok(report.includes(f.sha));
  const calls=(await readFile(join(f.root,'.run/calls'),'utf8')).trim().split('\n').map(JSON.parse),builds=calls.filter(args=>args[0]==='build');
  assert.deepEqual(builds.map(args=>args[args.indexOf('--target')+1]),['api','collector','worker','web']);
  for(const args of builds){assert.ok(args.includes('org.opencontainers.image.revision='+f.sha));assert.ok(args.includes('ADI_CI_NPM_REGISTRY=https://registry.npmjs.org/'));assert.ok(args.includes('local/ai-dev-insight-'+args[args.indexOf('--target')+1]+':'+f.sha));}
  assert.equal(calls.some(args=>['login','push','rm'].includes(args[0])||args[0]==='image'&&args[1]==='rm'),false);
  assert.equal(report.trim().split('\n').length,5);
});

test('a partial build removes stale success evidence and cannot be exported as a complete release',options,async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'.run'));await writeFile(join(f.root,'.run/local-product-images.txt'),'stale success');
  await assert.rejects(exec('/bin/sh',['deploy/product/build-local.sh','--platform','linux/arm64'],{cwd:f.root,env:{...f.env,FIXTURE_FAIL:'worker'}}));
  await assert.rejects(readFile(join(f.root,'.run/local-product-images.txt')),{code:'ENOENT'});
});

test('local release refuses dirty sources and credentials in registry configuration before Docker is invoked',options,async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'unreviewed.txt'),'unreviewed');
  await assert.rejects(exec('/bin/sh',['deploy/product/build-local.sh'],{cwd:f.root,env:f.env}),error=>/clean working tree/i.test(error.stderr));
  await rm(join(f.root,'unreviewed.txt'));
  await assert.rejects(exec('/bin/sh',['deploy/product/build-local.sh','--registry','https://secret@example.org/'],{cwd:f.root,env:f.env}),error=>!/secret/.test(error.stderr));
  await assert.rejects(readFile(join(f.root,'.run/calls')),{code:'ENOENT'});
});
