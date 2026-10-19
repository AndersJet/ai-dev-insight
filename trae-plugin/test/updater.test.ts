import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginUpdater} from '../src/updater.js';

test('新版被旧包覆盖后，手动安装可离线重试，自动检查仍避免重复安装',async t=>{
 const bytes=Buffer.from('synthetic reinstall package'),build='f'.repeat(64);
 const release={version:'1.0.1',build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel:'stable',download_path:`/api/v1/plugin-releases/builds/${build}/download`};
 const server=createServer((req,res)=>{res.end(req.url===release.download_path?bytes:JSON.stringify({data:release}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 t.after(()=>server.listening?new Promise<void>(resolve=>server.close(()=>resolve())):undefined);
 const directory=await mkdtemp(join(tmpdir(),'adi-reinstall-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let hostVersion='1.0.0',installs=0;
 const window=()=>new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async path=>{assert.deepEqual(await readFile(path),bytes);hostVersion=release.version;installs++;}});
 const origin=`http://127.0.0.1:${address.port}`,first=window();t.after(()=>first.dispose());first.configure(origin);await first.prepare('stable');await first.installPrepared();assert.equal(hostVersion,'1.0.1');
 first.dispose();hostVersion='1.0.0';
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 const restarted=window();t.after(()=>restarted.dispose());restarted.configure(origin);await restarted.restore();assert.equal(restarted.snapshot().phase,'installed');
 await restarted.installPrepared('stable');assert.equal(installs,1);
 await restarted.installPrepared(undefined,true);assert.equal(hostVersion,'1.0.1','手动重试必须实际调用安装，不能被历史 installed.json 跳过');
 assert.equal(installs,2);assert.equal(restarted.snapshot().version,'1.0.0','重试安装不伪造当前运行版本');
 await writeFile(join(directory,build+'.vsix'),Buffer.alloc(bytes.length));await restarted.installPrepared(undefined,true);
 assert.equal(restarted.snapshot().phase,'failed');assert.equal(installs,2,'手动重试仍必须校验安装包摘要');
});

test('重启后新版已不在宿主安装目录时，自动更新不能被历史安装记录阻止',async t=>{
 const bytes=Buffer.from('synthetic automatic recovery'),build='e'.repeat(64);
 const release={version:'1.0.1',build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel:'stable',download_path:`/api/v1/plugin-releases/builds/${build}/download`};
 const server=createServer((req,res)=>res.end(req.url===release.download_path?bytes:JSON.stringify({data:release})));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 t.after(()=>server.listening?new Promise<void>(resolve=>server.close(()=>resolve())):undefined);
 const directory=await mkdtemp(join(tmpdir(),'adi-auto-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let installedBuild='',installs=0;
 const window=()=>new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),isInstalled:async candidate=>candidate.build_id===installedBuild,install:async()=>{installedBuild=build;installs++;}});
 const origin=`http://127.0.0.1:${address.port}`,first=window();t.after(()=>first.dispose());first.configure(origin);await first.prepare('stable');await first.installPrepared('stable');assert.equal(installs,1);
 const peer=window();t.after(()=>peer.dispose());peer.configure(origin);await peer.restore();await peer.installPrepared('stable');assert.equal(installs,1,'新版仍在安装目录时，多窗口不能重复安装');
 first.dispose();peer.dispose();installedBuild='';await new Promise<void>(resolve=>server.close(()=>resolve()));
 const restarted=window();t.after(()=>restarted.dispose());restarted.configure(origin);await restarted.restore();assert.equal(restarted.snapshot().phase,'ready','新版缺失时应自动恢复待安装状态');
 await restarted.installPrepared('stable');assert.equal(installs,2);assert.equal(installedBuild,build);assert.equal(restarted.snapshot().version,'1.0.0');
});

test('正式包下载校验后离线安装，同版本不同构建不被跳过且实际生效前不改当前身份',async t=>{
 const bytes=Buffer.from('synthetic replacement build');const build='b'.repeat(64);
 const release={version:'1.0.0',build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel:'stable',download_path:`/api/v1/plugin-releases/builds/${build}/download`};
 let downloads=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url===release.download_path){downloads++;res.end(bytes);return;}res.end(JSON.stringify({data:release}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const directory=await mkdtemp(join(tmpdir(),'adi-update-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let installed:Buffer|undefined;const updater=new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async path=>{installed=await readFile(path);}});t.after(()=>updater.dispose());
 updater.configure(`http://127.0.0.1:${address.port}`);await updater.check();assert.equal(updater.snapshot().available?.build_id,build);
 await updater.prepare('stable');assert.equal(updater.snapshot().phase,'ready');await updater.prepare('stable');assert.equal(downloads,1,'Repeated checks reuse the verified pending package');
 await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 await updater.installPrepared();assert.deepEqual(installed,bytes);assert.equal(updater.snapshot().phase,'installed');assert.equal(updater.snapshot().trial,false);
 assert.equal(updater.snapshot().version,'1.0.0');await updater.check();assert.equal(updater.snapshot().phase,'installed','Offline checks retain the installed-but-not-running state');
});

test('校验失败不安装，试用同号覆盖前核对最新构建；正式身份变更不重装相同构建',async t=>{
 const bytes=Buffer.from('synthetic trial');const build='c'.repeat(64);let channel:'stable'|'trial'='trial',replacement=false,corrupt=false;
 const dto=()=>({version:'1.1.0',build_id:replacement?'d'.repeat(64):build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel,download_path:`/api/v1/plugin-releases/builds/${replacement?'d'.repeat(64):build}/download`});
 const server=createServer((req,res)=>{if(req.url?.endsWith('/download')){res.end(corrupt?Buffer.from('tampered bytes'):bytes);return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:req.url?.endsWith('/current')&&channel==='trial'?null:dto()}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const directory=await mkdtemp(join(tmpdir(),'adi-trial-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));let installs=0;
 const updater=new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async()=>{installs++;}});t.after(()=>updater.dispose());updater.configure(`http://127.0.0.1:${address.port}`,'synthetic-token','synthetic-user');
 corrupt=true;await updater.prepare('trial');assert.equal(updater.snapshot().phase,'failed');assert.equal(installs,0);
 corrupt=false;await updater.prepare('trial');assert.equal(updater.snapshot().phase,'ready');await updater.installPrepared('stable');assert.equal(installs,0,'Startup formal update flow cannot install a pending trial');replacement=true;await updater.installPrepared();assert.equal(updater.snapshot().phase,'failed');assert.equal(installs,0);
 replacement=false;await updater.prepare('trial');await updater.installPrepared();assert.equal(installs,1);assert.equal(updater.snapshot().trial,false,'Installing a trial package does not change the running build');
 const running=new PluginUpdater({directory,currentVersion:'1.1.0',currentBuild:build,install:async()=>{installs++;}});t.after(()=>running.dispose());running.configure(`http://127.0.0.1:${address.port}`);await running.restore();assert.equal(running.snapshot().trial,true);
 channel='stable';await running.check();assert.equal(running.snapshot().trial,false);assert.equal(running.snapshot().available,null);assert.equal(installs,1);running.configure(`http://127.0.0.1:${address.port}`,'synthetic-token','synthetic-user');await running.restore();assert.equal(running.snapshot().trial,false,'A stale trial pending cannot reverse a verified same-build promotion');
});

test('目标站点改变会取消旧下载，迟到结果不能形成待安装包',async t=>{
 const bytes=Buffer.from('old site bytes'),build='e'.repeat(64),release={version:'1.0.1',build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel:'stable',download_path:`/api/v1/plugin-releases/builds/${build}/download`};
 let requested!:()=>void;const started=new Promise<void>(r=>{requested=r;});
 const server=createServer((req,res)=>{if(req.url===release.download_path){requested();setTimeout(()=>res.end(bytes),30);return;}res.end(JSON.stringify({data:release}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const directory=await mkdtemp(join(tmpdir(),'adi-change-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));let installs=0;
 const updater=new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async()=>{installs++;}});t.after(()=>updater.dispose());updater.configure(`http://127.0.0.1:${address.port}`);const preparing=updater.prepare('stable');await started;updater.configure('http://127.0.0.1:1');await preparing;
 assert.equal(updater.snapshot().phase,'idle');assert.equal(updater.snapshot().available,null);await updater.installPrepared();assert.equal(installs,0);
});

test('多窗口迟到的旧正式包不能覆盖已安装的较新版本',async t=>{
 const bytes=Buffer.from('synthetic multi-window package');const describe=(build:string,version:string)=>({version,build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel:'stable',download_path:`/api/v1/plugin-releases/builds/${build}/download`});let release=describe('b'.repeat(64),'1.1.0');
 let started!:()=>void,finish!:()=>void;const downloading=new Promise<void>(r=>started=r),delayed=new Promise<void>(r=>finish=r);
 const server=createServer((req,res)=>{if(req.url?.endsWith('/download')){if(req.url.includes('b'.repeat(64))){started();void delayed.then(()=>res.end(bytes));}else res.end(bytes);return;}res.end(JSON.stringify({data:release}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const directory=await mkdtemp(join(tmpdir(),'adi-multi-update-'));t.after(()=>rm(directory,{recursive:true,force:true}));const installs:string[]=[];
 const window=()=>new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async path=>{installs.push(path);}});const oldWindow=window(),newWindow=window();t.after(()=>{finish();oldWindow.dispose();newWindow.dispose();});const origin=`http://127.0.0.1:${address.port}`;oldWindow.configure(origin);newWindow.configure(origin);
 const oldDownload=oldWindow.prepare('stable');await downloading;release=describe('c'.repeat(64),'1.2.0');await newWindow.prepare('stable');await newWindow.installPrepared();finish();await oldDownload;await oldWindow.installPrepared();assert.deepEqual(installs.map(path=>basename(path)),['c'.repeat(64)+'.vsix']);
 const fresh=window();t.after(()=>fresh.dispose());fresh.configure(origin);await fresh.restore();assert.equal(fresh.snapshot().phase,'installed');
});

test('安装正式更新但尚未重载时，退出登录和离线恢复仍显示实际运行的试用身份',async t=>{
 const bytes=Buffer.from('synthetic badge package');const descriptor=(build:string,version:string,channel:'stable'|'trial')=>({version,build_id:build,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,channel,download_path:`/api/v1/plugin-releases/builds/${build}/download`});const trial=descriptor('b'.repeat(64),'1.1.0','trial'),stable=descriptor('c'.repeat(64),'1.2.0','stable');
 const server=createServer((req,res)=>{if(req.url?.endsWith('/download')){res.end(bytes);return;}res.end(JSON.stringify({data:req.url?.endsWith('/trial')?trial:stable}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const directory=await mkdtemp(join(tmpdir(),'adi-badge-update-'));t.after(()=>rm(directory,{recursive:true,force:true}));const origin=`http://127.0.0.1:${address.port}`;
 const first=new PluginUpdater({directory,currentVersion:'1.0.0',currentBuild:'a'.repeat(64),install:async()=>{}});t.after(()=>first.dispose());first.configure(origin,'synthetic-token','synthetic-user');await first.prepare('trial');await first.installPrepared();first.configure(origin);const signedOutRunning=new PluginUpdater({directory,currentVersion:'1.1.0',currentBuild:trial.build_id,install:async()=>{}});t.after(()=>signedOutRunning.dispose());signedOutRunning.configure(origin);await signedOutRunning.restore();assert.equal(signedOutRunning.snapshot().trial,true,'Installing before signout preserves the trial identity when B first starts anonymously');
 const running=new PluginUpdater({directory,currentVersion:'1.1.0',currentBuild:trial.build_id,install:async()=>{}});t.after(()=>running.dispose());running.configure(origin,'synthetic-token','synthetic-user');await running.restore();assert.equal(running.snapshot().trial,true);await running.prepare('stable');await running.installPrepared();assert.equal(running.snapshot().trial,true);running.configure(origin);await running.restore();assert.equal(running.snapshot().trial,true);
 const offline=new PluginUpdater({directory,currentVersion:'1.1.0',currentBuild:trial.build_id,install:async()=>{}});t.after(()=>offline.dispose());offline.configure(origin);await offline.restore();assert.equal(offline.snapshot().trial,true);assert.equal(offline.snapshot().phase,'installed');
});
