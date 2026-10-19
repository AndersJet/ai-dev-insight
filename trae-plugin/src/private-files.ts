import {mkdir,lstat} from 'node:fs/promises';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
let windowsOwnerSid:string|undefined;
async function safeDirectory(path:string){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return;throw error;});if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw new Error('unsafe_private_directory');}
export async function preparePrivateDirectory(path:string){
  await safeDirectory(path);await mkdir(path,{recursive:true,mode:0o700});
  if(process.platform==='win32'){
    const encoded=Buffer.from(path).toString('base64');
    const script=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($p,$acl);[Console]::Write($sid.Value)`;
    // Windows PowerShell startup alone can take several seconds on an employee host.
    const {stdout}=await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:4096,windowsHide:true});
    const sid=stdout.trim();if(!/^S-1-(?:[0-9]+-){1,14}[0-9]+$/.test(sid))throw new Error('unsafe_private_directory');windowsOwnerSid=sid;
  }
}

/** Protect each new file before rename: elevated tokens can default its owner to Administrators. */
export async function protectPrivateFile(path:string){
  if(process.platform!=='win32')return;
  try{
    if(!windowsOwnerSid)throw new Error('owner_unavailable');
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('unsafe_file');
    // Use the cached process identity and a native tool, not a PowerShell startup on every heartbeat.
    await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe'),[path,'/setowner','*'+windowsOwnerSid,'/L','/Q'],{timeout:2000,maxBuffer:4096,windowsHide:true});
  }catch(cause){throw new Error('unsafe_runtime_file',{cause});}
}
