# Durable state adapter. Windows uses the account's private inherited ACL;
# macos is for portable developer checks, not an employee runtime.
function Assert-AdiStatePath([string]$Path,[bool]$Directory,[string]$Platform) {
  $full=[IO.Path]::GetFullPath($Path);$cursor=$full
  while($cursor){
    if(Test-Path -LiteralPath $cursor){
      $item=Get-Item -LiteralPath $cursor -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unsafe_state_path'}
      if($cursor -ceq $full -and $item.PSIsContainer -ne $Directory){throw 'unsafe_state_path'}
    }
    $parent=[IO.Path]::GetDirectoryName($cursor);if($parent -ceq $cursor){break};$cursor=$parent
  }
  if($Platform -eq 'windows' -and (Test-Path -LiteralPath $full)){
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=Get-Acl -LiteralPath $full
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value){throw 'unsafe_state_permissions'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -cne $sid.Value){throw 'unsafe_state_permissions'}
    }
  }
}
function New-AdiStateDirectory([string]$Path,[string]$Platform) {
  Assert-AdiStatePath $Path $true $Platform
  if([IO.Directory]::Exists($Path)){return}
  $null=[IO.Directory]::CreateDirectory($Path)
  if($Platform -eq 'windows'){
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    [IO.Directory]::SetAccessControl($Path,$acl)
  }else{[IO.File]::SetUnixFileMode($Path,[IO.UnixFileMode]448)}
}
function Read-AdiStateFile([string]$Path,[int]$Limit,[string]$Platform) {
  Assert-AdiStatePath $Path $false $Platform
  if(![IO.File]::Exists($Path)){return $null}
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{
    if($stream.Length -gt $Limit){throw 'oversized_file'}
    $buffer=New-Object byte[] ($Limit+1);$offset=0
    while($offset -lt $buffer.Length){$n=$stream.Read($buffer,$offset,$buffer.Length-$offset);if(!$n){break};$offset+=$n}
    if($offset -gt $Limit){throw 'oversized_file'}
    return (New-Object Text.UTF8Encoding($false,$true)).GetString($buffer,0,$offset)
  }finally{$stream.Dispose()}
}
function Write-AdiStateFile([string]$Path,[string]$Value,[string]$Platform) {
  Assert-AdiStatePath $Path $false $Platform
  $temp=Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.state-'+[guid]::NewGuid().ToString())
  try{
    $stream=[IO.File]::Open($temp,'CreateNew','Write','None')
    try{
      if($Platform -ne 'windows'){[IO.File]::SetUnixFileMode($temp,[IO.UnixFileMode]384)}else{
        $owner=[IO.File]::GetAccessControl($temp,[Security.AccessControl.AccessControlSections]::Owner)
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        if($owner.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){$owner.SetOwner($sid);[IO.File]::SetAccessControl($temp,$owner)}
      }
      $bytes=(New-Object Text.UTF8Encoding($false,$true)).GetBytes($Value)
      $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
    }finally{$stream.Dispose()}
    if([IO.File]::Exists($Path)){[IO.File]::Replace($temp,$Path,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temp,$Path)}
  }finally{if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
function New-AdiProjectIo([string]$Root,[string]$Platform,[scriptblock]$Probe) {
  $Root=[IO.Path]::GetFullPath($Root)
  return @{
    Root=$Root;Platform=$Platform
    uuid={[guid]::NewGuid().ToString()}
    hash={param([string]$Value)$hash=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
    read={param($Path,$Limit)Read-AdiStateFile $Path $Limit $Platform}.GetNewClosure()
    atomic={param($Path,$Value)Write-AdiStateFile $Path $Value $Platform}.GetNewClosure()
    directory={param($Path)New-AdiStateDirectory $Path $Platform}.GetNewClosure()
    lock={
      $path=Join-Path $Root 'state.lock';Assert-AdiStatePath $path $false $Platform
      $stream=[IO.File]::Open($path,'OpenOrCreate','ReadWrite','None')
      if($Platform -ne 'windows'){[IO.File]::SetUnixFileMode($path,[IO.UnixFileMode]384)}
      return $stream
    }.GetNewClosure()
    unlock={param($Handle)$Handle.Dispose()}
    tick={[long]([Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency)}
    now={[long]([DateTime]::UtcNow-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds}
    probe=$Probe
  }
}
