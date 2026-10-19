import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,lstat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocket} from 'node:dgram';
import {randomUUID} from 'node:crypto';
import {InstallationVerification,VERIFICATION_DURATION,LOG_LIMIT} from '../src/installation-verification.js';
import {diagnosticOperation,safeDiagnosticFailure} from '../src/diagnostics.js';
import {PluginHttpError} from '../src/http-client.js';
import {verificationEnvironment} from '../src/verification-environment.js';
import * as realFs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
async function fixture(t:{after(fn:()=>Promise<void>):void}){const directory=await mkdtemp(join(tmpdir(),'adi-verification-')),control=join(directory,'control');let now=Date.now();const options={directory,control,environment:async()=>({trae_version:'3.3.104',vscode_version:'1.107.1'}),onChange:()=>{},now:()=>now,prepare:async(path:string)=>{await mkdir(path,{recursive:true,mode:0o700});}};const manager=new InstallationVerification(options);t.after(async()=>{await manager.dispose();await rm(directory,{recursive:true,force:true});});return {manager,options,directory,control,advance:(ms:number)=>{now+=ms;}};}
const scope='a'.repeat(64);
test('新验证最多15分钟，旧30分钟验证保留身份并从原始开始时间缩短期限',async t=>{
 const f=await fixture(t);await f.manager.start(scope);const initial=f.manager.snapshot()!;
 assert.equal(initial.deadline-initial.started,15*60*1000);
 complete(f.manager);await f.manager.dispose();
 const path=join(f.manager.logDirectory,'verification.json'),legacy=JSON.parse(await readFile(path,'utf8'));legacy.deadline=legacy.started+30*60*1000;await writeFile(path,JSON.stringify(legacy));f.advance(10*60*1000);
 const restored=new InstallationVerification(f.options);t.after(()=>restored.dispose());await restored.restore();
 assert.equal(restored.snapshot()?.id,initial.id);assert.equal(restored.snapshot()?.confirmed.session,true);assert.equal(restored.snapshot()?.deadline,initial.started+15*60*1000);
 const marker=JSON.parse(await readFile(join(f.control,'verification.json'),'utf8'));assert.equal(marker.deadline,initial.started+15*60*1000);
});
test('升级时已超过15分钟的旧验证立即结束日志，已结束的旧记录完整保留',async t=>{
 const f=await fixture(t);await f.manager.start(scope);await f.manager.dispose();
 const path=join(f.manager.logDirectory,'verification.json'),legacy=JSON.parse(await readFile(path,'utf8'));legacy.deadline=legacy.started+30*60*1000;await writeFile(path,JSON.stringify(legacy));f.advance(20*60*1000);
 const restored=new InstallationVerification(f.options);t.after(()=>restored.dispose());await restored.restore();assert.equal(restored.snapshot()?.id,legacy.id);assert.equal(restored.snapshot()?.result,'unconfirmed');
 const before=await readFile(restored.snapshot()!.logPath,'utf8');restored.event('after.verification.expiry');assert.equal(await readFile(restored.snapshot()!.logPath,'utf8'),before);
 await assert.rejects(readFile(join(f.control,'verification.json')));
 for(const result of ['passed','failed','unconfirmed']){await writeFile(path,JSON.stringify({...legacy,result}));const historical=new InstallationVerification(f.options);await historical.restore();assert.equal(historical.snapshot()?.result,result);assert.equal(historical.snapshot()?.deadline,legacy.deadline);await historical.dispose();}
});
function complete(manager:InstallationVerification){for(const key of ['account','hook','version','statistics'] as const)manager.setCheck(key,true);manager.confirm('global');manager.confirm('local');manager.confirm('session');}
test('默认不记录，验证通过需自动检查与人工确认，成功仅保留结果',async t=>{
 const f=await fixture(t);diagnosticOperation('account.login')();assert.equal(f.manager.snapshot(),null);await assert.rejects(readdir(f.manager.logDirectory));
 await f.manager.start(scope);await f.manager.finish('passed');assert.equal(f.manager.snapshot()?.result,'active');f.manager.confirm('session');assert.equal(f.manager.snapshot()?.confirmed.session,false);
 complete(f.manager);assert.equal(f.manager.snapshot()?.canPass,true);await f.manager.finish('passed');assert.equal(f.manager.snapshot()?.result,'passed');assert.equal((await readdir(f.manager.logDirectory)).filter(n=>n.endsWith('.jsonl')).length,0);assert.equal(JSON.parse(await readFile(join(f.manager.logDirectory,'verification.json'),'utf8')).result,'passed');
});
test('失败保留完整操作日志，不泄漏原始错误、凭据、payload或任意字段',async t=>{
 const f=await fixture(t);await f.manager.start(scope);const finish=diagnosticOperation('account.login');finish(new Error('password-secret Bearer token-cookie source prompt body'));
 const marker=JSON.parse(await readFile(join(f.control,'verification.json'),'utf8'));const socket=createSocket('udp4');t.after(()=>{socket.close();});const packet=Buffer.from(JSON.stringify({verification:marker.verification,operation:randomUUID(),stage:'hook.response',phase:'success',http_status:200,payload:'private prompt',token:'secret'}));await new Promise<void>((resolve,reject)=>socket.send(packet,marker.port,'127.0.0.1',e=>e?reject(e):resolve()));await new Promise(resolve=>setTimeout(resolve,25));
 await f.manager.finish('failed');const text=await readFile(f.manager.snapshot()!.logPath,'utf8');assert.match(text,/account.login/);assert.match(text,/hook.response/);assert.match(text,/unclassified/);assert.doesNotMatch(text,/password-secret|token-cookie|private prompt|"payload"|"token"/);assert.equal(f.manager.snapshot()?.confirmed.session,false,'HTTP200不能代替平台人工确认');await assert.rejects(readFile(join(f.control,'verification.json')));
});
test('重启恢复同一任务与截止时间，过期为未确认；身份变化清空人工确认',async t=>{
 const f=await fixture(t);await f.manager.start(scope);complete(f.manager);const first=f.manager.snapshot()!;await f.manager.dispose();const until=Date.now()+5000;while(await lstat(join(f.control,'verification.lock')).then(()=>true,()=>false)){if(Date.now()>until)throw new Error('shutdown_flush_timeout');await new Promise(resolve=>setTimeout(resolve,5));}f.advance(10*60*1000);const resumed=new InstallationVerification(f.options);t.after(()=>resumed.dispose());await resumed.restore();assert.equal(resumed.snapshot()?.id,first.id);assert.equal(resumed.snapshot()?.deadline,first.deadline);assert.equal(resumed.snapshot()?.canPass,true);await resumed.setScope('b'.repeat(64));assert.equal(resumed.snapshot()?.confirmed.global,false);assert.equal(resumed.snapshot()?.canPass,false);f.advance(VERIFICATION_DURATION);await resumed.finish('passed');assert.equal(resumed.snapshot()?.result,'unconfirmed');assert.ok((await lstat(resumed.snapshot()!.logPath)).size>0);
});
test('多窗口不能同时启动或修改同一验证任务',async t=>{
 const f=await fixture(t);await f.manager.start(scope);const other=new InstallationVerification(f.options);t.after(()=>other.dispose());await other.restore();assert.equal(other.snapshot()?.readOnly,true);other.confirm('global');assert.equal(f.manager.snapshot()?.confirmed.global,false);await assert.rejects(other.start(scope),/verification_other_window/);await other.finish('failed');assert.equal(f.manager.snapshot()?.result,'active');
});
test('观察窗口可刷新终态和接管失主任务，读锁竞态不能复活终态',async t=>{
 const f=await fixture(t);await f.manager.start(scope);const first=f.manager.snapshot()!;const other=new InstallationVerification(f.options);t.after(()=>other.dispose());await other.restore();assert.equal(other.snapshot()?.readOnly,true);
 await f.manager.finish('failed');await other.restore();assert.equal(other.snapshot()?.result,'failed');
 await f.manager.start(scope);f.manager.confirm('global');const active=f.manager.snapshot()!;await f.manager.dispose();const until=Date.now()+5000;while(await lstat(join(f.control,'verification.lock')).then(()=>true,()=>false)){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,5));}
 await other.restore();assert.equal(other.snapshot()?.id,active.id);assert.equal(other.snapshot()?.deadline,active.deadline);assert.equal(other.snapshot()?.readOnly,false);await other.finish('failed');
 assert.notEqual(first.id,active.id);await f.manager.start(scope);const raced=new InstallationVerification({...f.options,prepare:async path=>{if(path===f.control)await f.manager.finish('failed');await f.options.prepare(path);}});t.after(()=>raced.dispose());await raced.restore();assert.equal(raced.snapshot()?.result,'failed');assert.equal(raced.snapshot()?.readOnly,true);await assert.rejects(readFile(join(f.control,'verification.json')));
});
test('验证通过但文件删除受阻时如实保留路径和清理提示',async t=>{
 const f=await fixture(t),source=await readFile(new URL('../src/installation-verification.ts',import.meta.url),'utf8'),{code}=await transform(source,{loader:'ts',format:'cjs',target:'node18'}),actualRequire=createRequire(new URL('../src/installation-verification.ts',import.meta.url));let detail='';
 const module={exports:{} as {InstallationVerification:typeof InstallationVerification}};
 runInNewContext(code,{module,exports:module.exports,require:(name:string)=>name==='node:fs/promises'?{...realFs,unlink:async(path:string)=>{if(path===detail)throw Object.assign(new Error('synthetic denial'),{code:'EACCES'});return realFs.unlink(path);}}:actualRequire(name),process,Buffer,performance,setTimeout,clearTimeout});
 const manager=new module.exports.InstallationVerification(f.options);t.after(()=>manager.dispose());await manager.start(scope);detail=manager.snapshot()!.logPath;complete(manager);await manager.finish('passed');const s=manager.snapshot()!;assert.equal(s.result,'passed');assert.equal(s.detailsDeleted,false);assert.equal(s.incomplete,true);assert.equal(s.logPath,detail);await readFile(detail);assert.equal(JSON.parse(await readFile(join(manager.logDirectory,'verification.json'),'utf8')).detailsDeleted,false);
});
test('日志写入停滞时队列有界，事件循环和身份同步不等待，关闭最多等待200毫秒',async t=>{
 const f=await fixture(t),source=await readFile(new URL('../src/installation-verification.ts',import.meta.url),'utf8'),{code}=await transform(source,{loader:'ts',format:'cjs',target:'node18'}),actualRequire=createRequire(new URL('../src/installation-verification.ts',import.meta.url));let blocked=false,release!:()=>void,notify!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{notify=resolve;}),keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
 const module={exports:{} as {InstallationVerification:typeof InstallationVerification}};
 runInNewContext(code,{module,exports:module.exports,require:(name:string)=>name==='node:fs/promises'?{...realFs,open:async(...args:Parameters<typeof realFs.open>)=>{const handle=await realFs.open(...args);return {stat:()=>handle.stat(),close:()=>handle.close(),write:async(line:string)=>{if(blocked){notify();await held;}return handle.write(line);}};}}:actualRequire(name),process,Buffer,performance,setTimeout,clearTimeout});
 const manager=new module.exports.InstallationVerification(f.options);t.after(()=>manager.dispose());await manager.start(scope);blocked=true;manager.event('check.hook');await writing;for(let i=0;i<1000;i++)manager.event('check.hook');assert.equal(manager.snapshot()?.incomplete,true);
 let tick=false;await new Promise<void>(resolve=>setImmediate(()=>{tick=true;resolve();}));assert.equal(tick,true);const before=performance.now();await manager.setScope('b'.repeat(64));assert.ok(performance.now()-before<100,'身份同步不能等待日志写入');await manager.dispose();assert.ok(performance.now()-before<500,'IDE关闭只能有界等待');blocked=false;release();const until=Date.now()+5000;while(await lstat(join(f.control,'verification.lock')).then(()=>true,()=>false)){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,5));}
 const state=JSON.parse(await readFile(join(manager.logDirectory,'verification.json'),'utf8'));assert.equal(state.incomplete,true);assert.equal(state.scope,'b'.repeat(64));
});
test('日志达到1MB停止写入，仅保留当前与上一份详细日志',async t=>{
 const f=await fixture(t);for(let run=0;run<3;run++){await f.manager.start(scope);for(let i=0;i<7000;i++)f.manager.event('check.hook');await f.manager.finish('failed');const files=(await readdir(f.manager.logDirectory)).filter(n=>n.endsWith('.jsonl'));assert.ok(files.length<=2);let total=0;for(const n of files){const size=(await lstat(join(f.manager.logDirectory,n))).size;assert.ok(size<=LOG_LIMIT);total+=size;}assert.ok(total<=2*LOG_LIMIT);assert.equal(f.manager.snapshot()?.truncated,true);assert.equal(f.manager.snapshot()?.incomplete,true);}
});
test('磁盘目录不可用时，不影响业务，日志错误只标记缺失',async t=>{
 const f=await fixture(t);await f.manager.start(scope);await rm(f.manager.snapshot()!.logPath);await mkdir(f.manager.snapshot()!.logPath);const finish=diagnosticOperation('version.query');finish(new PluginHttpError(0,'request_timeout'));await f.manager.finish('failed');assert.equal(f.manager.snapshot()?.result,'failed');assert.equal(f.manager.snapshot()?.incomplete,true);assert.equal(safeDiagnosticFailure(new Error('raw cookie stack secret')).code,'unclassified');
});
test('Trae应用版本与VSCode内核版本分开记录，缺失不冒充应用版本',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'product.json'),JSON.stringify({appVersion:'3.3.104',version:'1.107.1'}));const env=await verificationEnvironment(f.directory,'1.107.1','1.0.3','c'.repeat(64));assert.equal(env.trae_version,'3.3.104');assert.equal(env.vscode_version,'1.107.1');assert.ok(env.os_version);assert.equal((await verificationEnvironment(join(f.directory,'missing'),'1.107.1','1.0.3','c'.repeat(64))).trae_version,'unknown');
});
test('标记写入尾部的新身份更新不会丢失',async()=>{
 const manager=new InstallationVerification({directory:'/synthetic/storage',control:'/synthetic/control',environment:async()=>({}),onChange:()=>{}});
 // Force the microtask handoff between drain completion and finally cleanup.
 const m=manager as unknown as {state:{id:string;result:string;scope:string;deadline:number};release:()=>Promise<void>;socket:{address:()=>{port:number}};atomic:(path:string,value:string)=>Promise<void>;marker:()=>Promise<void>;markerPending:boolean;markerWork:Promise<void>|undefined};
 const writes:string[]=[];let releaseWrite!:()=>void;m.state={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',result:'active',scope:'a'.repeat(64),deadline:Date.now()+10000};m.release=async()=>{};m.socket={address:()=>({port:45678})};m.atomic=async(_path,value)=>{writes.push(JSON.parse(value).owner);if(writes.length===1)await new Promise<void>(resolve=>{releaseWrite=resolve;});};
 const work=m.marker();releaseWrite();queueMicrotask(()=>queueMicrotask(()=>{m.state.scope='b'.repeat(64);void m.marker();}));await work;for(let i=0;i<10;i++)await Promise.resolve();assert.deepEqual(writes,['a'.repeat(64),'b'.repeat(64)]);assert.equal(m.markerPending,false);assert.equal(m.markerWork,undefined);
});

test('运行控制错误保留固定安全分类',()=>{for(const code of ['runtime_unavailable','runtime_clock_unavailable','runtime_busy','runtime_coordination_requires_repair','unsafe_runtime_path','unsafe_runtime_file','invalid_runtime_file','invalid_runtime_owner','invalid_runtime_scope'])assert.equal(safeDiagnosticFailure(new Error(code)).code,code);});

test('遗留受管 Hook 缺少安装清单时保留可定位的安全分类',()=>{assert.equal(safeDiagnosticFailure(new Error('orphaned_managed_hooks')).code,'orphaned_managed_hooks');});
