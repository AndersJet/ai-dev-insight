# Public native state boundary: filesystem, clock, locking and Git are supplied
# by the platform adapter. No event text, remote access or background queue here.
function ConvertTo-AdiProjectJson($Value) { ConvertTo-Json -InputObject $Value -Depth 16 -Compress }
function ConvertFrom-AdiJsonElement($Element) {
  switch ($Element.ValueKind.ToString()) {
    'Object' { $value=[ordered]@{};foreach($property in $Element.EnumerateObject()){$value[$property.Name]=ConvertFrom-AdiJsonElement $property.Value};return $value }
    'Array' { $values=New-Object Collections.Generic.List[object];foreach($entry in $Element.EnumerateArray()){$values.Add((ConvertFrom-AdiJsonElement $entry))};return ,($values.ToArray()) }
    'String' { return $Element.GetString() }
    'Number' { $integer=[long]0;if($Element.TryGetInt64([ref]$integer)){return $integer};return $Element.GetDouble() }
    'True' { return $true }
    'False' { return $false }
    default { return $null }
  }
}
function ConvertFrom-AdiProjectJson([string]$Raw) {
  if($PSVersionTable.PSEdition -eq 'Desktop') {
    Add-Type -AssemblyName System.Web.Extensions
    $parser=New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $parser.MaxJsonLength=524288;$parser.RecursionLimit=16
    return $parser.DeserializeObject($Raw)
  }
  $document=[System.Text.Json.JsonDocument]::Parse($Raw)
  try { return ConvertFrom-AdiJsonElement $document.RootElement } finally { $document.Dispose() }
}
function Test-AdiProjectKeys($Value,[string[]]$Keys) {
  if($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $Keys.Count){return $false}
  foreach($key in $Keys){if($Value.Keys -cnotcontains $key){return $false}};return $true
}
function Get-AdiProjectPath($Value,[string]$Platform) {
  if($Value -isnot [string] -or !$Value -or $Value.Length -gt 4096 -or $Value -match '[\x00-\x1f\x7f]'){return $null}
  if($Platform -eq 'macos'){if(!$Value.StartsWith('/')){return $null};$path=$Value.TrimEnd('/');if(!$path){return '/'};return $path}
  $path=$Value.Replace('\','/')
  if($path -notmatch '^[a-z]:/' -and $path -notmatch '^//[^/]+/[^/]+'){return $null}
  if($path -match '^[a-z]:'){$path=$path.Substring(0,1).ToUpperInvariant()+$path.Substring(1)}
  return $path.TrimEnd('/')
}
function Get-AdiRepositoryHost([string]$Value) {
  $hostName=$Value.ToLowerInvariant()
  if(!$hostName -or $hostName.Length -gt 253 -or $hostName -match '[\s\\/@?#%]'){return $null}
  if($hostName.StartsWith('[')){
    if($hostName -notmatch '^\[[0-9a-f:.]+\]$'){return $null}
    $ip=$null
    if(![Net.IPAddress]::TryParse($hostName.Substring(1,$hostName.Length-2),[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetworkV6){return $null}
    $bytes=$ip.GetAddressBytes();$words=@();$bestStart=-1;$bestLength=0;$runStart=-1
    for($i=0;$i -lt 8;$i++){
      $word=([int]$bytes[2*$i]*256)+$bytes[2*$i+1];$words+=@($word.ToString('x'))
      if($word -eq 0){if($runStart -lt 0){$runStart=$i};$length=$i-$runStart+1;if($length -gt $bestLength){$bestStart=$runStart;$bestLength=$length}}
      else{$runStart=-1}
    }
    if($bestLength -lt 2){return '['+($words -join ':')+']'}
    $before=@();$after=@()
    for($i=0;$i -lt $bestStart;$i++){$before+=@($words[$i])}
    for($i=$bestStart+$bestLength;$i -lt 8;$i++){$after+=@($words[$i])}
    return '['+($before -join ':')+'::'+($after -join ':')+']'
  }
  if($hostName -match '^[0-9.]+$'){
    $parts=$hostName.Split('.');if($parts.Length -ne 4){return $null}
    foreach($part in $parts){if($part -notmatch '^(0|[1-9][0-9]{0,2})$' -or [int]$part -gt 255){return $null}}
    return $hostName
  }
  foreach($label in $hostName.Split('.')){if($label.Length -gt 63 -or $label -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'){return $null}}
  return $hostName
}
function Get-AdiRepositoryAddress($Value,[string]$Platform) {
  if($Value -isnot [string] -or !$Value -or $Value.Length -gt 4096 -or $Value -match '[\s\\\x00-\x1f\x7f]'){return $null}
  if(!$Value.Contains('://')){
    if(($Platform -eq 'windows' -and $Value -match '^[a-z]:') -or $Value -match '^[a-z]:/'){return $null}
    $parsed=[regex]::Match($Value,'^(?:[^:@/]+@)?(\[[^\]]+\]|[^:/@]+):([^?#]+)(?:[?#].*)?$')
    if(!$parsed.Success){return $null}
    $path=$parsed.Groups[2].Value
    if($path.StartsWith(':') -or $path -match '[<>"'']|%(?:0[0-9a-f]|1[0-9a-f]|7f)'){return $null}
    $hostName=Get-AdiRepositoryHost $parsed.Groups[1].Value
    if(!$hostName){return $null};return $hostName+':'+$path
  }
  $parsed=[regex]::Match($Value,'^([a-z][a-z0-9+.-]*)://([^/?#]+)(/[^?#]*)(?:[?#].*)?$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if(!$parsed.Success -or @('https','http','ssh','git') -cnotcontains $parsed.Groups[1].Value.ToLowerInvariant()){return $null}
  $authority=$parsed.Groups[2].Value;$authority=$authority.Substring($authority.LastIndexOf('@')+1)
  $parts=[regex]::Match($authority,'^(\[[^\]]+\]|[^:]+)(?::([0-9]{1,5}))?$')
  $path=$parsed.Groups[3].Value
  if(!$parts.Success -or $path -eq '/' -or $path -match '[<>"'']|%(?:0[0-9a-f]|1[0-9a-f]|7f)'){return $null}
  $hostName=Get-AdiRepositoryHost $parts.Groups[1].Value;if(!$hostName){return $null}
  $port='';if($parts.Groups[2].Success){$number=[int]$parts.Groups[2].Value;if($number -lt 1 -or $number -gt 65535){return $null};$port=':'+$parts.Groups[2].Value}
  return $parsed.Groups[1].Value.ToLowerInvariant()+'://'+$hostName+$port+$path
}
function Get-AdiRepositoryAddresses([object[]]$Remotes,[string]$Platform) {
  $addresses=New-Object Collections.Generic.List[object]
  $seen=New-Object Collections.Generic.List[object]
  foreach($remote in $Remotes){
    $address=Get-AdiRepositoryAddress $remote.address $Platform
    if(!$seen.Contains($address)){$seen.Add($address);$addresses.Add([ordered]@{address=$address})}
  }
  return $addresses.ToArray()
}
function Get-AdiProjectCacheHash($Io,$Cache) {
  $observation=$null
  if($Cache.observation){
    $remotes=New-Object Collections.Generic.List[object]
    # Legacy cached identities replay their original fields. New observations
    # hash address-only records without resetting instance or sequence.
    foreach($remote in $Cache.observation.remotes){
      if($remote.Keys -ccontains 'name'){$remotes.Add(@($remote.name,$remote.direction,$remote.address))}
      else{$remotes.Add(@($remote.address))}
    }
    $o=$Cache.observation;$observation=@($o.id,$o.sequence,$o.observed_at,$o.state,$o.reason,$o.git_root,$remotes.ToArray())
  }
  return & $Io.hash (ConvertTo-AdiProjectJson @($Cache.collector_id,$Cache.account,$Cache.workspace,$Cache.attempt_at,$Cache.attempt_tick,$Cache.reservation,$Cache.sequence,$observation))
}
function Get-AdiProjectContext($Io,$Settings,$Payload) {
  $state=$null;$lock=$null;$context=$null;$key=$null;$fresh=$false
  $uuid='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  function Read-ProjectState([string]$Path,[int]$Limit) {
    try{$raw=& $Io.read $Path $Limit}catch{if($_.Exception.Message -eq 'oversized_file'){return $null};throw}
    if($null -eq $raw){return $null};try{return ConvertFrom-AdiProjectJson $raw}catch{return $null}
  }
  function Valid-State($Value) {
    return (Test-AdiProjectKeys $Value @('version','collector_id','sequence','checksum')) -and $Value.version -eq 1 -and $Value.collector_id -match $uuid -and $Value.sequence -is [string] -and $Value.sequence -match '^(0|[1-9][0-9]{0,18})$' -and ($Value.sequence.Length -lt 19 -or [string]::CompareOrdinal($Value.sequence,'9223372036854775807') -le 0) -and $Value.checksum -ceq (& $Io.hash (ConvertTo-AdiProjectJson @($Value.collector_id,$Value.sequence)))
  }
  function Save-State {
    $state.checksum=& $Io.hash (ConvertTo-AdiProjectJson @($state.collector_id,$state.sequence))
    $null=& $Io.atomic ($Io.Root+'/identity.json') (ConvertTo-AdiProjectJson $state)
  }
  function Save-Cache($Entry) {
    $Entry.checksum=Get-AdiProjectCacheHash $Io $Entry
    $null=& $Io.atomic $key (ConvertTo-AdiProjectJson $Entry)
  }
  function Read-Cache {
    $raw=$null;try{$raw=& $Io.read $key 524288}catch{return @{invalid=$true}}
    if($null -eq $raw){return $null}
    try{$entry=ConvertFrom-AdiProjectJson $raw}catch{return @{invalid=$true}}
    if($entry.collector_id -match $uuid -and $entry.collector_id -cne $state.collector_id){return $null}
    if(!(Test-AdiProjectKeys $entry @('version','collector_id','account','workspace','attempt_at','attempt_tick','reservation','sequence','observation','checksum')) -or $entry.version -ne 1 -or $entry.collector_id -cne $state.collector_id -or $entry.account -cne $account -or $entry.workspace -cne $normalized){return @{invalid=$true}}
    if($entry.observation){
      if(!(Test-AdiProjectKeys $entry.observation @('id','sequence','observed_at','state','reason','git_root','remotes'))){return @{invalid=$true}}
      foreach($remote in $entry.observation.remotes){if(!(Test-AdiProjectKeys $remote @('address')) -and !(Test-AdiProjectKeys $remote @('name','direction','address'))){return @{invalid=$true}}}
    }
    if($entry.checksum -cne (Get-AdiProjectCacheHash $Io $entry)){return @{invalid=$true}}
    return $entry
  }
  function Output-Context($Observation) {
    return [ordered]@{collector_id=$state.collector_id;platform=$Io.Platform;workspace=$workspace;unresolved_reason=$reason;observation=$Observation}
  }
  try {
    $null=& $Io.directory $Io.Root;$null=& $Io.directory ($Io.Root+'/cache')
    $workspace=$Payload.cwd;$reason=$null;$roots=$Payload.workspace_roots
    if($roots -is [array] -and $roots.Count -gt 1){$workspace=$null;$reason='ambiguous_workspace'}
    elseif(!(Get-AdiProjectPath $workspace $Io.Platform)){
      $workspace=$null;if($roots -is [array] -and $roots.Count -eq 1){$workspace=$roots[0]}
      if(!(Get-AdiProjectPath $workspace $Io.Platform)){$reason='missing_workspace';if($Payload.cwd -or $workspace){$reason='invalid_workspace'};$workspace=$null}
    }
    $normalized=Get-AdiProjectPath $workspace $Io.Platform
    $account=& $Io.hash (ConvertTo-AdiProjectJson @($Settings.installation_id,$Settings.token,$Settings.endpoint,$Settings.runtime_generation))
    $key=$Io.Root+'/cache/'+(& $Io.hash (ConvertTo-AdiProjectJson @($account,$Io.Platform,$normalized)))+'.json'
    try{$lock=& $Io.lock}catch{
      $state=Read-ProjectState ($Io.Root+'/identity.json') 16384;if(!(Valid-State $state)){return $null}
      $entry=Read-Cache;if($entry -and !$entry.invalid){return Output-Context $entry.observation};return Output-Context $null
    }
    try {
      $state=Read-ProjectState ($Io.Root+'/identity.json') 16384
      if(!(Valid-State $state)){$state=[ordered]@{version=1;collector_id=(& $Io.uuid);sequence='0';checksum=''};Save-State;$fresh=$true}
      if($null -eq $workspace){return Output-Context $null}
      $entry=$null;if(!$fresh){$entry=Read-Cache}
      $tick=[long](& $Io.tick);$now=[long](& $Io.now)
      if($entry -and $entry.invalid){
        Save-Cache ([ordered]@{version=1;collector_id=$state.collector_id;account=$account;workspace=$normalized;attempt_at=$now;attempt_tick=$tick;reservation=(& $Io.uuid);sequence=$state.sequence;observation=$null;checksum=''})
        return Output-Context $null
      }
      if($entry){
        $elapsed=$now-[long]$entry.attempt_at;if($tick -ge [long]$entry.attempt_tick){$elapsed=$tick-[long]$entry.attempt_tick}
        if($elapsed -lt 0){$entry.attempt_at=$now;$entry.attempt_tick=$tick;Save-Cache $entry;return Output-Context $entry.observation}
        if($elapsed -lt 300000){return Output-Context $entry.observation}
      }
      if($state.sequence -ceq '9223372036854775807'){$state=[ordered]@{version=1;collector_id=(& $Io.uuid);sequence='0';checksum=''};$entry=$null}
      $state.sequence=([long]$state.sequence+1L).ToString([Globalization.CultureInfo]::InvariantCulture);Save-State
      $previous=$null;if($entry){$previous=$entry.observation}
      $reserved=[ordered]@{version=1;collector_id=$state.collector_id;account=$account;workspace=$normalized;attempt_at=$now;attempt_tick=$tick;reservation=(& $Io.uuid);sequence=$state.sequence;observation=$previous;checksum=''}
      Save-Cache $reserved;$context=Output-Context $null
    } finally {if($null -ne $lock){$null=& $Io.unlock $lock;$lock=$null}}
    $observed=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc).AddMilliseconds($reserved.attempt_at).ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)
    $observation=[ordered]@{id=$reserved.reservation;sequence=$reserved.sequence;observed_at=$observed;state='failed';reason='git_error';git_root=$null;remotes=@()}
    try{$found=& $Io.probe $workspace;$observation.state=$found.state;$observation.reason=$found.reason;$observation.git_root=$found.git_root;$observation.remotes=@($found.remotes)}catch{}
    $context.observation=$observation
    try{$lock=& $Io.lock;$entry=Read-Cache;if($entry -and $entry.reservation -ceq $reserved.reservation){$entry.observation=$observation;Save-Cache $entry}}finally{if($null -ne $lock){$null=& $Io.unlock $lock;$lock=$null}}
    return $context
  } catch {return $context} finally {if($null -ne $lock){$null=& $Io.unlock $lock}}
}
