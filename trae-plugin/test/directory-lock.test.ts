import {test} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {mkdtemp,rm,mkdir,readdir,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {acquireDirectoryLock} from '../src/directory-lock.js';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';

test('contended windows back off filesystem polling and still cancel promptly',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-directory-backoff-')),path=join(directory,'lock');let reads=0;
 const release=await acquireDirectoryLock(directory,'lock'),original=fs.lstat;
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof original>)=>{if(args[0]===path)reads++;return original(...args);});syncBuiltinESMExports();
 const controller=new AbortController(),started=performance.now();const timer=setTimeout(()=>controller.abort(),500);
 try{await assert.rejects(acquireDirectoryLock(directory,'lock',controller.signal,5000),/directory_lock_aborted/);assert.ok(reads<=24,`a waiting window performed ${reads} reservation reads in 500ms`);assert.ok(performance.now()-started<1000);}
 finally{clearTimeout(timer);t.mock.restoreAll();syncBuiltinESMExports();await release();await rm(directory,{recursive:true,force:true});}
});

test('a directory reservation left by a real exited process can be acquired again',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-directory-lock-'));
  try{
    const script=`import {acquireDirectoryLock} from ${JSON.stringify(new URL('../src/directory-lock.ts',import.meta.url).href)};await acquireDirectoryLock(process.argv[1],'install.lock');process.stdout.write('reserved');`;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,directory],{stdio:['ignore','pipe','pipe']});
    let output='',failure='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{failure+=value;});
    const [code]=await once(child,'close');assert.equal(code,0,failure);assert.equal(output,'reserved');
    const release=await acquireDirectoryLock(directory,'install.lock',undefined,0);await release();
    const next=await acquireDirectoryLock(directory,'install.lock',undefined,200);await next();
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('empty and unknown directory reservations require repair and stay intact',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-directory-lock-'));
  try{
    for(const name of ['empty.lock','unknown.lock'])await mkdir(join(directory,name));
    await writeFile(join(directory,'unknown.lock','foreign.txt'),'synthetic unknown owner');
    for(const name of ['empty.lock','unknown.lock'])await assert.rejects(acquireDirectoryLock(directory,name,undefined,30),/directory_lock_invalid/);
    assert.deepEqual(await readdir(join(directory,'empty.lock')),[]);
    assert.equal(await readFile(join(directory,'unknown.lock','foreign.txt'),'utf8'),'synthetic unknown owner');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('live directory owners serialize concurrent work and cancellation releases only the contender',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-directory-lock-'));let active=0,maximum=0,completed=0;
  try{
    await Promise.all(Array.from({length:8},async()=>{
      const release=await acquireDirectoryLock(directory,'lock',undefined,1500);
      try{active++;maximum=Math.max(maximum,active);await delay(5);completed++;active--;}finally{await release();}
    }));
    assert.equal(maximum,1);assert.equal(completed,8);
    const release=await acquireDirectoryLock(directory,'lock'),controller=new AbortController();
    const contender=acquireDirectoryLock(directory,'lock',controller.signal,1500);controller.abort();
    await assert.rejects(contender,/directory_lock_aborted/);
    await assert.rejects(acquireDirectoryLock(directory,'lock',undefined,30),/directory_lock_busy/);
    await release();await release();
    assert.deepEqual(await readdir(directory),[]);
    const next=await acquireDirectoryLock(directory,'lock');await next();
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a contender can wait through the empty directory between owner unlink and directory removal',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-directory-lock-'));
  let removal:Promise<void>|undefined;
  try{
    await acquireDirectoryLock(directory,'lock');
    const published=join(directory,'lock'),[owner]=await readdir(published);
    // Hold the filesystem state produced by release between its two async operations.
    await unlink(join(published,owner!));
    removal=delay(30).then(()=>rmdir(published));
    const acquisition=acquireDirectoryLock(directory,'lock',undefined,500);
    await assert.doesNotReject(acquisition);
    const release=await acquisition;await removal;await release();
    assert.deepEqual(await readdir(directory),[]);
  }finally{await removal;await rm(directory,{recursive:true,force:true});}
});
