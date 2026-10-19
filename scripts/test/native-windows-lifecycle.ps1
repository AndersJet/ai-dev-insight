param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$PackageDirectory,[Parameter(Mandatory=$true)][string]$GitDirectory,[switch]$DamageIdentity,[switch]$DamageCache,[switch]$Concurrent,[switch]$Boundaries,[switch]$JsonCodec,[string]$LegacyPackageDirectory,[switch]$UnicodeProject,[switch]$LegacyWorker,[switch]$Projects,[switch]$SlowConcurrency,[string]$NativeGitFixture,[switch]$OnlySlowConcurrency,[switch]$RequireLegacyRepository,[switch]$IoBoundaries)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$p=New-Object Security.Principal.WindowsPrincipal($id)
if($PSVersionTable.PSVersion.Major -ne 5 -or $id.IsSystem -or $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ordinary_windows_5_1_required'}
if([IO.Path]::GetFileName($Root) -notmatch '^adi-native-validation-[a-f0-9-]{36}$'){throw 'isolated_root_required'}
foreach($path in @($PackageDirectory,$GitDirectory)){if(!$path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'isolated_inputs_required'}}
if($LegacyPackageDirectory -and !$LegacyPackageDirectory.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'isolated_legacy_required'}
if($NativeGitFixture -and !$NativeGitFixture.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'isolated_fixture_required'}
$activePackage=$PackageDirectory;if($LegacyPackageDirectory){$activePackage=$LegacyPackageDirectory}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
public static class LifecycleHttp {
 public static string Receive(TcpClient connection,string token) {
  using(var stream=connection.GetStream()) {
   stream.ReadTimeout=2000;var header=new MemoryStream();int next;
   while(true) {
    next=stream.ReadByte();if(next<0||header.Length>=16384)throw new Exception("invalid_http_header");header.WriteByte((byte)next);
    string text=Encoding.ASCII.GetString(header.ToArray());if(!text.EndsWith("\r\n\r\n"))continue;
    if(text.IndexOf("Authorization: Bearer "+token+"\r\n",StringComparison.Ordinal)<0)throw new Exception("wrong_synthetic_credential");
    var match=System.Text.RegularExpressions.Regex.Match(text,@"(?im)^Content-Length: ([0-9]+)\r?$");if(!match.Success)throw new Exception("missing_length");
    int length=int.Parse(match.Groups[1].Value);if(length>2097152)throw new Exception("body_limit");
    if(text.IndexOf("Expect: 100-continue",StringComparison.OrdinalIgnoreCase)>=0){var c=Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");stream.Write(c,0,c.Length);}
    var bytes=new byte[length];int offset=0;
    while(offset<length){int count=stream.Read(bytes,offset,length-offset);if(count==0)throw new Exception("truncated_body");offset+=count;}
    var response=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");stream.Write(response,0,response.Length);
    return Encoding.UTF8.GetString(bytes);
   }
  }
 }
}
'@
Add-Type -AssemblyName System.Web.Extensions
$json=New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength=2097152;$json.RecursionLimit=32
$fixture=Join-Path $Root ('lc-'+[guid]::NewGuid().ToString().Substring(0,8))
[void][IO.Directory]::CreateDirectory($fixture)
# Keep the fixture below Desktop CLR's legacy path limit, including random
# temporary names. Quote and dollar handling remain part of the public test.
$profile=Join-Path $fixture "p ' `$d"
$base=Join-Path $profile 'adi-native-collector'
$credentials=Join-Path $fixture 'synthetic-credentials.json'
$repo=Join-Path $fixture 'project with spaces'
if($UnicodeProject){$repo=Join-Path $fixture ('p'+[char]0x4e2d+[char]0xd83d+[char]0xde00+" ' &")}
$env:PATH=$GitDirectory+';'+$env:PATH;$git=Join-Path $GitDirectory 'git.exe'
& $git init --quiet $repo;if($LASTEXITCODE){throw 'git_init_failed'}
& $git -C $repo remote add Origin 'https://repo.example.invalid/team/app.git'
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start();$endpoint='http://127.0.0.1:'+$listener.LocalEndpoint.Port+'/hooks'
$token='adi_'+('a'*43)
function Configure([string]$Value){$script:token=$Value;[IO.File]::WriteAllText($credentials,$json.Serialize(@{installation_id='11111111-1111-4111-8111-111111111111';token=$Value;endpoint=$endpoint}),(New-Object Text.UTF8Encoding($false)))}
function Install([string]$Action='install'){
  $answer=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $activePackage 'install-hook.ps1') $Action -TraeDir $profile -Credentials $credentials
  if($LASTEXITCODE){throw ('installer_failed_'+$Action)}
  return $json.DeserializeObject(($answer -join ''))
}
function Release {
  $manifest=$json.DeserializeObject([IO.File]::ReadAllText((Join-Path $base 'manifest.json')))
  return Join-Path $base $manifest.release
}
function Send([string]$Session,[string]$Cwd=$repo,[switch]$InstalledCommand,[string]$RawOverride,[switch]$AllowNoProject){
  $release=Release;$config=Join-Path $release 'config.json'
  $raw='{"hook_event_name":"UserPromptSubmit","session_id":'+$json.Serialize($Session)+',"cwd":'+$json.Serialize($Cwd)+',"n":9007199254740993,"A":1,"a":2}'
  if($RawOverride){$raw=$RawOverride}
  $request=$listener.BeginAcceptTcpClient($null,$null)
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=Join-Path $release 'adi-sender.exe';$info.Arguments='"'+$config+'"'
  if($LegacyWorker -and $activePackage -ceq $LegacyPackageDirectory){
    # Old-format state production only. This bypasses the old sender deadline
    # and must never count as old/new cold-latency acceptance.
    $program="& '"+(Join-Path $release 'send-worker.ps1').Replace("'","''")+"' -Config '"+$config.Replace("'","''")+"'"
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
  }
  if($InstalledCommand){
    $hooks=$json.DeserializeObject([IO.File]::ReadAllText((Join-Path $profile 'hooks.json')))
    $command=$hooks.hooks.UserPromptSubmit[0].hooks[0].command
    if($hooks.hooks.UserPromptSubmit[0].hooks[0].timeout -ne 2){throw 'hook_timeout_changed'}
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  }
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $child=New-Object Diagnostics.Process;$child.StartInfo=$info
  try {
    $clock=[Diagnostics.Stopwatch]::StartNew();$null=$child.Start()
    $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$child.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$child.StandardInput.Close()
    if(!$request.AsyncWaitHandle.WaitOne(5000)){throw ('hook_not_delivered_'+$Session)}
    $connection=$listener.EndAcceptTcpClient($request)
    try{$body=[LifecycleHttp]::Receive($connection,$token)}finally{$connection.Close()}
    if(!$child.WaitForExit(1500)){throw 'sender_did_not_exit'}
    $stdout=$child.StandardOutput.ReadToEnd();$stderr=$child.StandardError.ReadToEnd()
    if($child.ExitCode -ne 0 -or $stdout){throw 'sender_not_silent'}
    if($stderr -and !($LegacyWorker -and $activePackage -ceq $LegacyPackageDirectory)){throw 'sender_not_silent'}
    $limit=1200;if($InstalledCommand){$limit=2000}
    if($LegacyWorker -and $activePackage -ceq $LegacyPackageDirectory){$limit=5000}
    if($clock.ElapsedMilliseconds -ge $limit){throw ('command_wall_limit_'+$clock.ElapsedMilliseconds)}
    if($InstalledCommand){Write-Host ('installed Hook wall ms: '+$clock.ElapsedMilliseconds)}
    if(!$body.EndsWith('"payload":'+$raw+'}')){throw 'raw_payload_changed'}
    $packet=$json.DeserializeObject($body)
    if($packet.source_session_id -cne $Session -or (!$packet.project -and !$AllowNoProject)){throw ('project_missing_'+$Session)}
    return $packet
  } finally {if(!$child.HasExited){$child.Kill()};$child.Dispose()}
}
function BoundedFailure([ValidateSet('unfinished-input','http-stall','invalid-json')][string]$Mode,[string]$RawOverride){
  $release=Release;$config=Join-Path $release 'config.json';$connection=$null
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=Join-Path $release 'adi-sender.exe';$info.Arguments='"'+$config+'"'
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $child=New-Object Diagnostics.Process;$child.StartInfo=$info
  try {
    $clock=[Diagnostics.Stopwatch]::StartNew();$null=$child.Start()
    $raw='{"hook_event_name":"UserPromptSubmit","session_id":'+$json.Serialize([string]$Mode)+',"cwd":'+$json.Serialize([string]$repo)+'}'
    if($RawOverride){$raw=$RawOverride}
    $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$child.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
    if($Mode -eq 'invalid-json'){$child.StandardInput.Close()}
    elseif($Mode -eq 'http-stall'){
      $child.StandardInput.Close();$pending=$listener.BeginAcceptTcpClient($null,$null)
      if(!$pending.AsyncWaitHandle.WaitOne(5000)){throw 'http_stall_not_reached'}
      $connection=$listener.EndAcceptTcpClient($pending)
      # Hold the accepted connection without replying. The actual client must
      # stop while the peer remains live; closing early would test reset only.
    }
    if(!$child.WaitForExit(1500)){throw ('failure_not_bounded_'+$Mode)}
    if($child.ExitCode -ne 0 -or $child.StandardOutput.ReadToEnd() -or $child.StandardError.ReadToEnd()){throw ('failure_not_silent_'+$Mode)}
    if($clock.ElapsedMilliseconds -ge 1200){throw ('failure_wall_limit_'+$Mode)}
    if($Mode -ne 'http-stall' -and $listener.Pending()){throw ('invalid_or_unfinished_input_published_'+$Mode)}
    if($Mode -eq 'http-stall'){$connection.Close();$connection=$null;Start-Sleep -Milliseconds 100;if($listener.Pending()){throw 'http_stall_automatically_retried'}}
    Write-Host ('passed: '+$Mode+' bounded, silent, no automatic retry')
  } finally {if($connection){$connection.Close()};if(!$child.HasExited){$child.Kill()};$child.Dispose()}
}
function ConcurrentCached([string]$Expected){
  $release=Release;$config=Join-Path $release 'config.json';$children=New-Object Collections.Generic.List[object]
  try {
    foreach($index in 1..3){
      $info=New-Object Diagnostics.ProcessStartInfo
      $info.FileName=Join-Path $release 'adi-sender.exe';$info.Arguments='"'+$config+'"'
      $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
      $child=New-Object Diagnostics.Process;$child.StartInfo=$info
      $clock=[Diagnostics.Stopwatch]::StartNew();$null=$child.Start()
      $children.Add(@{process=$child;clock=$clock;session=('concurrent-'+$index)})
    }
    foreach($item in $children){
      $raw='{"hook_event_name":"UserPromptSubmit","session_id":'+$json.Serialize([string]$item.session)+',"cwd":'+$json.Serialize([string]$repo)+'}'
      $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$item.process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$item.process.StandardInput.Close()
    }
    $sessions=New-Object Collections.Generic.HashSet[string]
    foreach($index in 1..3){
      $pending=$listener.BeginAcceptTcpClient($null,$null)
      if(!$pending.AsyncWaitHandle.WaitOne(5000)){throw 'concurrent_hook_not_delivered'}
      $connection=$listener.EndAcceptTcpClient($pending)
      try{$packet=$json.DeserializeObject([LifecycleHttp]::Receive($connection,$token))}finally{$connection.Close()}
      if(!$sessions.Add($packet.source_session_id)){throw 'concurrent_duplicate_event'}
      if(!$packet.project -or $json.Serialize($packet.project) -cne $Expected){throw 'concurrent_cache_changed'}
    }
    foreach($item in $children){
      if(!$item.process.WaitForExit(1500)){throw 'concurrent_sender_did_not_exit'}
      if($item.process.ExitCode -ne 0 -or $item.process.StandardOutput.ReadToEnd() -or $item.process.StandardError.ReadToEnd()){throw 'concurrent_sender_not_silent'}
      if($item.clock.ElapsedMilliseconds -ge 2000){throw 'concurrent_hook_wall_limit'}
      if(!$sessions.Contains($item.session)){throw 'concurrent_wrong_session'}
    }
    Write-Host 'passed: three concurrent Hooks retain the same cached observation'
  } finally {foreach($item in $children){if(!$item.process.HasExited){$item.process.Kill()};$item.process.Dispose()}}
}
function FirstSlowConcurrent {
  $originalPath=$env:PATH
  $wrapper=Join-Path $fixture 'slow-git';[void][IO.Directory]::CreateDirectory($wrapper)
  $fake=Join-Path $wrapper 'git.exe';$log=Join-Path $wrapper 'attempts.txt'
  if(!$NativeGitFixture){throw 'native_arm64_fixture_required'}
  [IO.File]::Copy($NativeGitFixture,$fake,$false)
  $children=New-Object Collections.Generic.List[object];$workspace=Join-Path $fixture 'slow-project';[void][IO.Directory]::CreateDirectory($workspace)
  $release=Release;$config=Join-Path $release 'config.json'
  try {
    $env:PATH=$wrapper+';'+$originalPath
    foreach($index in 1..2){
      $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=Join-Path $release 'adi-sender.exe';$info.Arguments='"'+$config+'"'
      $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
      $child=New-Object Diagnostics.Process;$child.StartInfo=$info;$clock=[Diagnostics.Stopwatch]::StartNew();$null=$child.Start()
      $children.Add(@{process=$child;clock=$clock;session=('first-slow-'+$index)})
    }
    foreach($item in $children){
      $raw='{"hook_event_name":"UserPromptSubmit","session_id":'+$json.Serialize([string]$item.session)+',"cwd":'+$json.Serialize($workspace)+'}'
      $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$item.process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$item.process.StandardInput.Close()
    }
    $sessions=New-Object Collections.Generic.HashSet[string];$evidence=$null
    foreach($index in 1..2){
      $pending=$listener.BeginAcceptTcpClient($null,$null);if(!$pending.AsyncWaitHandle.WaitOne(5000)){throw 'first_concurrent_no_delivery'}
      $connection=$listener.EndAcceptTcpClient($pending);try{$packet=$json.DeserializeObject([LifecycleHttp]::Receive($connection,$token))}finally{$connection.Close()}
      if(!$sessions.Add($packet.source_session_id)){throw 'first_concurrent_duplicate_event'}
      Write-Host ('concurrent context='+[bool]$packet.project+'; observation='+[bool]$packet.project.observation)
      # A competing Hook may omit optional metadata when it cannot safely
      # read state within the project budget; the normal event must still send.
      if($packet.project -and $packet.project.observation){
        if($packet.project.observation.state -cne 'failed' -or $packet.project.observation.reason -cne 'timeout'){throw 'first_concurrent_wrong_failure'}
        if($evidence -and $json.Serialize($evidence) -cne $json.Serialize($packet.project)){throw 'first_concurrent_reprobed'}
        $evidence=$packet.project
      }
    }
    foreach($item in $children){
      if(!$item.process.WaitForExit(1500)){throw 'first_concurrent_not_bounded'}
      if($item.process.ExitCode -ne 0 -or $item.process.StandardOutput.ReadToEnd() -or $item.process.StandardError.ReadToEnd()){throw 'first_concurrent_not_silent'}
      if($item.clock.ElapsedMilliseconds -ge 2000){throw 'first_concurrent_hook_deadline'}
      if(!$sessions.Contains($item.session)){throw 'first_concurrent_wrong_session'}
    }
    $attemptCount=0;if([IO.File]::Exists($log)){$attemptCount=@([IO.File]::ReadAllLines($log)).Count}
    Write-Host ('first concurrent evidence='+[bool]$evidence+'; actual Git entries='+$attemptCount)
    if(!$evidence -or $attemptCount -ne 1){throw 'first_concurrent_probe_count'}
    $repeat=Send 'failed-cache' $workspace
    if($json.Serialize($repeat.project) -cne $json.Serialize($evidence) -or [IO.File]::ReadAllLines($log).Length -ne 1){throw 'failed_probe_retried'}
    $pidFile=Join-Path $wrapper 'child.pid.bin';if(![IO.File]::Exists($pidFile)){throw 'slow_descendant_not_started'}
    $descendant=[BitConverter]::ToInt32([IO.File]::ReadAllBytes($pidFile),0);Start-Sleep -Milliseconds 100
    $alive=Get-Process -Id $descendant -ErrorAction SilentlyContinue
    if($alive){if($alive.Path -ceq $fake){Stop-Process -Id $descendant};throw 'slow_descendant_survived'}
    Write-Host 'passed: first concurrent Hooks reserve one slow Git probe; timeout cached; descendant killed'
    $output=Join-Path $fixture 'output-project';[void][IO.Directory]::CreateDirectory($output)
    $limited=Send 'output-limit' $output
    if($limited.project.observation.state -cne 'failed' -or $limited.project.observation.reason -cne 'output_limit'){throw 'output_limit_not_reported'}
    $descendant=[BitConverter]::ToInt32([IO.File]::ReadAllBytes($pidFile),0);Start-Sleep -Milliseconds 100
    $alive=Get-Process -Id $descendant -ErrorAction SilentlyContinue
    if($alive){if($alive.Path -ceq $fake){Stop-Process -Id $descendant};throw 'output_descendant_survived'}
    if([IO.File]::ReadAllLines($log).Length -ne 2){throw 'output_limit_reprobed'}
    Write-Host 'passed: stdout byte limit reports failure and kills started descendants'
    # Kill the actual sender after its Git parent and descendant exist, before
    # the Git deadline. Closing the sender's Job handles must kill the whole
    # tree, while its already persisted reservation must fence the next Hook.
    $parentFile=Join-Path $wrapper 'parent.pid.bin'
    [IO.File]::Delete($pidFile);[IO.File]::Delete($parentFile)
    $interruptedWorkspace=Join-Path $fixture 'interrupt-project';[void][IO.Directory]::CreateDirectory($interruptedWorkspace)
    $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=Join-Path $release 'adi-sender.exe';$info.Arguments='"'+$config+'"'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $interrupted=New-Object Diagnostics.Process;$interrupted.StartInfo=$info
    try {
      $null=$interrupted.Start()
      $raw='{"hook_event_name":"UserPromptSubmit","session_id":"interrupted","cwd":'+$json.Serialize($interruptedWorkspace)+'}'
      $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$interrupted.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$interrupted.StandardInput.Close()
      $wait=[Diagnostics.Stopwatch]::StartNew()
      while(!$interrupted.HasExited -and ![IO.File]::Exists($pidFile) -and $wait.ElapsedMilliseconds -lt 1500){Start-Sleep -Milliseconds 2}
      if($interrupted.HasExited -or ![IO.File]::Exists($pidFile) -or ![IO.File]::Exists($parentFile)){throw 'interrupt_tree_not_reached'}
      $gitParent=[BitConverter]::ToInt32([IO.File]::ReadAllBytes($parentFile),0)
      $gitChild=[BitConverter]::ToInt32([IO.File]::ReadAllBytes($pidFile),0)
      foreach($number in @($gitParent,$gitChild)){
        $live=Get-Process -Id $number -ErrorAction SilentlyContinue
        if(!$live -or $live.Path -cne $fake){throw 'interrupt_tree_not_live'}
      }
      $interrupted.Kill();if(!$interrupted.WaitForExit(1000)){throw 'interrupted_sender_survived'}
      Start-Sleep -Milliseconds 100
      foreach($number in @($gitParent,$gitChild)){
        $live=Get-Process -Id $number -ErrorAction SilentlyContinue
        if($live){if($live.Path -ceq $fake){Stop-Process -Id $number};throw 'interrupted_tree_survived'}
      }
      if($listener.Pending()){throw 'interrupted_probe_published_partial_event'}
      $pending=Send 'after-interruption' $interruptedWorkspace
      if($pending.project.observation -or [IO.File]::ReadAllLines($log).Length -ne 3){throw 'interrupted_reservation_reprobed_or_fabricated'}
      Write-Host 'passed: killing actual sender closes Git tree; next Hook respects durable reservation'
    } finally {if(!$interrupted.HasExited){$interrupted.Kill()};$interrupted.Dispose()}

  } finally {
    $env:PATH=$originalPath
    foreach($item in $children){if(!$item.process.HasExited){$item.process.Kill()};$item.process.Dispose()}
  }
}
try {
  Configure $token;$null=Install
  if($OnlySlowConcurrency){FirstSlowConcurrent;return}
  $first=Send 'first-cold'
  if($LegacyWorker){
    if(!$first.project.observation -or $first.project.observation.sequence -cne '1'){throw 'legacy_format_observation_required'}
    if($RequireLegacyRepository -and $first.project.observation.state -cne 'repository'){throw 'legacy_successful_repository_required'}
    Write-Host ('legacy format state only: '+$first.project.observation.state+' / '+$first.project.observation.reason)
  }elseif($first.project.observation.state -cne 'repository' -or $first.project.observation.sequence -cne '1'){throw 'cold_repository_observation_required'}
  $snapshot=$json.Serialize($first.project)
  $cached=Send 'cached'
  if($json.Serialize($cached.project) -cne $snapshot -or $cached.client_event_id -ceq $first.client_event_id){throw 'cache_changed_observation'}
  if(!$LegacyWorker){
    $installed=Send 'installed-command' $repo -InstalledCommand
    if($json.Serialize($installed.project) -cne $snapshot){throw 'installed_command_changed_cached_evidence'}
  }
  $old=Release;$activePackage=$PackageDirectory;$null=Install
  if([IO.File]::Exists((Join-Path $old 'adi-sender.exe'))){throw 'old_owned_release_not_removed'}
  if($json.Serialize((Send 'upgraded').project) -cne $snapshot){throw 'upgrade_changed_identity_or_cache'}
  if($LegacyPackageDirectory){Write-Host 'passed: older JSON state upgraded without changing identity or cached evidence'}
  Configure ('adi_'+('b'*43));$null=Install
  $rotated=Send 'credential-rotated'
  if($rotated.project.collector_id -cne $first.project.collector_id -or $rotated.project.observation.sequence -cne '2' -or $rotated.project.observation.id -ceq $first.project.observation.id){throw 'credential_rotation_did_not_reprobe'}
  $cachedRotated=Send 'rotated-cache'
  if($json.Serialize($cachedRotated.project) -cne $json.Serialize($rotated.project)){throw 'rotated_cache_changed'}
  if($Concurrent){ConcurrentCached ($json.Serialize($rotated.project))}
  if($SlowConcurrency){FirstSlowConcurrent}
  if($Boundaries){BoundedFailure 'unfinished-input';BoundedFailure 'http-stall'}
  if($JsonCodec){
    $valid=' {"hook_event_name":"UserPromptSubmit","session_id":"codec-valid","cwd":'+$json.Serialize($repo)+',"nested":[null,true,false,-42,1.25e+2,{"escaped":"\"\\\/\b\f\n\r\t\u4e2d\ud83d\ude00","A":1,"a":2}]} '
    $codec=Send 'codec-valid' $repo -RawOverride $valid
    if($json.Serialize($codec.project) -cne $json.Serialize($rotated.project)){throw 'codec_changed_cached_context'}
    foreach($bad in @('{"a":01}','{"a":1.}','{"a":1e}','{"a":true,}','{"a":"\uZZZZ"}','{"a":"unterminated}','[1,]','{"a":1} trailing')){BoundedFailure 'invalid-json' $bad}
    $deep=('{"a":'*34)+'null'+('}'*34);BoundedFailure 'invalid-json' $deep
    Write-Host 'passed: JSON literals, escapes, case, whitespace, exact raw; malformed and deep input rejected'
  }
  if($Projects){
    & $git -C $repo -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --allow-empty --quiet -m fixture
    if($LASTEXITCODE){throw 'fixture_commit_failed'}
    $worktree=Join-Path $fixture 'linked'; & $git -C $repo worktree add --detach --quiet $worktree
    if($LASTEXITCODE){throw 'fixture_worktree_failed'}
    $linked=Send 'linked-worktree' $worktree
    if($linked.project.workspace -cne $worktree -or $linked.project.observation.state -cne 'repository' -or $linked.project.observation.git_root.Replace('/','\') -cne $worktree){throw 'worktree_not_observed_as_distinct_workspace'}
    $sub=Join-Path $repo 'sub';[void][IO.Directory]::CreateDirectory($sub)
    $nested=Send 'subdirectory' $sub
    if($nested.project.workspace -cne $sub -or $nested.project.observation.git_root.Replace('/','\') -cne $repo){throw 'subdirectory_collapsed_into_git_root'}
    $non=Join-Path $fixture 'plain';[void][IO.Directory]::CreateDirectory($non)
    if((Send 'non-git' $non).project.observation.state -cne 'not_git'){throw 'non_git_not_distinguished'}
    $bare=Join-Path $fixture 'no-remote';& $git init --quiet $bare
    if((Send 'no-remote' $bare).project.observation.state -cne 'no_remote'){throw 'no_remote_not_distinguished'}
    $multi='{"hook_event_name":"UserPromptSubmit","session_id":"multi-roots","cwd":'+$json.Serialize($repo)+',"workspace_roots":['+$json.Serialize($repo)+','+$json.Serialize($non)+']}'
    $ambiguous=Send 'multi-roots' $repo -RawOverride $multi
    if($ambiguous.project.workspace -or $ambiguous.project.observation -or $ambiguous.project.unresolved_reason -cne 'ambiguous_workspace'){throw 'multi_root_project_fabricated'}
    $identityPath=Join-Path $base 'project-state\identity.json'
    $before=[IO.File]::ReadAllText($identityPath)
    $held=[IO.File]::Open($identityPath,'Open','ReadWrite','None')
    try {
      $failed=Send 'identity-read-denied' -AllowNoProject
      if($failed.project){throw 'unreadable_identity_fabricated_instance'}
    } finally {$held.Dispose()}
    if([IO.File]::ReadAllText($identityPath) -cne $before){throw 'io_failure_replaced_identity'}
    Write-Host 'passed: worktree, subdirectory, nonGit, noRemote, ambiguous roots, identity read failure'
  }
  if($IoBoundaries){
    $stateDirectory=Join-Path $base 'project-state';$identityPath=Join-Path $stateDirectory 'identity.json'
    $identityBefore=[IO.File]::ReadAllText($identityPath)
    $cacheDirectory=Join-Path $stateDirectory 'cache';$cachePath=$null
    foreach($file in [IO.Directory]::GetFiles($cacheDirectory,'*.json')){
      $value=$json.DeserializeObject([IO.File]::ReadAllText($file))
      if($value.workspace -ceq $repo.Replace('\','/').TrimEnd('/') -and $value.observation.id -ceq $rotated.project.observation.id){$cachePath=$file}
    }
    if(!$cachePath){throw 'io_cache_fixture_missing'}
    $cacheBefore=[IO.File]::ReadAllText($cachePath)
    $held=[IO.File]::Open($cachePath,'Open','ReadWrite','None')
    try{
      $denied=Send 'cache-read-denied' $repo -AllowNoProject
      if($denied.project){throw 'unreadable_cache_fabricated_metadata'}
    }finally{$held.Dispose()}
    if([IO.File]::ReadAllText($identityPath) -cne $identityBefore -or [IO.File]::ReadAllText($cachePath) -cne $cacheBefore){throw 'cache_io_error_changed_state'}
    $again=Send 'cache-read-recovered' $repo
    if($json.Serialize($again.project) -cne $json.Serialize($rotated.project)){throw 'cache_io_error_reprobed_after_recovery'}
    $backup=Join-Path $stateDirectory 'cache-original';$outside=Join-Path $fixture 'junction-target'
    [void][IO.Directory]::CreateDirectory($outside);[IO.Directory]::Move($cacheDirectory,$backup)
    try{
      $command='mklink /J "'+$cacheDirectory+'" "'+$outside+'"'
      $answer=& cmd.exe /c $command;if($LASTEXITCODE){throw 'junction_fixture_failed'}
      $unsafe=Send 'cache-junction' $repo -AllowNoProject
      if($unsafe.project){throw 'junction_state_path_used'}
      if([IO.Directory]::GetFileSystemEntries($outside).Length -ne 0 -or [IO.File]::ReadAllText($identityPath) -cne $identityBefore){throw 'junction_state_path_wrote_or_changed_identity'}
    }finally{
      if([IO.Directory]::Exists($cacheDirectory)){[IO.Directory]::Delete($cacheDirectory)}
      [IO.Directory]::Move($backup,$cacheDirectory)
    }
    if($json.Serialize((Send 'junction-recovered' $repo).project) -cne $json.Serialize($rotated.project)){throw 'junction_recovery_reprobed'}
    Write-Host 'passed: cache I/O denial and junction fail open, preserve bytes and cached observation'
  }
  if($DamageCache){
    Get-ChildItem -LiteralPath (Join-Path $base 'project-state\cache') -Filter '*.json' -File | ForEach-Object {[IO.File]::WriteAllText($_.FullName,'{broken-cache')}
    $unknown=Send 'damaged-cache'
    if($unknown.project.collector_id -cne $first.project.collector_id -or $unknown.project.observation){throw 'damaged_cache_forged_observation'}
    $fenced=Send 'damaged-cache-repeat'
    if($fenced.project.collector_id -cne $first.project.collector_id -or $fenced.project.observation){throw 'damaged_cache_ignored_throttle_fence'}
    Write-Host 'passed: damaged cache preserves instance and fences repeated probes'
  }
  if($DamageIdentity){
    $identityPath=Join-Path $base 'project-state\identity.json'
    $damaged=$json.DeserializeObject([IO.File]::ReadAllText($identityPath));$damaged['version']='broken'
    [IO.File]::WriteAllText($identityPath,$json.Serialize($damaged),(New-Object Text.UTF8Encoding($false)))
    $recovered=Send 'damaged-identity'
    if($recovered.project.collector_id -ceq $first.project.collector_id -or $recovered.project.observation.sequence -cne '1'){throw 'damaged_identity_did_not_create_new_instance'}
    Write-Host 'passed: damaged identity creates a new collector instance'
  }
  $sid=$id.User.Value
  foreach($path in @($base,(Join-Path $base 'project-state'),(Join-Path $base 'project-state\identity.json'),(Release))){
    $acl=Get-Acl -LiteralPath $path
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid){throw 'wrong_private_owner'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $sid){throw 'shared_private_access'}}
  }
  Write-Output 'passed: cold observation, cache, installed Hook 2s, upgrade, credential reset, exact raw, private ACL'
} finally {$listener.Stop()}
