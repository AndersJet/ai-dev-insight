// Portable state/protocol checks. Windows host, ACLs and process trees need Windows.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,realpath,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
const executable=process.env.ADI_TEST_PWSH;if(!executable)throw new Error('Set ADI_TEST_PWSH to an existing PowerShell interpreter');
const directory=await realpath(await mkdtemp(join(tmpdir(),'adi-project-powershell-')));
const core=fileURLToPath(new URL('../../apps/hook-client/native/project-core.ps1',import.meta.url));
const adapter=fileURLToPath(new URL('../../apps/hook-client/native/project-io.ps1',import.meta.url));
const gitAdapter=fileURLToPath(new URL('../../apps/hook-client/native/project-git.ps1',import.meta.url));
const program=String.raw`param([string]$Core)
$ErrorActionPreference='Stop'
. $Core
function Check($Actual,$Expected,[string]$Why){if($Actual -cne $Expected){throw $Why}}
Check (Get-AdiRepositoryAddress 'https://user:synthetic-secret@HOST.example.invalid/Team/App.git?token=synthetic-secret#fragment' 'windows') 'https://host.example.invalid/Team/App.git' 'remote credential sanitization'
Check (Get-AdiRepositoryAddress 'git@10.1.2.3:team/app.git' 'windows') '10.1.2.3:team/app.git' 'SCP remote'
Check (Get-AdiRepositoryAddress 'C:relative/path' 'windows') $null 'Windows drive-relative remote is not a network host'
Check (Get-AdiRepositoryAddress 'https://010.1.2.3/team/app.git' 'windows') $null 'ambiguous IPv4 must stay unknown'
Check (Get-AdiRepositoryAddress '//server/share/repo' 'windows') $null 'local UNC remote must stay unknown'
Check (Get-AdiRepositoryAddress 'ssh://git@[2001:0DB8:0:0:0:0:0:1]:2222/Team/App.git' 'windows') 'ssh://[2001:db8::1]:2222/Team/App.git' 'IPv6 host and explicit port'
Check (Get-AdiRepositoryAddress '[::ffff:192.0.2.1]:team/app.git' 'windows') '[::ffff:c000:201]:team/app.git' 'IPv4-mapped IPv6 canonical form'
Check (Get-AdiRepositoryAddress 'https://host.example.invalid:0/a.git' 'windows') $null 'invalid network port'
Check (Get-AdiRepositoryAddress 'ssh://host.example.invalid/a%0Ab.git' 'windows') $null 'encoded control in remote path'
$addresses=@(Get-AdiRepositoryAddresses @(
 @{name='origin';direction='fetch';address='https://user:synthetic-secret@HOST.example.invalid/team/app.git?token=synthetic-secret'},
 @{name='mirror';direction='push';address='https://host.example.invalid/team/app.git'},
 @{address='ssh://push.example.invalid/team/app.git'},
 @{address='C:/local/repository'},@{address=$null},@{address='D:/another/local/repository'}
) 'windows')
Check (ConvertTo-AdiProjectJson $addresses) '[{"address":"https://host.example.invalid/team/app.git"},{"address":"ssh://push.example.invalid/team/app.git"},{"address":null}]' 'address-only deduplication after sanitization'
$script:files=@{};$script:tick=[long]1000;$script:now=[long]1790812800000;$script:probes=0;$script:locked=$false
$io=@{
 Root='/state';Platform='windows'
 uuid={[guid]::NewGuid().ToString()}
 hash={param($Value)$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
 read={param($Path,$Limit)if($script:readFailure){throw 'io_unavailable'};if($script:files.ContainsKey($Path)){$script:files[$Path]}else{$null}}
 atomic={param($Path,$Value)$script:files[$Path]=$Value}
 directory={param($Path)}
 lock={if($script:locked){throw 'state_busy'};$script:locked=$true;'lock'}
 unlock={param($Handle)$script:locked=$false}
 tick={$script:tick};now={$script:now}
 probe={param($Workspace)$script:probes++;@{state='no_remote';reason=$null;git_root=$Workspace;remotes=@()}}
}
$settings=@{installation_id='11111111-1111-4111-8111-111111111111';token='adi_'+('a'*43);endpoint='http://example.invalid/hooks'}
$payload=@{cwd='C:\work'}
$first=Get-AdiProjectContext $io $settings $payload
Check $first.platform 'windows' 'wire platform'
Check $first.observation.sequence '1' 'first durable sequence'
Check $first.observation.state 'no_remote' 'probe result'
$cached=Get-AdiProjectContext $io $settings $payload
Check $cached.observation.id $first.observation.id 'cached probe identity'
Check $cached.observation.observed_at $first.observation.observed_at 'cache must not renew time'
Check $script:probes 1 'cache must not probe'
foreach($name in @($script:files.Keys)){
 if($name -like '*/cache/*'){
  $original=$script:files[$name];$cache=ConvertFrom-AdiProjectJson $original
  $cache.observation.state='repository'
  $cache.observation.remotes=@(
   [ordered]@{name='origin';direction='fetch';address='https://host.example.invalid/app.git'},
   [ordered]@{name='origin';direction='push';address='https://host.example.invalid/app.git'}
  )
  $o=$cache.observation
  $legacyRemotes=@(@('origin','fetch','https://host.example.invalid/app.git'),@('origin','push','https://host.example.invalid/app.git'))
  $legacyObservation=@($o.id,$o.sequence,$o.observed_at,$o.state,$o.reason,$o.git_root,$legacyRemotes)
  $legacyHash=& $io.hash (ConvertTo-AdiProjectJson @($cache.collector_id,$cache.account,$cache.workspace,$cache.attempt_at,$cache.attempt_tick,$cache.reservation,$cache.sequence,$legacyObservation))
  Check (Get-AdiProjectCacheHash $io $cache) $legacyHash 'legacy cache hash must remain unchanged'
  $cache.checksum=$legacyHash;$script:files[$name]=ConvertTo-AdiProjectJson $cache
  $legacy=Get-AdiProjectContext $io $settings $payload
  Check (ConvertTo-AdiProjectJson $legacy.observation.remotes) (ConvertTo-AdiProjectJson $cache.observation.remotes) 'legacy id must replay the original payload'
  Check $legacy.observation.id $first.observation.id 'legacy cache must not create a new observation'
  $cache.observation.remotes=@([ordered]@{address='https://host.example.invalid/app.git'})
  $cache.checksum=Get-AdiProjectCacheHash $io $cache;$script:files[$name]=ConvertTo-AdiProjectJson $cache
  $addressOnly=Get-AdiProjectContext $io $settings $payload
  Check (ConvertTo-AdiProjectJson $addressOnly.observation.remotes) '[{"address":"https://host.example.invalid/app.git"}]' 'new address-only cache must retain the observation'
  Check $script:probes 1 'neither cache format may trigger another Git probe'
  $script:files[$name]=$original
 }
}
$script:tick+=299999;$script:now+=299999
$before=Get-AdiProjectContext $io $settings $payload
Check $before.observation.sequence '1' 'five-minute boundary'
$script:tick++;$script:now++
$next=Get-AdiProjectContext $io $settings $payload
Check $next.observation.sequence '2' 'new attempt after five minutes'
Check $next.collector_id $first.collector_id 'stable instance'
$settings.token='adi_'+('b'*43)
$rotated=Get-AdiProjectContext $io $settings $payload
Check $rotated.collector_id $first.collector_id 'credential reset preserves instance'
Check $rotated.observation.sequence '3' 'credential reset isolates cache'
$unresolved=Get-AdiProjectContext $io $settings @{cwd='C:\work';workspace_roots=@('C:\work','D:\other')}
Check $unresolved.workspace $null 'multi-root must not guess'
Check $unresolved.unresolved_reason 'ambiguous_workspace' 'multi-root evidence'
Check $unresolved.observation $null 'multi-root must not probe'
$defaultProbe=$io.probe
$io.probe={param($Workspace)
 $script:probes++
 $identity=ConvertFrom-AdiProjectJson $script:files['/state/identity.json']
 Check $identity.sequence '4' 'sequence must be durable before Git starts'
 $nested=Get-AdiProjectContext $io $settings @{cwd='C:/another'}
 Check $nested.observation $null 'inflight reservation must not fabricate an observation'
 Check $script:probes 4 'inflight reservation must not start another probe'
 @{state='no_remote';reason=$null;git_root=$Workspace;remotes=@()}
}
$concurrent=Get-AdiProjectContext $io $settings @{cwd='C:/another'}
Check $concurrent.observation.sequence '4' 'independent project uses global ordering'
$io.probe={param($Workspace)throw 'synthetic_git_failure'}
$script:tick+=300000;$script:now+=300000
$failed=Get-AdiProjectContext $io $settings @{cwd='C:/another'}
Check $failed.observation.sequence '5' 'failure is an ordered observation'
Check $failed.observation.state 'failed' 'probe error state'
Check $failed.observation.reason 'git_error' 'probe error reason'
foreach($name in @($script:files.Keys)){
 if($name -like '*/cache/*'){
  $cache=ConvertFrom-AdiProjectJson $script:files[$name]
  if($cache.observation -and $cache.observation.id -ceq $failed.observation.id){$cache.observation.state='repository';$script:files[$name]=ConvertTo-AdiProjectJson $cache}
 }
}
$fenced=Get-AdiProjectContext $io $settings @{cwd='C:/another'}
Check $fenced.collector_id $first.collector_id 'cache corruption does not replace instance'
Check $fenced.observation $null 'cache corruption must not forge evidence'
$io.probe=$defaultProbe
$script:tick+=300000;$script:now+=300000
$repaired=Get-AdiProjectContext $io $settings @{cwd='C:/another'}
Check $repaired.observation.sequence '6' 'cache repair keeps durable ordering'
$saved=$script:files['/state/identity.json'];$script:readFailure=$true
$unreadable=Get-AdiProjectContext $io $settings $payload
Check $unreadable $null 'temporary read failure must omit optional metadata'
Check $script:files['/state/identity.json'] $saved 'temporary read failure must not replace identity'
$script:readFailure=$false
$script:files['/state/identity.json']='{broken'
$restarted=Get-AdiProjectContext $io $settings $payload
if($restarted.collector_id -ceq $first.collector_id){throw 'damaged sequence must create a new instance'}
Check $restarted.observation.sequence '1' 'new instance can start at one'
Write-Output 'PowerShell project state assertions passed'
`;
try{
 const script=join(directory,'test.ps1');await writeFile(script,program);
 const result=await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',script,core],{timeout:15000});
 assert.equal(result.stderr,'');assert.equal(result.stdout.trim(),'PowerShell project state assertions passed');process.stdout.write(result.stdout);
 const persistent=join(directory,'persistent.ps1'),root=join(directory,'project-state');
 await writeFile(persistent,String.raw`param([string]$Core,[string]$Adapter,[string]$Root,[string]$Token)
$ErrorActionPreference='Stop'
. $Core
. $Adapter
$io=New-AdiProjectIo $Root 'macos' {param($Workspace)@{state='no_remote';reason=$null;git_root=$Workspace;remotes=@()}}
$context=Get-AdiProjectContext $io @{installation_id='11111111-1111-4111-8111-111111111111';token=$Token;endpoint='http://example.invalid/hooks'} @{cwd='/synthetic/project'}
ConvertTo-AdiProjectJson $context
`);
 async function observe(token='adi_'+('a'.repeat(43)),storageRoot=root){const answer=await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',persistent,core,adapter,storageRoot,token],{timeout:15000});assert.equal(answer.stderr,'');return JSON.parse(answer.stdout);}
 const first=await observe(),second=await observe();
 assert.equal(first.observation.sequence,'1');assert.deepEqual(second,first,'separate sender processes must reuse the durable identity and original observation');
 const rotated=await observe('adi_'+('b'.repeat(43)));assert.equal(rotated.collector_id,first.collector_id);assert.equal(rotated.observation.sequence,'2','credential changes must invalidate the account cache without replacing the instance');
 const state=JSON.parse(await readFile(join(root,'identity.json'),'utf8'));assert.equal(state.sequence,'2');
 await writeFile(join(root,'identity.json'),'{broken',{mode:0o600});
 const replaced=await observe();assert.notEqual(replaced.collector_id,first.collector_id);assert.equal(replaced.observation.sequence,'1');
 const concurrent=await Promise.all([observe(),observe(),observe()]);
 for(const answer of concurrent)assert.deepEqual(answer,replaced,'independent processes must not start a second probe during the throttle period');
 const beforeUnsafe=await readFile(join(root,'identity.json'),'utf8'),alias=join(directory,'state-link');
 await symlink(root,alias,'dir');assert.equal(await observe(undefined,alias),null,'state reached through a symlink must be omitted');
 assert.equal(await readFile(join(root,'identity.json'),'utf8'),beforeUnsafe,'an unsafe state path must not replace the durable identity');
 process.stdout.write('PowerShell persistent state checks passed (portable filesystem only; Windows ACLs not validated).\n');
 const repo=join(directory,'项目 with spaces'),gitScript=join(directory,'git.ps1'),recorded=join(directory,'git-output.json');
 // Use the installed binary, not macOS's xcrun/installer shim.
 const gitExecutable='/Library/Developer/CommandLineTools/usr/bin/git';
 const git=async(...args)=>promisify(execFile)(gitExecutable,args,{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
 await git('init',repo);
 await git('-C',repo,'remote','add','Origin','https://user:synthetic-secret@HOST.example.invalid/Team/App.git?token=synthetic-secret');
 await git('-C',repo,'config','--add','remote.Origin.url','git@10.1.2.3:team/app.git');
 await git('-C',repo,'config','--add','remote.Origin.pushurl','ssh://push.example.invalid:2222/team/app.git');
 await git('-C',repo,'remote','add','alias','https://host.example.invalid/Team/App.git');
 await git('-C',repo,'remote','add','origin','/local/repository');
 // Replay real local Git output at the agreed process seam to check complete
 // multi-remote semantics independently of macOS's ~30-50ms .NET child launch.
 // Replay is not Windows timing or process-tree acceptance.
 const recordings=[];
 for(const args of [
  ['rev-parse','--show-toplevel'],['config','--null','--get-regexp','^remote\\..*\\.(url|pushurl)$'],
  ['remote','get-url','--all','--','Origin'],['remote','get-url','--push','--all','--','Origin'],
  ['remote','get-url','--all','--','alias'],['remote','get-url','--push','--all','--','alias'],
  ['remote','get-url','--all','--','origin'],['remote','get-url','--push','--all','--','origin'],
 ]){const answer=await git('-C',repo,...args);recordings.push({arguments:['-C',repo,...args],result:{code:0,out:answer.stdout,err:answer.stderr}});}
 await writeFile(recorded,JSON.stringify(recordings),{mode:0o600});
 await writeFile(gitScript,String.raw`param([string]$Core,[string]$Adapter,[string]$Workspace,[string]$Recordings)
$ErrorActionPreference='Stop'
. $Core
. $Adapter
# Developer-only process shim: compilation is outside the probe; Windows must
# instead use an installer-compiled runner with a job-owned process tree.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
public static class PortableGitRunner {
 public static void Fail(string reason){throw new Exception(reason);}
 public static Dictionary<string,object> Run(string[] arguments,int timeout) {
  var info=new ProcessStartInfo("/Library/Developer/CommandLineTools/usr/bin/git"){UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true};
  foreach(var arg in arguments)info.ArgumentList.Add(arg);
  foreach(var key in info.Environment.Keys.ToArray())if(key.StartsWith("GIT_",StringComparison.Ordinal))info.Environment.Remove(key);
  info.Environment["GIT_CONFIG_GLOBAL"]="/dev/null";info.Environment["GIT_CONFIG_SYSTEM"]="/dev/null";info.Environment["GIT_CONFIG_NOSYSTEM"]="1";info.Environment["LC_ALL"]="C";
  using(var child=new Process{StartInfo=info}) {
   child.Start();
   try {
    var stdout=child.StandardOutput.ReadToEndAsync();var stderr=child.StandardError.ReadToEndAsync();
    if(!child.WaitForExit(timeout)||!stdout.Wait(timeout)||!stderr.Wait(timeout))throw new Exception("timeout");
    return new Dictionary<string,object>{{"code",child.ExitCode},{"out",stdout.Result},{"err",stderr.Result}};
   }finally{if(!child.HasExited)child.Kill(true);}
  }
 }
}
'@
$runner={param([string[]]$Arguments,[int]$Timeout)[PortableGitRunner]::Run($Arguments,$Timeout)}
if($Recordings){
 $fixtureResults=ConvertFrom-AdiProjectJson ([IO.File]::ReadAllText($Recordings))
 $runner={param([string[]]$Arguments,[int]$Timeout)
  foreach($entry in $fixtureResults){
   if((ConvertTo-AdiProjectJson $entry.arguments) -ceq (ConvertTo-AdiProjectJson $Arguments)){
    if($entry.fault){[PortableGitRunner]::Fail($entry.fault)}
    return $entry.result
   }
  }
  throw 'unexpected_git_arguments'
 }
}
ConvertTo-AdiProjectJson (Get-AdiGitObservation $Workspace 'macos' $runner)
`);
 async function probe(workspace,recordings=''){const answer=await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',gitScript,core,gitAdapter,workspace,recordings],{timeout:15000});assert.equal(answer.stderr,'');return JSON.parse(answer.stdout);}
 const observation=await probe(repo,recorded);
 assert.equal(observation.state,'repository',JSON.stringify(observation));assert.equal(observation.git_root,repo);
 assert.deepEqual(observation.remotes,[
  {address:'https://host.example.invalid/Team/App.git'},
  {address:'10.1.2.3:team/app.git'},
  {address:'ssh://push.example.invalid:2222/team/app.git'},
  {address:null},
 ]);
 assert.equal(JSON.stringify(observation).includes('synthetic-secret'),false);
 const failureFile=join(directory,'git-failure.json');
 await writeFile(failureFile,JSON.stringify([{...recordings[0],fault:'timeout'}]),{mode:0o600});
 const failure=await probe(repo,failureFile);assert.equal(failure.state,'failed');assert.equal(failure.reason,'timeout','native process timeout must retain its public reason');
 assert.equal((await probe(directory)).state,'not_git');
 const noRemote=join(directory,'no-remote');await git('init',noRemote);
 assert.equal((await probe(noRemote)).state,'no_remote');
 process.stdout.write('PowerShell Git checks passed: real notGit/noRemote probes and complete multi-remote output replay; Windows process/timing acceptance remains pending.\n');
}finally{await rm(directory,{recursive:true,force:true});}
