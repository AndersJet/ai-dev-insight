import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InstallationVerification,WorkspaceInstallationVerification,verificationWorkspace} from '../src/installation-verification.js';

const scope='a'.repeat(64);
test('工作区键区分本地、SSH 主机和项目，重载和文件夹排序保持稳定',()=>{
 const local=verificationWorkspace('',['file:///A','file:///B'],'','A');
 assert.equal(local.id,verificationWorkspace('',['file:///B','file:///A'],'','改名').id);
 assert.notEqual(local.id,verificationWorkspace('',['file:///C']).id);
 assert.notEqual(local.id,verificationWorkspace('ssh-remote',['file:///A','file:///B']).id);
 assert.notEqual(verificationWorkspace('ssh-remote',['vscode-remote://host1/A']).id,verificationWorkspace('ssh-remote',['vscode-remote://host2/A']).id);
});

test('当前窗口 A 到 B 再返回 A 恢复各自确认，切换期间旧异步操作不能创建 B 的任务',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-verification-switch-'));let workspace=verificationWorkspace('',['file:///A'],'','A');
 const manager=new WorkspaceInstallationVerification({directory,control:join(directory,'control'),environment:async()=>({}),onChange:()=>{},prepare:async(path:string)=>{await mkdir(path,{recursive:true,mode:0o700});}},()=>workspace);
 t.after(async()=>{await manager.dispose();await rm(directory,{recursive:true,force:true});});
 await manager.start(scope);const first=manager.snapshot()!;manager.setCheck('account',true);manager.setCheck('hook',true);manager.confirm('global');
 const pending=manager.start(scope);workspace=verificationWorkspace('',['file:///B'],'','B');assert.equal(manager.snapshot(),null);await pending;await manager.restore();assert.equal(manager.snapshot(),null);
 await manager.start(scope);const second=manager.snapshot()!;assert.notEqual(first.id,second.id);assert.equal(second.confirmed.global,false);
 workspace=verificationWorkspace('',['file:///A'],'','A');await manager.restore();assert.equal(manager.snapshot()?.id,first.id);assert.equal(manager.snapshot()?.confirmed.global,true);assert.equal(manager.snapshot()?.readOnly,false);
});

test('初始化尚未取得锁就切换项目，旧任务不得在关闭后重新持有锁',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-verification-start-switch-'));let workspace=verificationWorkspace('',['file:///A'],'','A'),release!:()=>void,notify!:()=>void,blocked=true;
 const held=new Promise<void>(resolve=>{release=resolve;}),preparing=new Promise<void>(resolve=>{notify=resolve;});
 const manager=new WorkspaceInstallationVerification({directory,control:join(directory,'control'),environment:async()=>({}),onChange:()=>{},prepare:async(path:string)=>{if(blocked){notify();await held;}await mkdir(path,{recursive:true,mode:0o700});}},()=>workspace);
 t.after(async()=>{release();await manager.dispose();await rm(directory,{recursive:true,force:true});});
 const start=manager.start(scope);await preparing;workspace=verificationWorkspace('',['file:///B'],'','B');assert.equal(manager.snapshot(),null);
 const resumed=manager.restore();await new Promise(resolve=>setTimeout(resolve,5));blocked=false;release();await start;await resumed;
 workspace=verificationWorkspace('',['file:///A'],'','A');await manager.restore();
 assert.ok(!manager.snapshot()?.readOnly,'切回项目时不能被已关闭但迟到的启动过程卡住');
});
test('本地项目与 SSH 工作区同时验证，记录、确认、日志和控制权分别隔离',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-verification-workspaces-'));
 const options={directory,control:join(directory,'control'),environment:async()=>({}),onChange:()=>{},prepare:async(path:string)=>{await mkdir(path,{recursive:true,mode:0o700});}};
 const local=new InstallationVerification({...options,workspace:{id:'a'.repeat(64),label:'本地项目：A',remote:false}});
 const remote=new InstallationVerification({...options,workspace:{id:'b'.repeat(64),label:'Remote SSH 项目：B',remote:true}});
 const otherLocal=new InstallationVerification({...options,workspace:{id:'c'.repeat(64),label:'本地项目：C',remote:false}});
 t.after(async()=>{await Promise.all([local.dispose(),remote.dispose(),otherLocal.dispose()]);await rm(directory,{recursive:true,force:true});});
 await local.start(scope);local.setCheck('account',true);local.setCheck('hook',true);local.confirm('global');
 await remote.restore();assert.equal(remote.snapshot(),null,'新 SSH 项目不能显示本地 A 的验证');
 await remote.start(scope);await otherLocal.start(scope);
 assert.notEqual(local.snapshot()?.id,remote.snapshot()?.id);assert.notEqual(local.logDirectory,otherLocal.logDirectory);
 assert.equal(remote.snapshot()?.confirmed.global,false);assert.equal(remote.snapshot()?.readOnly,false);assert.equal(otherLocal.snapshot()?.readOnly,false);
 const marker=JSON.parse(await readFile(join(options.control,'verification.json'),'utf8'));
 assert.equal(marker.verification,local.snapshot()?.id,'远端和其他本地项目不能覆盖本地原生诊断接收者');
 await remote.finish('failed');assert.equal(local.snapshot()?.result,'active');
 assert.equal(JSON.parse(await readFile(join(options.control,'verification.json'),'utf8')).verification,marker.verification);
 await local.dispose();
 const restored=new InstallationVerification({...options,workspace:{id:'a'.repeat(64),label:'本地项目：A',remote:false}});t.after(()=>restored.dispose());
 await restored.restore();assert.equal(restored.snapshot()?.id,local.snapshot()?.id);assert.equal(restored.snapshot()?.confirmed.global,true);assert.equal(restored.snapshot()?.readOnly,false);
});

test('同工作区观察窗口自动接续已释放的验证，旧全局记录不迁入项目',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-verification-resume-'));
 const options={directory,control:join(directory,'control'),environment:async()=>({}),onChange:()=>{},prepare:async(path:string)=>{await mkdir(path,{recursive:true,mode:0o700});}};
 const legacy=new InstallationVerification(options);await legacy.start(scope);await legacy.dispose();
 const scoped={...options,workspace:{id:'d'.repeat(64),label:'本地项目：D',remote:false}};
 const first=new InstallationVerification(scoped),second=new InstallationVerification(scoped);
 t.after(async()=>{await first.dispose();await second.dispose();await rm(directory,{recursive:true,force:true});});
 await first.restore();assert.equal(first.snapshot(),null);
 await first.start(scope);await second.restore();assert.equal(second.snapshot()?.readOnly,true);
 await first.dispose();
 const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
 const end=Date.now()+3000;while(second.snapshot()?.readOnly&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(second.snapshot()?.readOnly,false,'无需手动反复刷新即可继续同一工作区验证');
 assert.equal(second.snapshot()?.id,first.snapshot()?.id);
 await lstat(join(directory,'debug-logs','verification.json'));
});
