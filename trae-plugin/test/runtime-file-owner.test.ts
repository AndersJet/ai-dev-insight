import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {RuntimeControl} from '../src/runtime-control.js';

// Run in both ordinary and elevated Windows shells: an elevated creator can
// otherwise give every replacement file the Administrators group as its owner.
test('Windows runtime files retain the current user as owner across every atomic replacement',{skip:process.platform!=='win32'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-runtime-owner-')),owner='a'.repeat(64),control=new RuntimeControl(directory);
  const encoded=Buffer.from(join(directory,'control.json')).toString('base64');
  const script=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[IO.File]::GetAccessControl($p);$actual=$acl.GetOwner([Security.Principal.SecurityIdentifier]);if($actual.Value -cne $sid.Value){throw 'runtime_file_owner_mismatch'};foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $sid.Value){throw 'runtime_file_permissions_broadened'}};[Console]::Write('protected')`;
  const check=async()=>{
    const {stdout}=await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:4096,windowsHide:true});
    assert.equal(stdout,'protected');
  };
  try{
    assert.equal(await control.pulse(owner,true,{resume:true}),true);await check();
    assert.equal(await control.pulse(owner,true),true);await check();
    await control.stop(owner);await check();
    assert.equal(await control.pulse(owner,true,{resume:true}),true);await control.close(owner);await check();
  }finally{await rm(directory,{recursive:true,force:true});}
});
