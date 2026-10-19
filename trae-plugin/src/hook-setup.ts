import {environmentRecoveryDirectory} from './environment-paths.js';
import {pluginTimeouts} from './timeouts.js';
import {diagnosticOperation} from './diagnostics.js';
import {unzipSync} from 'fflate';import {createHash} from 'node:crypto';
import {mkdtemp,lstat,readFile,writeFile,rm,rename} from 'node:fs/promises';import {join} from 'node:path';import {homedir} from 'node:os';
import {execFile} from 'node:child_process';import {promisify,isDeepStrictEqual} from 'node:util';
import {preparePrivateDirectory} from './private-files.js';
import {acquireDirectoryLock} from './directory-lock.js';
import {platformRequest,normalizeWebUrl} from './platform-session.js';import {knownHookRelease} from './known-hook-release.js';
import {managedGroup,stripManagedHooks} from './collection-recovery.js';
const names=['INSTALL.md','LICENSE','NOTICE','install-hook.ps1','install-hook.sh','native-macos.js','native-windows.ps1','send-hook.ps1','send-hook.sh','send-worker.ps1','adi-installation.json'];
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validatePersonalArchive(archive:Buffer,expected:{bytes:number;sha256:string},origin:string,owner:string):Record<string,Uint8Array>{
  if(archive.length>4*1024*1024||archive.length!==expected.bytes||hash(archive)!==expected.sha256)throw new Error('archive_integrity');
  let total=0;const files=unzipSync(archive,{filter:file=>{total+=file.originalSize;if(!names.includes(file.name)||file.originalSize>512*1024||total>4*1024*1024)throw new Error('archive_contents');return true;}});
  if(Object.keys(files).sort().join(',')!==[...names].sort().join(','))throw new Error('archive_contents');
  const config=JSON.parse(Buffer.from(files['adi-installation.json']!).toString('utf8'));
  if(config.endpoint!==normalizeWebUrl(origin)+'/hooks')throw new Error('endpoint_mismatch');
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.installation_id)||!/^adi_[A-Za-z0-9_-]{43}$/.test(config.token)||!/^[a-f0-9]{64}$/.test(owner))throw new Error('invalid_hook_credentials');
  files['adi-installation.json']=Buffer.from(JSON.stringify({...config,protocol_version:2,runtime_owner:owner}));return files;
}
async function smallFile(path:string,limit=1048576):Promise<Buffer|undefined>{
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new Error('unsafe_hook_file');return await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
async function safeDirectory(path:string){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return;throw error;});if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw new Error('unsafe_hook_directory');}
export interface HookStatus {state:'checking'|'downloading'|'ready'|'installed'|'failed';reason?:string;profile:string;restart_required?:boolean}
export interface PreparedHook {files:Record<string,Uint8Array>;version:string}
/** Exact writes acknowledged by a successfully completed trusted installer. */
export type HookInstallationWrites=Record<string,Uint8Array|null>;
export async function prepareHook(origin:string,token:string,owner:string,signal:AbortSignal):Promise<PreparedHook>{
  const issued=(await platformRequest(origin,'/api/v1/plugin/collection-grant',signal,{method:'POST',body:{},headers:{Authorization:`Bearer ${token}`}})).data as {authorization:string;download_path:string;bytes:number;sha256:string;version:string};
  if(issued.download_path!=='/api/v1/plugin/collection-client'||typeof issued.authorization!=='string'||! /^[A-Za-z0-9._-]{1,8192}$/.test(issued.authorization)||!Number.isSafeInteger(issued.bytes)||!/^\d+\.\d+\.\d+$/.test(issued.version))throw new Error('invalid_hook_grant');
  const archive=(await platformRequest(origin,issued.download_path,signal,{headers:{Authorization:`Bearer ${issued.authorization}`},binary:true,maxBytes:4*1024*1024,timeout:pluginTimeouts.hookDownload})).data;
  if(!Buffer.isBuffer(archive))throw new Error('invalid_hook_archive');return {files:validatePersonalArchive(archive,issued,origin,owner),version:issued.version};
}
export async function ensureHook(origin:string,token:string,owner:string,storage:string,signal:AbortSignal,onStatus:(status:HookStatus)=>void,options:{prepared?:PreparedHook;locked?:boolean;recoverMissing?:boolean;onInstalled?:(writes:HookInstallationWrites)=>Promise<void>}={}):Promise<HookStatus>{
  const profile=join(homedir(),'.trae-cn'),base=join(profile,'adi-native-collector');let temp:string|undefined,release:(()=>Promise<void>)|undefined;
  const status=(state:HookStatus['state'],extra:Partial<HookStatus>={})=>{const value={state,profile,...extra};onStatus(value);return value;};
  try{
    status('checking');await safeDirectory(profile);await safeDirectory(base);
    const coordination=environmentRecoveryDirectory(profile);await preparePrivateDirectory(coordination);
    if(!options.locked)try{release=await acquireDirectoryLock(coordination,'install.lock',signal);}catch(error){if(error instanceof Error&&error.message==='directory_lock_busy')throw new Error('hook_installation_busy',{cause:error});if(error instanceof Error&&error.message==='directory_lock_invalid')throw new Error('coordination_requires_repair',{cause:error});throw error;}
    status('downloading');const prepared=options.prepared??await prepareHook(origin,token,owner,signal),files=prepared.files;
    const manifestRaw=await smallFile(join(base,'manifest.json')),hooksRaw=await smallFile(join(profile,'hooks.json'));
    const marker=await smallFile(join(base,'.owned'),128),pending=await smallFile(join(base,'pending.json'),4*1024*1024);
    if(marker&&marker.toString()!=='adi-native-client-v2')throw new Error('unsafe_hook_directory');
    const hooks=hooksRaw?.toString().trim()?JSON.parse(hooksRaw.toString()):{version:1,hooks:{}};
    if(!object(hooks)||(hooks.version!==undefined&&hooks.version!==1))throw new Error('unsupported_hooks_configuration');
    if(!Object.hasOwn(hooks,'hooks'))hooks.hooks={};
    if(!object(hooks.hooks)||Object.values(hooks.hooks).some(groups=>!Array.isArray(groups)))throw new Error('unsupported_hooks_configuration');
    // A complete clear can be reinstalled, while managed files still require verification.
    const cleared=Object.values(hooks.hooks).every(groups=>Array.isArray(groups)&&groups.length===0);
    if(!manifestRaw&&JSON.stringify(hooks).includes('adi-native-collector'))throw new Error('orphaned_managed_hooks');
    const control=join(profile,'adi-plugin-control'),receiptPath=join(control,'installation.json');await safeDirectory(control);
    let previous:Record<string,unknown>|undefined;const receipt=await smallFile(receiptPath,16384);if(receipt)previous=JSON.parse(receipt.toString());
    if(manifestRaw&&!pending){
      const manifest=JSON.parse(manifestRaw.toString());if(![2,3].includes(manifest.version)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.release)||!Array.isArray(manifest.entries)||manifest.entries.length!==6)throw new Error('invalid_hook_manifest');
      if(!marker)throw new Error('missing_hook_ownership');
      const release=join(base,manifest.release);await safeDirectory(release);
      for(const entry of manifest.entries){const groups=hooks.hooks[entry.event];if(!cleared&&(!Array.isArray(groups)||groups.filter(group=>isDeepStrictEqual(group,entry.group)).length!==1))throw new Error('managed_hooks_modified');}
      const runtimeNames=process.platform==='win32'?['send-hook.ps1','send-worker.ps1','native-windows.ps1']:['native-macos.js','send-hook.sh'];let identical=!cleared;
      for(const name of runtimeNames){const existing=await smallFile(join(release,name));if(!existing){if(!options.recoverMissing)throw new Error('incomplete_hook_installation');identical=false;continue;}const digest=hash(existing),target=hash(files[name]!);const known=(previous?.files as Record<string,string>|undefined)?.[name]??knownHookRelease[name];if(digest!==target&&digest!==known)throw new Error('managed_hook_files_modified');identical&&=digest===target;}
      const config=await smallFile(join(release,'config.json'),16384);if(!config&&!options.recoverMissing)throw new Error('incomplete_hook_installation');
      if(config&&previous?.config_hash&&hash(config)!==previous.config_hash)throw new Error('managed_hook_configuration_modified');
      identical&&=!!config&&isDeepStrictEqual(JSON.parse(config.toString()),JSON.parse(Buffer.from(files['adi-installation.json']!).toString()));
      if(process.platform==='win32'){
        const executable=await smallFile(join(release,'adi-sender.exe'));
        if(!executable)identical=false;
        else if((previous?.files as Record<string,string>|undefined)?.['adi-sender.exe']!==hash(executable))throw new Error('managed_hook_files_modified');
      }
      if(identical)return status('ready');
    }
    if(signal.aborted)throw new Error('installation_cancelled');
    await preparePrivateDirectory(storage);temp=await mkdtemp(join(storage,'hook-'));await preparePrivateDirectory(temp);
    for(const [name,bytes]of Object.entries(files))await writeFile(join(temp,name),bytes,{flag:'wx',mode:0o600});
    // The archive was verified above. Scope script execution to this installer
    // process; machine/user policy is not persisted and Group Policy still wins.
    const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(temp,'install-hook.ps1'),'-Action','install','-TraeDir',profile,'-Credentials',join(temp,'adi-installation.json'),'-ReplaceLegacy']:[join(temp,'install-hook.sh'),'install','--trae-dir',profile,'--credentials',join(temp,'adi-installation.json'),'--replace-legacy'];
    const executable=process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'/bin/bash';
    const installerComplete=diagnosticOperation('hook.installer');
    const {stdout}=await promisify(execFile)(executable,args,{timeout:pluginTimeouts.hookInstall,maxBuffer:8192,windowsHide:true,signal}).then(value=>{installerComplete();return value;}).catch(error=>{
      installerComplete(error);
      if(process.platform==='win32'&&typeof error.stderr==='string'&&/PSSecurityException|AuthorizationManagerCheckFailed/.test(error.stderr))throw new Error('powershell_execution_policy');
      if(error.killed===true)throw new Error('hook_installation_timeout');throw error;
    });
    let result;try{result=JSON.parse(stdout);}catch{throw new Error('invalid_installer_result');}if(result.error||result.action!=='install')throw new Error('hook_installation_failed');
    const installedBytes=await smallFile(join(base,'manifest.json'));const installed=JSON.parse(installedBytes!.toString());
    if(![2,3].includes(installed.version)||typeof installed.release!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(installed.release))throw new Error('hook_verification_failed');
    const configBytes=await smallFile(join(base,installed.release,'config.json'),16384);if(!configBytes)throw new Error('hook_verification_failed');
    const fileHashes:Record<string,string>={};for(const name of process.platform==='win32'?['send-hook.ps1','send-worker.ps1','native-windows.ps1']:['native-macos.js','send-hook.sh'])fileHashes[name]=hash(files[name]!);
    const writes:HookInstallationWrites={'hooks.json':(await smallFile(join(profile,'hooks.json')))!,'adi-native-collector/.owned':Buffer.from('adi-native-client-v2'),'adi-native-collector/manifest.json':installedBytes!};
    if(options.onInstalled){
      const platform=process.platform==='win32'?'win32':'darwin',expected=stripManagedHooks(hooksRaw,profile,platform).doc;
      for(const event of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification'])expected.hooks[event]=[...(expected.hooks[event]??[]),managedGroup(profile,installed.release,event,platform)];
      if(!isDeepStrictEqual(JSON.parse(Buffer.from(writes['hooks.json']!).toString()),expected))throw new Error('hook_verification_failed');
    }
    // The installer must have created a fresh release. Never adopt an existing
    // executable's digest just because an older receipt is missing.
    if(manifestRaw&&JSON.parse(manifestRaw.toString()).release===installed.release)throw new Error('hook_verification_failed');
    for(const name of [...Object.keys(fileHashes),'config.json',...(process.platform==='win32'?['adi-sender.exe']:[])]){
      const bytes=await smallFile(join(base,installed.release,name));if(!bytes)throw new Error('hook_verification_failed');
      if(name in fileHashes&&hash(bytes)!==fileHashes[name])throw new Error('hook_verification_failed');
      writes['adi-native-collector/'+installed.release+'/'+name]=bytes;
      if(name==='adi-sender.exe')fileHashes[name]=hash(bytes);
    }
    if(!isDeepStrictEqual(JSON.parse(configBytes.toString()),JSON.parse(Buffer.from(files['adi-installation.json']!).toString())))throw new Error('hook_verification_failed');
    if(manifestRaw){const old=JSON.parse(manifestRaw.toString());for(const name of ['send-hook.ps1','send-worker.ps1','native-windows.ps1','adi-sender.exe','send-hook.sh','native-macos.js','config.json'])if(!await smallFile(join(base,old.release,name)))writes['adi-native-collector/'+old.release+'/'+name]=null;}
    const receiptBytes=Buffer.from(JSON.stringify({version:1,files:fileHashes,config_hash:hash(configBytes),release_version:prepared.version}));
    await preparePrivateDirectory(control);const scratch=join(control,'installation.tmp');await writeFile(scratch,receiptBytes,{mode:0o600});await rename(scratch,receiptPath);
    writes['adi-plugin-control/installation.json']=receiptBytes;await options.onInstalled?.(writes);
    return status('installed',{restart_required:true});
  }catch(error){const reason=['EACCES','EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')?'hook_file_permission':error instanceof Error&&/^[a-z_]{3,64}$/.test(error.message)?error.message:'hook_installation_failed';return status('failed',{reason});}
  finally{try{if(temp)await rm(temp,{recursive:true,force:true});}finally{await release?.();}}
}
