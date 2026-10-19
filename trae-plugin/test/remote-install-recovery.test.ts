import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {installRemoteHook} from '../src/remote-hook-install.js';
const names=['sender.cjs','send.sh','receipt.json','hooks.json'] as const;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('write-ahead installation resumes after each replacement on first install and update, preserving external edits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-install-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const base=await installRemoteHook(root,Buffer.from('new sender'),process.execPath),path=(name:string)=>name==='hooks.json'?join(root,'.trae',name):join(base,name);
 const after=await Promise.all(names.map(name=>readFile(path(name))));
 await installRemoteHook(root,Buffer.from('previous sender'),process.execPath);const old=await Promise.all(names.map(name=>readFile(path(name))));
 for(const before of [names.map(()=>undefined),old])for(let applied=0;applied<=names.length;applied++){
  const files=names.map((name,index)=>({name,before:before[index]?hash(before[index]!):null,after:after[index]!.toString('base64')}));
  // Recreate the bytes left by a crash immediately after publishing the journal
  // or any of the four managed replacements, including the executable gap.
  await writeFile(join(base,'pending.json'),JSON.stringify({version:2,files}));
  for(const [index,name]of names.entries()){const bytes=index<applied?after[index]:before[index];if(bytes)await writeFile(path(name),bytes);else await rm(path(name),{force:true});}
  await installRemoteHook(root,Buffer.from('new sender'),process.execPath);
  for(const [index,name]of names.entries())assert.deepEqual(await readFile(path(name)),after[index]);
  await assert.rejects(readFile(join(base,'pending.json')),{code:'ENOENT'});
 }
 const files=names.map((name,index)=>({name,before:hash(old[index]!),after:after[index]!.toString('base64')}));
 await writeFile(join(base,'pending.json'),JSON.stringify({version:2,files}));const manual='manually edited executable';await writeFile(path('sender.cjs'),manual);
 await assert.rejects(installRemoteHook(root,Buffer.from('new sender'),process.execPath),/managed_hooks_modified/);assert.equal(await readFile(path('sender.cjs'),'utf8'),manual);assert.ok(await readFile(join(base,'pending.json')));
});


test('oversized formatted configuration is refused before publishing a journal or executable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-install-bounds-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'.trae'));const path=join(root,'.trae','hooks.json'),original=JSON.stringify({version:1,hooks:{Stop:Array.from({length:50000},()=>({hooks:[]}))}});assert.ok(Buffer.byteLength(original)<1048576);await writeFile(path,original);
 await assert.rejects(installRemoteHook(root,Buffer.from('sender'),process.execPath),/invalid_remote_transaction/);assert.equal(await readFile(path,'utf8'),original);
 for(const name of ['pending.json','sender.cjs','send.sh','receipt.json'])await assert.rejects(readFile(join(root,'.trae','adi-remote-collector',name)),{code:'ENOENT'});
});
