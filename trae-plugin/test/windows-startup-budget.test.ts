import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';

async function windowsModule(path:URL,delay:number,stdout:string,onCall?:(file:string,args:string[])=>void){
 const {code}=await transform(await readFile(path,'utf8'),{loader:'ts',format:'cjs',target:'node18'});
 const actualRequire=createRequire(path),module={exports:{} as Record<string,(...args:unknown[])=>Promise<unknown>>};
 const invoke=promisify(execFile);
 runInNewContext(code,{module,exports:module.exports,Buffer,process:{platform:'win32',pid:process.pid,env:{},hrtime:process.hrtime},require:(name:string)=>name==='node:util'?{promisify:()=>async(file:string,args:string[],options:Parameters<typeof invoke>[2])=>{onCall?.(file,args);return invoke(process.execPath,['-e',`setTimeout(()=>process.stdout.write(${JSON.stringify(stdout)}),${delay})`],options);}}:actualRequire(name)});
 return module.exports;
}

test('Windows 权限设置允许正常的较慢进程启动，不在五秒时误杀',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-windows-acl-budget-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const implementation=await windowsModule(new URL('../src/private-files.ts',import.meta.url),5500,'S-1-5-21-111-222-333-1001');
 await implementation.preparePrivateDirectory!(directory);
});

test('Windows 原子替换文件复用当前用户 SID，保护失败不能误报成功',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-windows-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sid='S-1-5-21-111-222-333-1001',calls:{file:string;args:string[]}[]=[];let fail=false;
 const implementation=await windowsModule(new URL('../src/private-files.ts',import.meta.url),0,sid,(file,args)=>{calls.push({file,args});if(fail)throw new Error('synthetic_owner_failure');});
 await implementation.preparePrivateDirectory!(directory);const path=join(directory,'runtime.tmp');await writeFile(path,'{}');
 await implementation.protectPrivateFile!(path);
 assert.equal(calls.length,2);assert.ok(calls[0]!.file.endsWith('powershell.exe'));assert.ok(calls[1]!.file.endsWith('icacls.exe'));
 assert.equal(JSON.stringify(calls[1]!.args),JSON.stringify([path,'/setowner','*'+sid,'/L','/Q']));
 fail=true;await assert.rejects(implementation.protectPrivateFile!(path),{message:'unsafe_runtime_file'});
});

test('Windows 未确认当前用户 SID 时不发布文件',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-windows-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const implementation=await windowsModule(new URL('../src/private-files.ts',import.meta.url),0,'');
 await assert.rejects(implementation.preparePrivateDirectory!(directory),{message:'unsafe_private_directory'});
 const path=join(directory,'runtime.tmp');await writeFile(path,'{}');
 await assert.rejects(implementation.protectPrivateFile!(path),{message:'unsafe_runtime_file'});
});

test('Windows 运行时钟允许超过十秒的冷启动，并保留时钟校验',async()=>{
 const value={kind:'windows-qpc-v1',scope:`windows:${process.pid}:1`,monotonic_ms:1000,active_scopes:[]};
 const implementation=await windowsModule(new URL('../../apps/hook-client/src/runtime-clock.ts',import.meta.url),11000,JSON.stringify(value));
 const clock=await implementation.readLeaseClock!();assert.equal(JSON.stringify(clock),JSON.stringify(value));
});
