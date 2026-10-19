param([string]$Config)
$ErrorActionPreference='Stop'
try {
  $observed=[DateTime]::UtcNow.ToString('o')
  $utf8=New-Object Text.UTF8Encoding($false,$true)
  $item=Get-Item -LiteralPath $Config -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16384) { exit 0 }
  $settings=ConvertFrom-Json ([IO.File]::ReadAllText($item.FullName,$utf8))
  if ($settings.installation_id -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $settings.token -cnotmatch '^adi_[A-Za-z0-9_-]{43}$') { exit 0 }
  . (Join-Path $PSScriptRoot 'native-windows.ps1')
  $generation=Get-AdiRuntimeGeneration $settings;if(!$generation){exit 0}
  $settings | Add-Member -NotePropertyName runtime_generation -NotePropertyValue $generation -Force
  $url=New-Object Uri($settings.endpoint,[UriKind]::Absolute)
  if (@('http','https') -notcontains $url.Scheme -or !$url.Host -or $url.AbsolutePath -cne '/hooks' -or $url.UserInfo -or $url.Query -or $url.Fragment) { exit 0 }
  $inputStream=[Console]::OpenStandardInput();$memory=New-Object IO.MemoryStream;$buffer=New-Object byte[] 65536
  while (($n=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { if ($memory.Length+$n -gt 2095104) { exit 0 };$memory.Write($buffer,0,$n) }
  $raw=$utf8.GetString($memory.ToArray())
  # Windows PowerShell 5.1's PSCustomObject converter rejects case-distinct JSON keys.
  # Use the built-in framework dictionary parser; preserve the raw payload below.
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Add-Type -AssemblyName System.Web.Extensions
    $json=New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength=2095104;$json.RecursionLimit=32;$payload=$json.DeserializeObject($raw)
  } else { $payload=ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 32 }
  if ($payload -isnot [Collections.IDictionary] -or $payload['session_id'] -isnot [string] -or !$payload['session_id'].Trim() -or $payload['session_id'].Length -gt 256 -or @('SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification') -cnotcontains $payload['hook_event_name']) { exit 0 }
  $header=@{schema_version=2;installation_id=$settings.installation_id;client_event_id=[guid]::NewGuid().ToString();occurred_at=$observed;timestamp_source='client_observed';event_type=$payload['hook_event_name'];source_session_id=$payload['session_id']}
  $project=$null
  if($memory.Length -lt 1700000){
    try{
      . (Join-Path $PSScriptRoot 'native-windows.ps1')
      $project=Get-AdiWindowsProject $Config $settings $payload
    }catch{ }
  }
  if($project){
    # Optional metadata must not exceed the collector's total node bound.
    $pending=New-Object Collections.Generic.Stack[object];$pending.Push($payload);$nodes=0
    while($pending.Count -and $nodes -le 20000){
      $value=$pending.Pop();$nodes++
      if($value -is [Collections.IDictionary]){foreach($key in $value.Keys){$pending.Push($value[$key])}}
      elseif($value -is [array]){foreach($entry in $value){$pending.Push($entry)}}
    }
    $extra=New-Object Collections.Generic.Stack[object];$extra.Push($project)
    while($extra.Count -and $nodes -le 20000){
      $value=$extra.Pop();$nodes++
      if($value -is [Collections.IDictionary]){foreach($key in $value.Keys){$extra.Push($value[$key])}}
      elseif($value -is [array]){foreach($entry in $value){$extra.Push($entry)}}
    }
    if($nodes+20 -le 20000){$header.project=$project}else{$project=$null}
  }
  $meta=ConvertTo-Json -Depth 16 -Compress -InputObject $header
  $body=$utf8.GetBytes($meta.Substring(0,$meta.Length-1)+',"payload":'+$raw+'}')
  if($project -and $body.Length -gt 2097152){
    $header.Remove('project');$project=$null;$meta=ConvertTo-Json -Depth 16 -Compress -InputObject $header
    $body=$utf8.GetBytes($meta.Substring(0,$meta.Length-1)+',"payload":'+$raw+'}')
  }
  [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if((Get-AdiRuntimeGeneration $settings) -cne $generation){exit 0}
  $request=[Net.HttpWebRequest]::Create($url);$request.Method='POST';$request.AllowAutoRedirect=$false
  $timeout=650;if($project){$timeout=350}
  $request.Timeout=$timeout;$request.ReadWriteTimeout=$timeout;$request.ContentType='application/json';$request.ContentLength=$body.Length
  $request.Headers['Authorization']='Bearer '+$settings.token
  $stream=$request.GetRequestStream();$stream.Write($body,0,$body.Length);$stream.Dispose()
  $response=$request.GetResponse();$response.Dispose()
} catch { }
exit 0
