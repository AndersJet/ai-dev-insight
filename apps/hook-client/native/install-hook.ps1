param(
  [ValidateSet('plan','install','status','uninstall')][string]$Action = 'plan',
  [Alias('trae-dir')][string]$TraeDir = (Join-Path $env:USERPROFILE '.trae-cn'),
  [string]$Credentials,
  [string]$Endpoint,
  [Alias('replace-legacy')][switch]$ReplaceLegacy
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$events = @('SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Notification')
$files = @('send-hook.ps1','send-worker.ps1','native-windows.ps1')
$ownedFiles = @($files + @('adi-sender.exe','config.json'))
$TraeDir = [IO.Path]::GetFullPath($TraeDir)
$base = Join-Path $TraeDir 'adi-native-collector'
$hooksPath = Join-Path $TraeDir 'hooks.json'
function Fail([string]$Code) { throw $Code }
function SafePath([string]$Path, [bool]$Directory) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $Directory) { Fail 'unsafe_installation_path' }
}
function ReadText([string]$Path, [int]$Max = 1048576) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  SafePath $Path $false
  $file = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  try {
    if ($file.Length -gt $Max) { Fail 'oversized_file' }
    $bytes = New-Object byte[] ($Max + 1); $offset = 0
    while ($offset -lt $bytes.Length) { $n = $file.Read($bytes,$offset,$bytes.Length-$offset); if ($n -eq 0) { break }; $offset += $n }
    if ($offset -gt $Max) { Fail 'oversized_file' }
    return $utf8.GetString($bytes,0,$offset)
  } finally { $file.Dispose() }
}
function PrivateDirectory([string]$Path) {
  SafePath $Path $true
  [void][IO.Directory]::CreateDirectory($Path)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  # The PowerShell provider persists all ACL sections, including audit rules,
  # and asks ordinary users for SeSecurityPrivilege. Persist only changed
  # owner/access sections through the framework API.
  $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($Path,$acl)
}
function OwnPrivateFile([string]$Path) {
  SafePath $Path $false
  $acl=[IO.File]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Owner)
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  [IO.File]::SetAccessControl($Path,$acl)
}
function WriteText([string]$Path, [string]$Value, [bool]$Replace = $false) {
  SafePath $Path $false
  $temp = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.adi-write-' + [guid]::NewGuid().ToString())
  $stream = [IO.File]::Open($temp,'CreateNew','Write','None')
  try { OwnPrivateFile $temp; $bytes=$utf8.GetBytes($Value); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  try {
    if ($Replace -and [IO.File]::Exists($Path)) { [IO.File]::Replace($temp,$Path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp,$Path) }
    OwnPrivateFile $Path
  } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Json($Value) { return ConvertTo-Json -InputObject $Value -Depth 100 -Compress }
function Hooks($Raw) {
  if ($null -eq $Raw -or [string]::IsNullOrWhiteSpace($Raw)) { return [pscustomobject]@{version=1; hooks=[pscustomobject]@{}} }
  $value = ConvertFrom-Json -InputObject $Raw
  if ($value -isnot [pscustomobject] -or ($value.PSObject.Properties['version'] -and ($value.version -isnot [ValueType] -or $value.version -is [bool] -or $value.version -ne 1))) { Fail 'unsupported_hooks_configuration' }
  if (!$value.PSObject.Properties['hooks']) { $value | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
  if ($value.hooks -isnot [pscustomobject]) { Fail 'unsupported_hooks_configuration' }
  foreach ($property in $value.hooks.PSObject.Properties) { if ($property.Value -isnot [array]) { Fail 'unsupported_hooks_configuration' } }
  return $value
}
function Manifest($Raw) {
  if ($null -eq $Raw) { return $null }
  $value=ConvertFrom-Json -InputObject $Raw
  if (@(2,3) -notcontains $value.version -or $value.release -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or @($value.entries).Count -ne 6) { Fail 'invalid_installation_manifest' }
  if ($value.version -eq 3 -and (Json @($value.owned_files)) -cne (Json $ownedFiles)) { Fail 'invalid_installation_manifest' }
  foreach ($entry in $value.entries) { if ($events -notcontains $entry.event -or !$entry.group) { Fail 'invalid_installation_manifest' } }
  return $value
}
function Quote([string]$Value) { return "'" + $Value.Replace("'","''") + "'" }
function Entries([string]$Release) {
  $command = 'try { & ' + (Quote (Join-Path $Release 'adi-sender.exe')) + ' ' + (Quote (Join-Path $Release 'config.json')) + ' *> $null } catch {} ; exit 0'
  foreach ($event in $events) {
    $group=[ordered]@{hooks=@(@{type='command';command=$command;timeout=2})}
    if (@('PreToolUse','PostToolUse','Notification') -contains $event) { $group.matcher='*' }
    if ($event -eq 'Stop') { $group.loop_limit=1000 }
    [pscustomobject]@{event=$event;group=[pscustomobject]$group}
  }
}
function Merge($Original,$Old,$Next) {
  foreach ($entry in @($Old.entries)) {
    if ($null -eq $entry) { continue }
    $groups=@($Original.hooks.($entry.event));$owned=Json $entry.group
    if (@($groups | Where-Object { (Json $_) -ceq $owned }).Count -ne 1) { Fail 'managed_hooks_modified' }
    $remaining=@($groups | Where-Object { (Json $_) -cne $owned })
    if ($remaining.Count) { $Original.hooks.($entry.event)=$remaining } else { $Original.hooks.PSObject.Properties.Remove($entry.event) }
  }
  foreach ($entry in @($Next)) {
    $groups=@(); if ($Original.hooks.PSObject.Properties[$entry.event]) { $groups=@($Original.hooks.($entry.event)) }
    $Original.hooks | Add-Member -NotePropertyName $entry.event -NotePropertyValue @($groups + @($entry.group)) -Force
  }
  return $Original
}
function Legacy($Original) {
  $referenceCounts=@{}
  $known = 'powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + (Join-Path $TraeDir 'trae-hook-send.ps1') + '"'
  $nodeRaw=ReadText (Join-Path $TraeDir 'adi-collector\manifest.json')
  $node=$null
  if ($nodeRaw) {
    $node=ConvertFrom-Json $nodeRaw
    if ($node.version -ne 1 -or @($node.entries).Count -gt 6 -or (ReadText (Join-Path $TraeDir 'adi-collector\.owned') 128) -cne 'adi-hook-client-v1') { Fail 'legacy_hook_requires_migration' }
  }
  foreach ($property in @($Original.hooks.PSObject.Properties)) {
    $kept=@()
    foreach ($group in $property.Value) {
      $isNode=@($node.entries | Where-Object { $_.event -ceq $property.Name -and (Json $_.group) -ceq (Json $group) }).Count -gt 0
      if ($isNode) { if (!$ReplaceLegacy) { Fail 'legacy_hook_requires_migration' }; continue }
      $definitions=@();$removed=$false
      foreach ($definition in @($group.hooks)) {
        if ($definition.command -match 'trae-hook-send\.(sh|ps1)|adi-collector.*sender\.js') {
          if (!$ReplaceLegacy -or $definition.command -cne $known) { Fail 'legacy_hook_requires_migration' }
          $referenceCounts[$property.Name] = 1 + $referenceCounts[$property.Name]
          $removed=$true
        } else { $definitions+=@($definition) }
      }
      if (!$removed) { $kept+=@($group) } elseif ($definitions.Count) { $group.hooks=$definitions;$kept+=@($group) }
    }
    if ($kept.Count) { $Original.hooks.($property.Name)=$kept } else { $Original.hooks.PSObject.Properties.Remove($property.Name) }
  }
  return [pscustomobject]@{value=$Original;referenceCounts=$referenceCounts}
}
function MergeInstallation($Prepared,$Old,$Next) {
  # A complete clear can be reinstalled; partial edits still require repair.
  $original=Hooks $raw;$cleared=$true
  foreach ($property in $original.hooks.PSObject.Properties) { if ($property.Value.Count -gt 0) { $cleared=$false } }
  # Recover only a complete known legacy overwrite, never partial native edits.
  $overwritten=$null -ne $Old
  foreach ($event in $events) { if ($Prepared.referenceCounts[$event] -ne 1) { $overwritten=$false } }
  if ((Json $Prepared.value) -match 'adi-native-collector') { $overwritten=$false }
  foreach ($entry in @($Old.entries)) {
    if ($null -eq $entry) { continue }
    if (@($Prepared.value.hooks.($entry.event) | Where-Object { (Json $_) -ceq (Json $entry.group) }).Count) { $overwritten=$false }
  }
  if ($cleared -or $overwritten) { return Merge $Prepared.value $null $Next }
  return Merge $Prepared.value $Old $Next
}
function RemoveFile([string]$Path) { SafePath $Path $false; if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) } }
function Clean([string]$Id, [string[]]$Owned = @('send-hook.ps1','send-worker.ps1','config.json')) {
  if ($Id -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { Fail 'invalid_installation_journal' }
  $path=Join-Path $base $Id;SafePath $path $true
  if ((Json $Owned) -cne (Json $ownedFiles) -and (Json $Owned) -cne (Json @('send-hook.ps1','send-worker.ps1','config.json'))) { Fail 'invalid_installation_journal' }
  foreach ($name in $Owned) { RemoveFile (Join-Path $path $name) }
  if ([IO.Directory]::Exists($path) -and [IO.Directory]::GetFileSystemEntries($path).Length -eq 0) { [IO.Directory]::Delete($path) }
}
function Recover {
  $path=Join-Path $base 'pending.json';$raw=ReadText $path 4194304;if ($null -eq $raw) { return }
  $j=ConvertFrom-Json $raw
  if ($j.after -isnot [string] -or ($null -ne $j.before -and $j.before -isnot [string]) -or ($null -ne $j.created -and $j.created -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')) { Fail 'invalid_installation_journal' }
  $next=$null;if ($null -ne $j.manifest) { $next=Manifest (Json $j.manifest) }
  $current=ReadText $hooksPath
  if ($current -ceq $j.after) {
    if ($next) { WriteText (Join-Path $base 'manifest.json') (Json $next) $true } else { RemoveFile (Join-Path $base 'manifest.json') }
    foreach ($release in $j.remove) {
      if ($release -is [string]) { Clean $release }
      else { Clean $release.release @($release.owned_files) }
    }
  } elseif ($current -ceq $j.before) {
    if ($j.created) { if ($next.version -eq 3) { Clean $j.created @($next.owned_files) } else { Clean $j.created } }
  } else { Fail 'installation_recovery_conflict' }
  RemoveFile $path
}
function WindowsModule {
  $module=ReadText (Join-Path $PSScriptRoot 'native-windows.ps1')
  if (!$module) { Fail 'missing_release_file' }
  if ($module.Contains('# ADI_PROJECT_MODULE_INSERT')) {
    $parts=@();foreach($name in @('project-core.ps1','project-io.ps1','project-git.ps1')){$parts+=@(ReadText (Join-Path $PSScriptRoot $name))}
    $module=$module.Replace('# ADI_PROJECT_MODULE_INSERT',($parts -join "`n"))
  }
  if ($module.Contains('# ADI_PROCESS_SOURCE_INSERT')) {
    $source=ReadText (Join-Path $PSScriptRoot 'windows-process.cs')
    if (!$source) { Fail 'missing_release_file' }
    $module=$module.Replace('# ADI_PROCESS_SOURCE_INSERT',('$script:AdiProcessSource=@'+ "'"+"`n"+$source+"`n"+ "'@"))
  }
  if($module.Contains('# ADI_CLIENT_SOURCE_INSERT')) {
    $source=ReadText (Join-Path $PSScriptRoot 'windows-client.cs')
    if(!$source){Fail 'missing_release_file'}
    $module=$module.Replace('# ADI_CLIENT_SOURCE_INSERT',('$script:AdiClientSource=@'+ "'"+"`n"+$source+"`n"+ "'@"))
  }
  return $module
}
try {
  if ($PSVersionTable.PSVersion -lt [version]'5.1') { Fail 'powershell_5_1_required' }
  if ($PSVersionTable.PSEdition -eq 'Desktop') { try { Add-Type -AssemblyName System.Web.Extensions } catch { Fail 'system_json_unavailable' } }
  $raw=ReadText $hooksPath;$original=Hooks $raw;$old=Manifest (ReadText (Join-Path $base 'manifest.json'))
  if ($Action -eq 'status') { Json @{installed=($null -ne $old);pending_recovery=([IO.File]::Exists((Join-Path $base 'pending.json')));profile=$TraeDir};exit 0 }
  $settings=$null
  if ($Action -ne 'uninstall') {
    if (!$Credentials) { Fail 'credentials_required' }
    $inputConfig=ConvertFrom-Json (ReadText ([IO.Path]::GetFullPath($Credentials)) 16384)
    if ($inputConfig.installation_id -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $inputConfig.token -cnotmatch '^adi_[A-Za-z0-9_-]{43}$') { Fail 'invalid_credentials_file' }
    if ($inputConfig.protocol_version -ne 2 -or $inputConfig.runtime_owner -cnotmatch '^[a-f0-9]{64}$') { Fail 'invalid_runtime_binding' }
    if (!$Endpoint) { $Endpoint=$inputConfig.endpoint }
    $url=New-Object Uri($Endpoint,[UriKind]::Absolute)
    if (@('http','https') -notcontains $url.Scheme -or !$url.Host -or $url.AbsolutePath -cne '/hooks' -or $url.UserInfo -or $url.Query -or $url.Fragment) { Fail 'invalid_collector_endpoint' }
    $settings=@{installation_id=$inputConfig.installation_id;token=$inputConfig.token;endpoint=$url.AbsoluteUri;protocol_version=2;runtime_owner=$inputConfig.runtime_owner}
  }
  if ($Action -eq 'plan') { $null=MergeInstallation (Legacy $original) $old @(Entries (Join-Path $base 'preview'));Json @{action='plan';profile=$TraeDir;runtime='windows-powershell';events=$events;command_deadline_ms=750;hook_timeout_seconds=2};exit 0 }
  if ($Action -eq 'uninstall' -and !$old -and ![IO.File]::Exists((Join-Path $base 'pending.json'))) { Json @{action='uninstall';changed=$false};exit 0 }
  SafePath $TraeDir $true;SafePath $base $true
  if ([IO.Directory]::Exists($base) -and $null -eq (ReadText (Join-Path $base '.owned') 128) -and [IO.Directory]::GetFileSystemEntries($base).Length -gt 0) { Fail 'unsafe_installation_path' }
  [void][IO.Directory]::CreateDirectory($TraeDir);PrivateDirectory $base
  $marker=ReadText (Join-Path $base '.owned') 128
  if ($null -eq $marker) { WriteText (Join-Path $base '.owned') 'adi-native-client-v2' } elseif ($marker -cne 'adi-native-client-v2') { Fail 'unsafe_installation_path' }
  OwnPrivateFile (Join-Path $base '.owned')
  $lockPath=Join-Path $base 'install.lock';SafePath $lockPath $false
  $lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
  try {
    Recover;$raw=ReadText $hooksPath;$original=Hooks $raw;$old=Manifest (ReadText (Join-Path $base 'manifest.json'))
    if ($Action -eq 'uninstall' -and !$old) { Json @{action=$Action;changed=$false};exit 0 }
    $id=[guid]::NewGuid().ToString();$next=$null;$entries=@()
    if ($Action -eq 'install') {
      $prepared=Legacy $original;$entries=@(Entries (Join-Path $base $id));$next=@{version=3;release=$id;entries=$entries;owned_files=$ownedFiles}
      $after=(Json (MergeInstallation $prepared $old $entries))+"`n"
    } else { $after=(Json (Merge $original $old $entries))+"`n" }
    if ($null -ne $raw) { WriteText (Join-Path $base ('hooks-backup-'+[guid]::NewGuid().ToString()+'.json')) $raw }
    $remove=@();if ($old) {
      $previousFiles=@('send-hook.ps1','send-worker.ps1','config.json');if($old.version -eq 3){$previousFiles=@($old.owned_files)}
      $remove=@(@{release=$old.release;owned_files=$previousFiles})
    };$created=$null;if ($next) { $created=$id;if(Test-Path -LiteralPath (Join-Path $base $id)){Fail 'unsafe_installation_path'} }
    WriteText (Join-Path $base 'pending.json') (Json @{before=$raw;after=$after;manifest=$next;created=$created;remove=$remove}) $true
    if ($next) {
      $target=Join-Path $base $id;PrivateDirectory $target
      foreach ($name in $files) {
        $content=ReadText (Join-Path $PSScriptRoot $name);if($name -eq 'native-windows.ps1'){$content=WindowsModule}
        if(!$content){Fail 'missing_release_file'}
        WriteText (Join-Path $target $name) $content
      }
      . (Join-Path $target 'native-windows.ps1')
      Install-AdiProcessLibrary (Join-Path $target 'adi-sender.exe')
      WriteText (Join-Path $target 'config.json') (Json $settings)
    }
    if ((ReadText $hooksPath) -cne $raw) { Fail 'hooks_changed_during_install' }
    WriteText $hooksPath $after $true;Recover
    Json @{action=$Action;changed=$true;restart_trae_required=$true;profile=$TraeDir}
  } finally { $lock.Dispose() }
} catch {
  $safe=$_.Exception.Message
  if ($safe -cnotmatch '^[a-z_]{3,64}$') { $safe='installation_failed' }
  [Console]::Error.WriteLine((Json @{error=$safe}));exit 1
}
