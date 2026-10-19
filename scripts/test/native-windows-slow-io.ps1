param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$NativeModule)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
if($id.IsSystem -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $PSVersionTable.PSVersion.Major -ne 5){throw 'ordinary_windows_5_1_required'}
if([IO.Path]::GetFileName($Root) -notmatch '^adi-native-validation-[a-f0-9-]{36}$'){throw 'isolated_root_required'}
# The installed source is read, never edited. Only the isolated test binary
# substitutes a delayed filesystem call. This is controlled boundary evidence,
# not a claim that the released binary ran on every kind of physical slow disk.
. $NativeModule
$originalClient=$script:AdiClientSource;$originalProcess=$script:AdiProcessSource
$fixture=Join-Path $Root ('slow-io-'+[guid]::NewGuid().ToString().Substring(0,8));[void][IO.Directory]::CreateDirectory($fixture)
$base=Join-Path $fixture 'client';$release=Join-Path $base ([guid]::NewGuid().ToString());[void][IO.Directory]::CreateDirectory($release)
$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($id.User);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id.User,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))
[IO.Directory]::SetAccessControl($base,$acl)
$utf8=New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $base '.owned'),'adi-native-client-v2',$utf8)
$helper=@'
namespace Adi.Native { internal static class TestDisk {
 public static void Delay(string path,string mode) {
  if(System.Environment.GetEnvironmentVariable("ADI_TEST_DISK_MODE")==mode && path.StartsWith(System.Environment.GetEnvironmentVariable("ADI_TEST_DISK_ROOT")+System.IO.Path.DirectorySeparatorChar,System.StringComparison.OrdinalIgnoreCase)) {
   System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("ADI_TEST_DISK_MARKER"),mode);
   System.Threading.Thread.Sleep(2500);
  }
 }
}}
'@
function Substitute([string]$Text,[string]$Anchor,[string]$Replacement){
 if(($Text.Split([string[]]@($Anchor),[StringSplitOptions]::None)).Length -ne 2){throw 'source_anchor_not_unique'}
 return $Text.Replace($Anchor,$Replacement)
}
$read='while(offset<bytes.Length&&(count=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=count;'
$write='byte[] bytes=NativeJson.Utf8.GetBytes(NativeJson.Encode(value));stream.Write(bytes,0,bytes.Length);stream.Flush(true);'
$delayed=Substitute $originalClient $read ('TestDisk.Delay(path,"read");'+$read)
$delayed=Substitute $delayed $write ('byte[] bytes=NativeJson.Utf8.GetBytes(NativeJson.Encode(value));TestDisk.Delay(path,"write");stream.Write(bytes,0,bytes.Length);TestDisk.Delay(path,"flush");stream.Flush(true);')
$script:AdiClientSource=$delayed+$helper
$good=Join-Path $release 'good.exe';Install-AdiProcessLibrary $good
# Negative control removes both process and optional-project wait boundaries.
# The same delayed filesystem call must exceed the IDE deadline, proving this
# fixture detects the missing bounds. These changes never enter a release.
$script:AdiClientSource=Substitute ($delayed+$helper) 'probe.Join(projectBudget)' 'probe.Join(4000)'
$script:AdiProcessSource=Substitute $originalProcess 'worker.Join(Math.Max(1,750-(int)clock.ElapsedMilliseconds))' 'worker.Join(4000)'
$bad=Join-Path $release 'negative.exe';Install-AdiProcessLibrary $bad
Add-Type -AssemblyName System.Web.Extensions
$json=New-Object Web.Script.Serialization.JavaScriptSerializer
$http=@'
using System;using System.IO;using System.Net.Sockets;using System.Text;
public static class SlowIoHttp {
 public static string Receive(TcpClient c) {
  c.ReceiveTimeout=1000;var s=c.GetStream();var header=new MemoryStream();int b,last=0;
  while((b=s.ReadByte())>=0){header.WriteByte((byte)b);last=(last<<8)|b;if(last==0x0d0a0d0a)break;if(header.Length>16384)throw new Exception("header_limit");}
  string h=Encoding.ASCII.GetString(header.ToArray());int n=0;
  foreach(string l in h.Split(new[]{"\r\n"},StringSplitOptions.None))if(l.StartsWith("Content-Length:",StringComparison.OrdinalIgnoreCase))n=int.Parse(l.Substring(15).Trim());
  if(n<1||n>2097152)throw new Exception("body_limit");byte[] bytes=new byte[n];int at=0;
  while(at<n){int count=s.Read(bytes,at,n-at);if(count==0)throw new Exception("truncated");at+=count;}
  var answer=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");s.Write(answer,0,answer.Length);return Encoding.UTF8.GetString(bytes);
 }
}
'@
Add-Type -TypeDefinition $http
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start()
$config=Join-Path $release 'config.json';$project=Join-Path $fixture 'project';[void][IO.Directory]::CreateDirectory($project)
[IO.File]::WriteAllText($config,$json.Serialize(@{installation_id='11111111-1111-4111-8111-111111111111';token=('adi_'+('a'*43));endpoint=('http://127.0.0.1:'+$listener.LocalEndpoint.Port+'/hooks')}),$utf8)
function Snapshot {
 $state=Join-Path $base 'project-state'
 if(!(Test-Path $state)){return ''}
 return ((Get-ChildItem $state -File -Recurse | Where-Object {$_.Name -notlike '.state-*' -and $_.Name -ne 'state.lock'} | Sort-Object FullName | ForEach-Object {[string]$_.FullName+'|'+[string](Get-FileHash $_.FullName).Hash}) -join "`n")
}

function Send([string]$Binary,[string]$Mode,[switch]$Negative){
 $marker=Join-Path $fixture ('marker-'+[guid]::NewGuid().ToString());$raw=$json.Serialize(@{hook_event_name='UserPromptSubmit';session_id='slow-io-test';cwd=[string]$project})
 $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$Binary;$info.Arguments='"'+$config+'"';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $info.EnvironmentVariables['ADI_TEST_DISK_MODE']=$Mode;$info.EnvironmentVariables['ADI_TEST_DISK_ROOT']=(Join-Path $base 'project-state');$info.EnvironmentVariables['ADI_TEST_DISK_MARKER']=$marker
 $child=New-Object Diagnostics.Process;$child.StartInfo=$info;$accept=$listener.BeginAcceptTcpClient($null,$null);$clock=[Diagnostics.Stopwatch]::StartNew();$packet=$null
 try {
  $null=$child.Start();$child.StandardInput.Write($raw);$child.StandardInput.Close()
  if($Negative){if($child.WaitForExit(2000)){throw 'negative_control_not_red'};if(!(Test-Path $marker)){throw 'delay_not_reached'};Write-Output 'negative control: IDE deadline exceeded as expected';return}
  if(!$accept.AsyncWaitHandle.WaitOne(1500)){throw 'normal_hook_not_delivered'}
  $connection=$listener.EndAcceptTcpClient($accept);try{$packet=$json.DeserializeObject([SlowIoHttp]::Receive($connection))}finally{$connection.Close()}
  if(!$child.WaitForExit(1000)){throw 'sender_lingering'}
  if($clock.ElapsedMilliseconds -ge 1200 -or $child.ExitCode -ne 0 -or $child.StandardOutput.ReadToEnd() -or $child.StandardError.ReadToEnd()){throw 'exit_contract_failed'}
  if($Mode -and (!(Test-Path $marker) -or $packet.ContainsKey('project'))){throw 'slow_io_not_exercised_or_unconfirmed_metadata'}
  Write-Host ('passed '+$Mode+' wall_ms='+$clock.ElapsedMilliseconds)
  return ,$packet
 }finally{if(!$child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
}
try {
 $first=Send $good '';if(!$first.ContainsKey('project') -or !$first.project.observation){throw 'baseline_missing_observation'};$initial=Snapshot
 $null=Send $good 'read';if((Snapshot) -cne $initial){throw 'read_modified_cache'}
 $null=Send $good '';if((Snapshot) -cne $initial){throw 'read_recovery_changed_cache'}
 # New workspace forces an atomic state write while preserving existing cache.
 $project=Join-Path $fixture 'next';[void][IO.Directory]::CreateDirectory($project)
 foreach($mode in @('write','flush')){
  $null=Send $good $mode;if((Snapshot) -cne $initial){throw ($mode+'_modified_committed_state')}
 }
 $project=Join-Path $fixture 'project';$null=Send $good '';if((Snapshot) -cne $initial){throw 'write_recovery_changed_cache'}
 Send $bad 'read' -Negative
 Write-Output 'controlled filesystem-delay suite passed; no production source or installed Hook changed'
}finally{$listener.Stop();$script:AdiClientSource=$originalClient;$script:AdiProcessSource=$originalProcess;if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}}
