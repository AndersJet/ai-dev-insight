param([Parameter(Mandatory=$true)][string]$Root,[switch]$WorkerOnly,[string]$GitDirectory,[switch]$Rewrite,[switch]$ImplicitPush)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if($identity.IsSystem -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ordinary_user_required'}
if([IO.Path]::GetFileName($Root) -notmatch '^adi-native-validation-[a-f0-9-]{36}$'){throw 'isolated_test_root_required'}
$base=Join-Path $Root 'profile with spaces\adi-native-collector'
$manifest=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $base 'manifest.json')))
$release=Join-Path $base $manifest.release
$listener=$null;$sender=$null
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
public static class AdiSmokeHttp {
  public static string Receive(TcpClient connection) {
    using(var stream=connection.GetStream()) {
      stream.ReadTimeout=2000;
      var header=new MemoryStream();int next;
      while(true) {
        next=stream.ReadByte();if(next<0||header.Length>=16384)throw new Exception("invalid_http_header");
        header.WriteByte((byte)next);
        var text=Encoding.ASCII.GetString(header.ToArray());
        if(!text.EndsWith("\r\n\r\n"))continue;
        var match=System.Text.RegularExpressions.Regex.Match(text,@"(?im)^Content-Length: ([0-9]+)\r?$");
        if(!match.Success)throw new Exception("missing_http_length");
        int length=int.Parse(match.Groups[1].Value);if(length>2097152)throw new Exception("http_body_limit");
        if(text.IndexOf("Expect: 100-continue",StringComparison.OrdinalIgnoreCase)>=0) {
          var interim=Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");stream.Write(interim,0,interim.Length);
        }
        var bytes=new byte[length];int offset=0;
        while(offset<length){int count=stream.Read(bytes,offset,length-offset);if(count==0)throw new Exception("truncated_body");offset+=count;}
        var response=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        stream.Write(response,0,response.Length);return Encoding.UTF8.GetString(bytes);
      }
    }
  }
}
'@
try {
  # A loopback socket needs no administrator URL reservation.
  $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
  $listener.Start();$port=$listener.LocalEndpoint.Port
  $config=Join-Path $release 'config.json'
  $settings=ConvertFrom-Json ([IO.File]::ReadAllText($config))
  $settings.endpoint='http://127.0.0.1:'+$port+'/hooks'
  [IO.File]::WriteAllText($config,(ConvertTo-Json -Compress $settings),(New-Object Text.UTF8Encoding($false)))
  $project=Join-Path $Root 'synthetic-project';[void][IO.Directory]::CreateDirectory($project)
  if($GitDirectory){
    if(!$GitDirectory.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'isolated_git_required'}
    $env:PATH=$GitDirectory+';'+$env:PATH;$git=Join-Path $GitDirectory 'git.exe'
    & $git init --quiet $project;if($LASTEXITCODE){throw 'git_init_failed'}
    & $git -C $project config --replace-all remote.Origin.url 'https://user:synthetic-secret@HOST.example.invalid/Team/App.git?token=synthetic-secret'
    & $git -C $project config --add remote.Origin.url 'git@10.1.2.3:team/app.git'
    & $git -C $project config --replace-all remote.Origin.pushurl 'ssh://push.example.invalid:2222/team/app.git'
    if($Rewrite){
      & $git -C $project config --replace-all remote.Origin.url 'dept-alias:app.git'
      & $git -C $project config --add remote.Origin.url 'git@10.1.2.3:team/app.git'
      & $git -C $project config 'url.https://dept.example.invalid/team/.insteadOf' 'dept-alias:'
      & $git -C $project config 'url.ssh://push.example.invalid/team/.pushInsteadOf' 'dept-alias:'
      & $git -C $project config --replace-all remote.Origin.pushurl 'dept-alias:push.git'
      if($ImplicitPush){& $git -C $project config --unset-all remote.Origin.pushurl}
      # An independent Git oracle runs before measuring the sender. These
      # values are not copied into the product or substituted for observation.
      $fetch=@(& $git -C $project remote get-url --all Origin)
      $push=@(& $git -C $project remote get-url --push --all Origin)
      if(($fetch -join '|') -cne 'https://dept.example.invalid/team/app.git|git@10.1.2.3:team/app.git'){throw 'git_oracle_fetch_changed'}
      $expectedPush='https://dept.example.invalid/team/push.git';if($ImplicitPush){$expectedPush='ssh://push.example.invalid/team/app.git'}
      if(($push -join '|') -cne $expectedPush){throw 'git_oracle_push_changed'}
    }
  }
  $raw='{"hook_event_name":"UserPromptSubmit","session_id":"windows-smoke","cwd":'+(ConvertTo-Json -Compress $project)+',"n":9007199254740993,"A":1,"a":2,"text":"'+[char]0x4e2d+[char]0x6587+'"}'
  $request=$listener.BeginAcceptTcpClient($null,$null)
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=Join-Path $release 'adi-sender.exe'
  $info.Arguments='"'+$config+'"';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  if($WorkerOnly){
    # Diagnostic boundary only: this does not accept the sender's 750ms gate.
    $program="& '"+(Join-Path $release 'send-worker.ps1').Replace("'","''")+"' -Config '"+$config.Replace("'","''")+"'"
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
  }
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $sender=New-Object Diagnostics.Process;$sender.StartInfo=$info
  $clock=[Diagnostics.Stopwatch]::StartNew();$null=$sender.Start()
  $bytes=[Text.Encoding]::UTF8.GetBytes($raw)
  $sender.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$sender.StandardInput.Close()
  if(!$request.AsyncWaitHandle.WaitOne(5000)){throw 'native_sender_no_http'}
  $connection=$listener.EndAcceptTcpClient($request)
  try {
    $body=[AdiSmokeHttp]::Receive($connection)
  } finally {$connection.Close()}
  if(!$sender.WaitForExit(1500)){throw 'native_sender_did_not_exit'}
  $out=$sender.StandardOutput.ReadToEnd();$err=$sender.StandardError.ReadToEnd()
  if($sender.ExitCode -ne 0 -or (!$WorkerOnly -and ($out -or $err))){throw 'sender_not_silent'}
  if(!$WorkerOnly -and $clock.ElapsedMilliseconds -gt 1200){throw 'sender_wall_budget_exceeded'}
  Add-Type -AssemblyName System.Web.Extensions
  $json=New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $packet=$json.DeserializeObject($body)
  if(!$body.EndsWith('"payload":'+$raw+'}')){throw 'raw_payload_changed'}
  if($packet.payload.session_id -cne 'windows-smoke'){throw 'wrong_hook_payload'}
  if(!$packet.project -or $packet.project.platform -cne 'windows'){throw ('missing_project_evidence_sender_ms_'+$clock.ElapsedMilliseconds)}
  if($GitDirectory){
    if($packet.project.observation.state -cne 'repository'){throw ('git_observation_failed_'+$packet.project.observation.reason)}
    $expected=@('Origin:fetch:https://host.example.invalid/Team/App.git','Origin:fetch:10.1.2.3:team/app.git','Origin:push:ssh://push.example.invalid:2222/team/app.git')
    if($Rewrite){$expected=@('Origin:fetch:https://dept.example.invalid/team/app.git','Origin:fetch:10.1.2.3:team/app.git',('Origin:push:'+$expectedPush))}
    $actual=@($packet.project.observation.remotes | ForEach-Object {$_.name+':'+$_.direction+':'+$_.address})
    if(($actual -join '|') -cne ($expected -join '|')){throw 'wrong_git_remotes'}
    if((ConvertTo-Json -Depth 10 $packet.project).Contains('synthetic-secret')){throw 'unsafe_git_address'}
  }elseif($packet.project.observation.state -cne 'failed' -or $packet.project.observation.reason -cne 'git_missing'){throw 'missing_git_evidence'}
  Write-Output (ConvertTo-Json -Compress @{result='passed';worker_only=[bool]$WorkerOnly;stdout_chars=$out.Length;stderr_chars=$err.Length;identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;is_system=[Security.Principal.WindowsIdentity]::GetCurrent().IsSystem;sender_wall_ms=$clock.ElapsedMilliseconds;project_state=$packet.project.observation.state;reason=$packet.project.observation.reason})
} finally {
  if($sender){try{if(!$sender.HasExited){$sender.Kill()}}catch{};$sender.Dispose()}
  if($listener){$listener.Stop()}
}
