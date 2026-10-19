param([Parameter(Mandatory=$true)][string]$Root,[ValidateSet('Prepare','Witness','Upgrade','Cleanup')][string]$Action,[string]$Zip,[switch]$ExpectProject)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
if($id.IsSystem -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ordinary_user_required'}
if([IO.Path]::GetFileName($Root) -notmatch '^adi-native-validation-[a-f0-9-]{36}$'){throw 'isolated_root_required'}
$context=Join-Path $Root 'owner-fixture.json';$utf8=New-Object Text.UTF8Encoding($false)
if($Action -eq 'Prepare'){
 if(Test-Path $context){throw 'existing_fixture'}
 $f=Join-Path $Root ('own-'+[guid]::NewGuid().ToString().Substring(0,8));[void][IO.Directory]::CreateDirectory($f)
 $package=Join-Path $f 'old';Expand-Archive -LiteralPath $Zip -DestinationPath $package
 $profile=Join-Path $f 'profile';$credentials=Join-Path $f 'credentials.json'
 [IO.File]::WriteAllText($credentials,(ConvertTo-Json -Compress @{installation_id='11111111-1111-4111-8111-111111111111';token=('adi_'+('a'*43));endpoint='http://127.0.0.1:9/hooks'}),$utf8)
 & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $package 'install-hook.ps1') install -TraeDir $profile -Credentials $credentials | Out-Null;if($LASTEXITCODE){throw 'initial_install_failed'}
 [IO.File]::WriteAllText($context,(ConvertTo-Json -Compress @{fixture=$f;profile=$profile;credentials=$credentials;owned=(Join-Path $profile 'adi-native-collector\.owned')}),$utf8)
 'prepared isolated owner fixture';exit 0
}
$c=ConvertFrom-Json ([IO.File]::ReadAllText($context));if(!$c.fixture.StartsWith($Root+'\own-',[StringComparison]::OrdinalIgnoreCase)){throw 'unexpected_fixture'}
if($Action -eq 'Cleanup'){Remove-Item -LiteralPath $c.fixture -Recurse -Force;Remove-Item -LiteralPath $context -Force;'cleaned isolated owner fixture';exit 0}
if($Action -eq 'Upgrade'){
 $package=Join-Path $c.fixture ('next-'+[guid]::NewGuid().ToString().Substring(0,8));Expand-Archive -LiteralPath $Zip -DestinationPath $package
 & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $package 'install-hook.ps1') install -TraeDir $c.profile -Credentials $c.credentials | Out-Null;if($LASTEXITCODE){throw 'upgrade_failed'}
 'upgraded isolated fixture';exit 0
}
Add-Type -AssemblyName System.Web.Extensions
$json=New-Object Web.Script.Serialization.JavaScriptSerializer
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Net.Sockets;using System.Text;
public static class OwnerFixtureHttp {
 public static string Receive(TcpClient c){c.ReceiveTimeout=1000;var s=c.GetStream();var h=new MemoryStream();int b,last=0;
 while((b=s.ReadByte())>=0){h.WriteByte((byte)b);last=(last<<8)|b;if(last==0x0d0a0d0a)break;if(h.Length>16384)throw new Exception("header_limit");}
 int n=0;foreach(string l in Encoding.ASCII.GetString(h.ToArray()).Split(new[]{"\r\n"},StringSplitOptions.None))if(l.StartsWith("Content-Length:",StringComparison.OrdinalIgnoreCase))n=int.Parse(l.Substring(15).Trim());
 if(n<1||n>2097152)throw new Exception("body_limit");var data=new byte[n];int at=0;while(at<n){int count=s.Read(data,at,n-at);if(count==0)throw new Exception("truncated");at+=count;}
 var r=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");s.Write(r,0,r.Length);return Encoding.UTF8.GetString(data);}
}
'@
$base=Join-Path $c.profile 'adi-native-collector';$m=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $base 'manifest.json')));$release=Join-Path $base $m.release
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$child=New-Object Diagnostics.Process
try {
 $cfg=Join-Path $release 'config.json';[IO.File]::WriteAllText($cfg,(ConvertTo-Json -Compress @{installation_id='11111111-1111-4111-8111-111111111111';token=('adi_'+('a'*43));endpoint=('http://127.0.0.1:'+$listener.LocalEndpoint.Port+'/hooks')}),$utf8)
 $project=Join-Path $c.fixture 'project';[void][IO.Directory]::CreateDirectory($project)
 $child.StartInfo.FileName=Join-Path $release 'adi-sender.exe';$child.StartInfo.Arguments='"'+$cfg+'"';$child.StartInfo.UseShellExecute=$false;$child.StartInfo.CreateNoWindow=$true
 $child.StartInfo.RedirectStandardInput=$true;$child.StartInfo.RedirectStandardOutput=$true;$child.StartInfo.RedirectStandardError=$true
 $child.StartInfo.EnvironmentVariables['PATH']=(Join-Path $Root 'mingit\cmd')+';'+$env:PATH
 $accept=$listener.BeginAcceptTcpClient($null,$null);$clock=[Diagnostics.Stopwatch]::StartNew();$null=$child.Start()
 $raw=$json.Serialize(@{hook_event_name='UserPromptSubmit';session_id='owner-regression';cwd=[string]$project;workspace_roots=@([string]$project)});$child.StandardInput.Write($raw);$child.StandardInput.Close()
 if(!$accept.AsyncWaitHandle.WaitOne(1500)){throw 'normal_hook_not_delivered'}
 $connection=$listener.EndAcceptTcpClient($accept);try{$body=[OwnerFixtureHttp]::Receive($connection)}finally{$connection.Close()}
 if(!$child.WaitForExit(1000) -or $child.ExitCode -ne 0 -or $child.StandardOutput.ReadToEnd() -or $child.StandardError.ReadToEnd() -or $clock.ElapsedMilliseconds -ge 1200){throw 'exit_contract_failed'}
 $packet=$json.DeserializeObject($body);$present=$packet.ContainsKey('project') -and $packet.project.observation -ne $null
 Write-Output ('normal_hook_delivered=true project_present='+[string]$present)
 if($ExpectProject -and !$present){throw 'administrator_owned_marker_loses_project'}
 if(!$ExpectProject -and $present){throw 'negative_control_not_reproduced'}
 if($ExpectProject){$a=Get-Acl -LiteralPath $c.owned;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $id.User.Value){throw 'owner_not_repaired'};if(@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $id.User.Value}).Count){throw 'private_acl_weakened'}}
}finally{if(!$child.HasExited){$child.Kill()};$child.Dispose();$listener.Stop()}
