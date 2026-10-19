import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,symlink,lstat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {CollectionRecovery,managedGroup,stripManagedHooks,resetHookDocument} from '../src/collection-recovery.js';import {RuntimeControl} from '../src/runtime-control.js';import {acquireDirectoryLock} from '../src/directory-lock.js';import type {PreparedHook,HookInstallationWrites} from '../src/hook-setup.js';
const owner='a'.repeat(64),oldId='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222';
const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'];
const thirdParty={hooks:[{type:'command',command:'user-validator --private-value=NEVER_LOG_ME',timeout:5}]};
const digest=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function fixture(t:{after(fn:()=>Promise<void>):void},platform:'darwin'|'win32'='darwin'){
 const home=await mkdtemp(join(tmpdir(),'adi-recovery-'));t.after(()=>rm(home,{recursive:true,force:true}));const profile=join(home,'.trae-cn');await mkdir(profile);
 const prepared:PreparedHook={version:'0.3.0',files:Object.fromEntries(['send-hook.sh','native-macos.js','send-hook.ps1','send-worker.ps1','native-windows.ps1','adi-sender.exe'].map(name=>[name,Buffer.from('known-'+name)]))};
 prepared.files['adi-installation.json']=Buffer.from(JSON.stringify({installation_id:oldId,token:'adi_'+'a'.repeat(43),endpoint:'http://example.invalid/hooks',protocol_version:2,runtime_owner:owner}));
 const recovery=new CollectionRecovery({profile,platform});
 const hooks=(id=oldId)=>({version:1,custom:{preserved:true},hooks:Object.fromEntries(events.map(event=>[event,[managedGroup(profile,id,event,platform),...(event==='Stop'?[thirdParty]:[])]]))});
 const put=async(path:string,data:string|Uint8Array)=>{await mkdir(join(profile,path,'..'),{recursive:true});await writeFile(join(profile,path),data,{mode:0o600});};
 const seed=async(id=oldId)=>{
   await put('hooks.json',JSON.stringify(hooks(id)));await put('adi-native-collector/.owned','adi-native-client-v2');
   await put('adi-native-collector/manifest.json',JSON.stringify({version:platform==='win32'?3:2,release:id,entries:events.map(event=>({event,group:managedGroup(profile,id,event,platform)}))}));
   for(const name of (platform==='win32'?['send-hook.ps1','send-worker.ps1','native-windows.ps1','adi-sender.exe']:['send-hook.sh','native-macos.js']))await put('adi-native-collector/'+id+'/'+name,prepared.files[name]!);
   await put('adi-native-collector/'+id+'/config.json',prepared.files['adi-installation.json']!);
   await put('adi-plugin-control/installation.json',JSON.stringify({version:1,files:Object.fromEntries(Object.entries(prepared.files).map(([name,data])=>[name,digest(data)])),config_hash:digest(prepared.files['adi-installation.json']!)}));
   await put('adi-plugin-control/control.json',JSON.stringify({version:2,owner,generation:oldId,clock_kind:platform==='win32'?'windows-qpc-v1':'macos-continuous-v1',enabled:true,leases:[]}));
 };
 const install=async(_prepared?:PreparedHook,recordWrites?:(writes:HookInstallationWrites)=>Promise<void>)=>{
   const doc=stripManagedHooks(await readFile(join(profile,'hooks.json')).catch(()=>undefined),profile,platform).doc;
   for(const event of events)doc.hooks[event]=[...(doc.hooks[event]??[]),managedGroup(profile,newId,event,platform)];
   await seed(newId);await put('hooks.json',JSON.stringify(doc));await rm(join(profile,'adi-native-collector',oldId),{recursive:true,force:true});
   const paths=['hooks.json','adi-native-collector/.owned','adi-native-collector/manifest.json','adi-plugin-control/installation.json',...(platform==='win32'?['send-hook.ps1','send-worker.ps1','native-windows.ps1','adi-sender.exe','config.json']:['send-hook.sh','native-macos.js','config.json']).flatMap(name=>['adi-native-collector/'+newId+'/'+name,'adi-native-collector/'+oldId+'/'+name])];
   const writes:HookInstallationWrites={};for(const path of paths)writes[path]=await readFile(join(profile,path)).catch(()=>null);await recordWrites?.(writes);
   return {state:'installed' as const,profile,restart_required:true};
 };
 const execute=async(plan:Awaited<ReturnType<typeof recovery.plan>>,custom:Partial<Parameters<typeof recovery.execute>[1]>={})=>recovery.execute(plan,{signal:new AbortController().signal,pause:async()=>put('adi-plugin-control/control.json',JSON.stringify({version:2,owner,enabled:false,leases:[]})),install,resume:async()=>{},current:()=>true,onChange:()=>{},...custom});
 return {home,profile,prepared,recovery,hooks,put,seed,install,execute};
}

test('canonical orphan recognition is exact on Windows and macOS and preserves all third-party data',()=>{
 for(const platform of ['win32','darwin'] as const){
  const profile=platform==='win32'?'C:\\Users\\Employee\\.trae-cn':"/Users/employee's/.trae-cn";
  const raw={custom:'kept',hooks:Object.fromEntries(events.map(event=>[event,[managedGroup(profile,oldId,event,platform),thirdParty]]))};
  const {doc,found}=stripManagedHooks(Buffer.from(JSON.stringify(raw)),profile,platform);assert.equal(found.length,6);assert.equal(doc.custom,'kept');for(const event of events)assert.deepEqual(doc.hooks[event],[thirdParty]);
  const modified=structuredClone(raw);modified.hooks.Stop![0]!.hooks[0]!.timeout=9;assert.throws(()=>stripManagedHooks(Buffer.from(JSON.stringify(modified)),profile,platform),/recovery_unknown_hooks/);
  const partial=structuredClone(raw);delete partial.hooks.Stop;assert.throws(()=>stripManagedHooks(Buffer.from(JSON.stringify(partial)),profile,platform),/recovery_unknown_hooks/);
 }
});

test('explicit reset preflight is read-only and also permits a healthy installation',async t=>{
 const f=await fixture(t);await f.seed();const before=await readFile(join(f.profile,'hooks.json'));const plan=await f.recovery.plan(owner,f.prepared,false);assert.ok(plan.issues.length);assert.equal(plan.resetAllHooks,false);assert.deepEqual(await readFile(join(f.profile,'hooks.json')),before);await assert.rejects(lstat(f.recovery.directory),{code:'ENOENT'});
});

test('reset backs up complete old roots outside them and preserves identity outside the reset allowlist',async t=>{
 const f=await fixture(t);await f.seed();await f.put('source-identity.json','identity-kept');await f.put('adi-native-collector/unknown/file','old residue');
 const original=await readFile(join(f.profile,'hooks.json'));const result=await f.execute(await f.recovery.plan(owner,f.prepared,false));assert.equal(result.phase,'completed');
 assert.equal(await readFile(join(f.profile,'source-identity.json'),'utf8'),'identity-kept');assert.deepEqual(JSON.parse(await readFile(join(f.profile,'hooks.json'),'utf8')).hooks.Stop.find((v:unknown)=>JSON.stringify(v)===JSON.stringify(thirdParty)),thirdParty);
 const backup=f.recovery.paths(result).backup;assert.deepEqual(await readFile(join(backup,'hooks.json')),original);assert.equal(await readFile(join(backup,'adi-native-collector/unknown/file'),'utf8'),'old residue');assert.equal(await readFile(join(backup,'adi-native-collector',oldId,'config.json'),'utf8'),Buffer.from(f.prepared.files['adi-installation.json']!).toString());await assert.rejects(lstat(join(f.profile,'adi-native-collector/unknown')),{code:'ENOENT'});
 assert.match(result.backup,/^\d{8}T\d{6}Z-/);assert.equal(backup.startsWith(join(f.profile,'adi-plugin-control')+'/'),false);
 if(process.platform!=='win32')assert.equal((await lstat(backup)).mode&0o777,0o700);
 assert.doesNotMatch(await readFile(f.recovery.paths(result).log,'utf8'),/NEVER_LOG_ME|adi_aaaa|token|command/);
});

for(const platform of ['darwin','win32'] as const)test('damaged managed files, receipts and stale internal locks can be reset on '+platform,async t=>{
 const f=await fixture(t,platform);await f.seed();
 for(const [path,data]of [['adi-native-collector/pending.json','{'],['adi-native-collector/manifest.json','broken'],['adi-native-collector/.owned','damaged'],['adi-plugin-control/installation.json','{'],['adi-plugin-control/control.json','{'],['adi-plugin-control/lock/foreign','broken-lock'],['adi-native-collector/'+oldId+'/config.json','manually changed']])await f.put(path!,data!);
 const result=await f.execute(await f.recovery.plan(owner,f.prepared,true));assert.equal(result.phase,'completed');assert.equal(await readFile(join(f.recovery.paths(result).backup,'adi-plugin-control/lock/foreign'),'utf8'),'broken-lock');
});

test('partial and modified ADI groups can be rebuilt without removing third-party subhooks',async t=>{
 const f=await fixture(t);await f.seed();const doc=f.hooks();delete (doc.hooks as Record<string,unknown>).Stop;doc.hooks.PreToolUse![0]!.hooks[0]!.timeout=8;doc.hooks.PreToolUse![0]!.hooks.push(thirdParty.hooks[0]!);
 doc.hooks.Notification!.push({hooks:[{type:'command',command:'validator --input adi-native-collector',timeout:3}]});await f.put('hooks.json',JSON.stringify(doc));
 const plan=await f.recovery.plan(owner,f.prepared,true);const clean=JSON.parse(plan.hooks);assert.deepEqual(clean.hooks.PreToolUse,[{...doc.hooks.PreToolUse![0],hooks:thirdParty.hooks}]);assert.equal(clean.hooks.Notification[0].hooks[0].command,'validator --input adi-native-collector');assert.equal(plan.resetAllHooks,false);
});

for(const raw of ['{','null','{"hooks":null}','{"version":2,"hooks":{}}'])test('unparseable Hook configuration requires explicit full-reset wording: '+raw,async t=>{
 const f=await fixture(t);await f.seed();await f.put('hooks.json',raw);const plan=await f.recovery.plan(owner,f.prepared,true);assert.equal(plan.resetAllHooks,true);assert.match(plan.issues.join(','),/第三方 Hook 也需手动恢复/);const result=await f.execute(plan);assert.equal(result.phase,'completed');assert.equal(await readFile(join(f.recovery.paths(result).backup,'hooks.json'),'utf8'),raw);
});

test('confirmation-time changes stop recovery before pause or mutation',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true);await f.put('hooks.json','{"hooks":{}}');let paused=false;await assert.rejects(f.execute(plan,{pause:async()=>{paused=true;}}),/recovery_changed/);assert.equal(paused,false);assert.equal(await readFile(join(f.profile,'hooks.json'),'utf8'),'{"hooks":{}}');
});

test('installation failure keeps the original backup and paused barrier without restoring broken programs',async t=>{
 const f=await fixture(t);await f.seed();const original=await readFile(join(f.profile,'hooks.json'));const plan=await f.recovery.plan(owner,f.prepared,true);
 const result=await f.execute(plan,{install:async()=>{throw new Error('SENSITIVE_SERVER_ERROR');}});
 assert.equal(result.phase,'failed');assert.deepEqual(await readFile(join(f.recovery.paths(result).backup,'hooks.json')),original);assert.equal(JSON.parse(await readFile(join(f.profile,'adi-plugin-control/control.json'),'utf8')).enabled,false);await assert.rejects(lstat(join(f.profile,'adi-native-collector',oldId)),{code:'ENOENT'});
 assert.doesNotMatch(await readFile(f.recovery.paths(result).log,'utf8'),/SENSITIVE_SERVER_ERROR/);assert.equal((await f.recovery.status())?.phase,'failed');
 const retried=await f.execute(await f.recovery.plan(owner,f.prepared,true));assert.equal(retried.phase,'completed');assert.notEqual(retried.backup,result.backup);assert.deepEqual(await readFile(join(f.recovery.paths(result).backup,'hooks.json')),original);
});

test('concurrent external edits are never overwritten after an installation failure',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true);const edited=JSON.stringify({hooks:{Stop:[thirdParty]},custom:'external edit'});
 const result=await f.execute(plan,{install:async()=>{await f.put('hooks.json',edited);throw new Error('failure');}});assert.equal(result.phase,'failed');assert.equal(await readFile(join(f.profile,'hooks.json'),'utf8'),edited);
});

test('the same machine serializes two windows and peer readers see the stable recovery barrier',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true);let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});
 const one=f.execute(plan,{install:async(prepared,record)=>{enter();await hold;return f.install(prepared,record);}});await ready;const peer=new CollectionRecovery({profile:f.profile,platform:'darwin'});assert.equal((await peer.status())?.phase,'running');await assert.rejects(f.execute(plan),/recovery_busy/);release();assert.equal((await one).phase,'completed');assert.equal((await peer.status())?.phase,'completed');
});

test('identity changes cancel an in-progress repair and never resume old collection',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true);let current=true,resumed=false;
 const result=await f.execute(plan,{current:()=>current,install:async(prepared,record)=>{await f.install(prepared,record);current=false;return {state:'installed',profile:f.profile};},resume:async()=>{resumed=true;}});assert.equal(result.phase,'failed');assert.equal(resumed,false);
});

test('symlinked roots are refused without following their targets',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await f.seed();await unlink(join(f.profile,'hooks.json'));const foreign=join(f.home,'foreign');await writeFile(foreign,'private');await symlink(foreign,join(f.profile,'hooks.json'));await assert.rejects(f.recovery.plan(owner,f.prepared,true),/recovery_unsafe_path/);assert.equal(await readFile(foreign,'utf8'),'private');
 await unlink(join(f.profile,'hooks.json'));await rm(join(f.profile,'adi-native-collector'),{recursive:true});await symlink(f.home,join(f.profile,'adi-native-collector'));await assert.rejects(f.recovery.plan(owner,f.prepared,true),/recovery_unsafe_path/);
});

test('changes during pause are preserved without resetting installation roots',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true),changed=JSON.stringify({hooks:{},custom:'manual change'});
 const result=await f.execute(plan,{pause:async()=>{await f.put('hooks.json',changed);}});assert.equal(result.phase,'failed');assert.equal(await readFile(join(f.profile,'hooks.json'),'utf8'),changed);assert.equal(await readFile(join(f.profile,'adi-native-collector/.owned'),'utf8'),'adi-native-client-v2');
});

test('peer runtime resumption stays blocked throughout directory rotation and after failed repair',async t=>{
 const f=await fixture(t);await f.seed();const peer=new RuntimeControl(join(f.profile,'adi-plugin-control'),Date.now,async()=>({kind:'macos-continuous-v1',scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:1000}));assert.equal(await peer.pulse(owner,true,{resume:true}),true);
 const result=await f.execute(await f.recovery.plan(owner,f.prepared,true),{install:async()=>{assert.equal(await peer.pulse(owner,true,{resume:true}),false);throw new Error('failed');}});assert.equal(result.phase,'failed');assert.equal(await peer.pulse(owner,true,{resume:true}),false);
 assert.equal(JSON.parse(await readFile(join(f.profile,'adi-plugin-control/control.json'),'utf8')).enabled,false);
});

test('a live installer reservation prevents any reset before backups or pause',async t=>{
 const f=await fixture(t);await f.seed();const plan=await f.recovery.plan(owner,f.prepared,true);await mkdir(f.recovery.directory,{recursive:true});const release=await acquireDirectoryLock(f.recovery.directory,'install.lock');let paused=false;
 try{await assert.rejects(f.execute(plan,{pause:async()=>{paused=true;}}),/recovery_busy/);assert.equal(paused,false);assert.equal(await readFile(join(f.profile,'adi-native-collector/.owned'),'utf8'),'adi-native-client-v2');}finally{await release();}
});

test('reset recognition handles Windows paths and quoted macOS homes without adopting substring matches',()=>{
 for(const platform of ['darwin','win32'] as const){const profile=platform==='win32'?"C:\\Users\\Employee\\.trae-cn":"/Users/employee's/.trae-cn",group=managedGroup(profile,oldId,'Stop',platform);group.hooks[0]!.timeout=99;group.hooks.push(thirdParty.hooks[0]!);const doc={custom:'keep',hooks:{Stop:[group,{hooks:[{type:'command',command:'echo '+group.hooks[0]!.command,timeout:3}]}]}};
 const parsed=resetHookDocument(Buffer.from(JSON.stringify(doc)),profile,platform);assert.equal(parsed.resetAllHooks,false);const after=JSON.parse(parsed.hooks);assert.deepEqual(after.hooks.Stop[0],{...group,hooks:thirdParty.hooks});assert.equal(after.hooks.Stop[1].hooks[0].command,doc.hooks.Stop[1]!.hooks[0]!.command);}
});

for(const [reason,code]of [['hook_file_permission','recovery_permission'],['powershell_execution_policy','recovery_policy']] as const)test('repair exposes the static actionable failure category '+reason,async t=>{
 const f=await fixture(t);await f.seed();const result=await f.execute(await f.recovery.plan(owner,f.prepared,true),{install:async()=>({state:'failed',profile:f.profile,reason})});assert.equal(result.phase,'failed');assert.equal(result.code,code);assert.equal(JSON.parse(await readFile(join(f.profile,'adi-plugin-control/control.json'),'utf8')).enabled,false);
});
