# Packaging inserts the state/Git modules and process source at these markers.
# A checkout can load the same source without a separate generated artifact.
function Get-AdiRuntimeGeneration($Settings) {
  try {
    if($Settings.protocol_version -isnot [ValueType] -or $Settings.protocol_version -is [bool] -or $Settings.protocol_version -ne 2 -or $Settings.runtime_owner -isnot [string] -or $Settings.runtime_owner -cnotmatch '^[a-f0-9]{64}$' -or !(Get-AdiProjectPath $env:USERPROFILE 'windows')){return $null}
    $path=Join-Path $env:USERPROFILE '.trae-cn/adi-plugin-control/control.json';$cursor=[IO.Path]::GetFullPath($path)
    while($cursor){$attributes=[IO.File]::GetAttributes($cursor);if($attributes -band [IO.FileAttributes]::ReparsePoint){return $null};$parent=[IO.Path]::GetDirectoryName($cursor);if($parent -ceq $cursor){break};$cursor=$parent}
    $file=Get-Item -LiteralPath $path -Force;if($file.PSIsContainer -or $file.Length -gt 32768){return $null}
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $path
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value){return $null}
    $control=ConvertFrom-Json ([IO.File]::ReadAllText($path,(New-Object Text.UTF8Encoding($false,$true))))
    if($control.version -isnot [ValueType] -or $control.version -is [bool] -or $control.version -ne 2 -or $control.clock_kind -cne 'windows-qpc-v1' -or $control.enabled -isnot [bool] -or !$control.enabled -or $control.owner -cne $Settings.runtime_owner -or $control.generation -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $control.leases -isnot [array] -or $control.leases.Count -gt 128){return $null}
    $now=([DateTime]::UtcNow-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds
    $mono=[Math]::Floor([Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency)
    foreach($lease in $control.leases){
      if($lease.id -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $lease.clock_scope -cnotmatch '^windows:([1-9][0-9]{0,9}):([1-9][0-9]{0,18})$'){continue}
      $scopeParts=$lease.clock_scope.Split(':');$valid=$true
      foreach($key in @('issued_at','expires_at','monotonic_issued_at','monotonic_expires_at')){$number=$lease.$key;if($number -isnot [ValueType] -or $number -is [bool] -or [double]::IsNaN($number) -or [double]::IsInfinity($number) -or [Math]::Abs($number) -gt 9007199254740991 -or [Math]::Truncate($number) -ne $number){$valid=$false;break}}
      if(!$valid -or $lease.issued_at -gt $now -or $lease.expires_at -le $now -or $lease.expires_at-$lease.issued_at -le 0 -or $lease.expires_at-$lease.issued_at -gt 30000 -or $lease.monotonic_issued_at -lt 0 -or $lease.monotonic_issued_at -gt $mono -or $lease.monotonic_expires_at -le $mono -or $lease.monotonic_expires_at-$lease.monotonic_issued_at -le 0 -or $lease.monotonic_expires_at-$lease.monotonic_issued_at -gt 30000){continue}
      try{$writer=[Diagnostics.Process]::GetProcessById([int]$scopeParts[1]);try{if(!$writer.HasExited -and $writer.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $scopeParts[2]){return $control.generation}}finally{$writer.Dispose()}}catch{ }
    }
  }catch{ }
  return $null
}
# ADI_PROJECT_MODULE_INSERT
if(!(Get-Command Get-AdiProjectContext -ErrorAction SilentlyContinue)){
  foreach($name in @('project-core.ps1','project-io.ps1','project-git.ps1')){. (Join-Path $PSScriptRoot $name)}
}
# ADI_PROCESS_SOURCE_INSERT
if(!$script:AdiProcessSource){$script:AdiProcessSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-process.cs'))}
# ADI_CLIENT_SOURCE_INSERT
if(!$script:AdiClientSource){$script:AdiClientSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-client.cs'))}
function Install-AdiProcessLibrary([string]$Path) {
  $temp=Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.process-'+[guid]::NewGuid().ToString()+'.exe')
  $provider=$null
  try{
    # Generate a file without loading it into the installer, so it remains
    # movable and removable on the Desktop CLR. Only the system compiler is used.
    $provider=New-Object Microsoft.CSharp.CSharpCodeProvider
    $options=New-Object CodeDom.Compiler.CompilerParameters
    $options.GenerateExecutable=$true;$options.GenerateInMemory=$false
    $options.OutputAssembly=$temp;$options.IncludeDebugInformation=$false
    $options.MainClass='Adi.Native.ProcessRunner';$options.CompilerOptions='/optimize'
    $null=$options.ReferencedAssemblies.Add('System.dll')
    $null=$options.ReferencedAssemblies.Add('System.Web.Extensions.dll')
    $options.TempFiles=New-Object CodeDom.Compiler.TempFileCollection([IO.Path]::GetDirectoryName($Path),$false)
    $compiled=$provider.CompileAssemblyFromSource($options,[string[]]@($script:AdiProcessSource,$script:AdiClientSource))
    if($compiled.Errors.HasErrors){throw 'native_process_compile_failed'}
    $stream=[IO.File]::Open($temp,'Open','ReadWrite','None');try{$stream.Flush($true)}finally{$stream.Dispose()}
    [IO.File]::Move($temp,$Path)
  }finally{if($provider){$provider.Dispose()};if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
function Import-AdiProcessLibrary {
  $path=Join-Path $PSScriptRoot 'adi-sender.exe'
  Assert-AdiStatePath $path $false 'windows'
  $null=[Reflection.Assembly]::LoadFrom($path)
  if([Adi.Native.ProcessRunner]::Protocol -ne 1){throw 'unsupported_process_protocol'}
}
function Find-AdiProjectGit {
  foreach($entry in $env:PATH.Split(';')){
    $entry=$entry.Trim('"')
    if(!(Get-AdiProjectPath $entry 'windows')){continue}
    $candidate=Join-Path $entry 'git.exe'
    if([IO.File]::Exists($candidate)){
      $item=Get-Item -LiteralPath $candidate -Force
      if(!$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){return $item.FullName}
    }
  }
  return $null
}
function Get-AdiWindowsProject([string]$Config,$Settings,$Payload) {
  $generation=Get-AdiRuntimeGeneration $Settings;if(!$generation -or $generation -cne $Settings.runtime_generation){return $null}
  $release=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Config));$base=[IO.Path]::GetDirectoryName($release)
  if([IO.Path]::GetFileName($release) -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){return $null}
  if((Read-AdiStateFile (Join-Path $base '.owned') 128 'windows') -cne 'adi-native-client-v2'){return $null}
  Import-AdiProcessLibrary
  # GetNewClosure creates a dynamic module whose parent is the process global
  # scope. The worker dot-sources this file in script scope, so publish only
  # these stateless helpers for the callbacks. This is a short-lived, isolated
  # PowerShell worker, not the IDE or an employee's interactive session.
  foreach($name in @('Assert-AdiStatePath','New-AdiStateDirectory','Read-AdiStateFile','Write-AdiStateFile','Get-AdiProjectPath','Get-AdiRepositoryHost','Get-AdiRepositoryAddress','Get-AdiGitObservation')){
    Set-Item -LiteralPath ('Function:global:'+$name) -Value (Get-Item -LiteralPath ('Function:'+$name)).ScriptBlock
  }
  $git=Find-AdiProjectGit
  $runner={
    param([string[]]$Arguments,[int]$Timeout)
    if(!$git){throw 'git_missing'}
    [Adi.Native.ProcessRunner]::RunGit($git,$Arguments,$Timeout)
  }.GetNewClosure()
  $probe={param($Workspace)Get-AdiGitObservation $Workspace 'windows' $runner}.GetNewClosure()
  $io=New-AdiProjectIo (Join-Path $base 'project-state') 'windows' $probe
  return Get-AdiProjectContext $io $Settings $Payload
}
