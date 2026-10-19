#Requires -Version 5.1
[CmdletBinding()]
param(
  # Optional executable paths for a custom installation; files are never launched.
  [string[]]$TraeExecutable = @()
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Run this preflight in native Windows PowerShell.'
}

# These KnownFolder values are used only to redact paths, never as report fields.
# The macro names below are display placeholders, not environment-variable reads.
$probePathPrefixes = @(
  @{ path = [Environment]::GetFolderPath('LocalApplicationData'); label = '%LOCALAPPDATA%' },
  @{ path = [Environment]::GetFolderPath('ProgramFilesX86'); label = '%PROGRAMFILES(X86)%' },
  @{ path = [Environment]::GetFolderPath('ProgramFiles'); label = '%PROGRAMFILES%' },
  @{ path = [Environment]::GetFolderPath('UserProfile'); label = '%USERPROFILE%' }
) | Where-Object { $_.path } | Sort-Object { $_.path.Length } -Descending
function Convert-ToReportPath([string]$Path) {
  foreach ($prefix in $probePathPrefixes) {
    $root = $prefix.path.TrimEnd([char]'\')
    if ($Path.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $prefix.label }
    if ($Path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
      return $prefix.label + $Path.Substring($root.Length)
    }
  }
  # A visible executable might belong to another profile; do not reveal its name.
  return $Path -replace '(?i)(\\Users\\)[^\\]+', '$1<redacted-user>'
}

$windows = [ordered]@{
  name = 'Windows'
  version = [Environment]::OSVersion.Version.ToString()
  build = [Environment]::OSVersion.Version.Build
  revision = $null
  display_version = $null
  architecture = 'unknown'
  metadata_status = 'partial'
}
try {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property Caption, Version, BuildNumber
  $cpu = Get-CimInstance -ClassName Win32_Processor -Property Architecture | Select-Object -First 1
  $windows.name = $os.Caption
  $windows.version = $os.Version
  $windows.build = $os.BuildNumber
  if ($null -ne $cpu -and $null -ne $cpu.Architecture) {
    $windows.architecture = switch ([int]$cpu.Architecture) {
      9 { 'x64' }
      12 { 'ARM64' }
      0 { 'x86' }
      5 { 'ARM' }
      default { 'unknown' }
    }
  }
  $windows.metadata_status = 'read'
} catch {
  # Do not put usernames, machine names, or raw exception text in the report.
}
try {
  $version = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name UBR, DisplayVersion
  $windows.revision = $version.UBR
  $windows.display_version = $version.DisplayVersion
} catch {
  # Older Windows builds or restricted registry access leave optional fields empty.
}

$gitCommands = @(Get-Command -Name 'git.exe' -CommandType Application -All -ErrorAction SilentlyContinue)
$gitPaths = @($gitCommands | ForEach-Object { $_.Source } | Select-Object -Unique)
$git = [ordered]@{ candidates = @($gitPaths | ForEach-Object { Convert-ToReportPath $_ }); selected = $null; version = $null; status = 'not_found' }
if ($gitPaths.Count -gt 0) {
  $selectedGit = $gitPaths[0]
  $git.selected = Convert-ToReportPath $selectedGit
  $process = New-Object System.Diagnostics.Process
  try {
    $process.StartInfo.FileName = $selectedGit
    $process.StartInfo.Arguments = '--version'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    [void]$process.Start()
    if (-not $process.WaitForExit(3000)) {
      # Only terminate the read-only Git version process started by this script.
      try { $process.Kill(); [void]$process.WaitForExit(1000) } catch {}
      $git.status = 'version_timeout'
    } elseif ($process.ExitCode -eq 0) {
      $value = $process.StandardOutput.ReadToEnd().Trim()
      if ($value -match '^git version [A-Za-z0-9.+_-]{1,100}$') {
        $git.version = $value
        $git.status = 'read'
      } else {
        $git.status = 'unexpected_version_output'
      }
    } else {
      $git.status = 'version_failed'
    }
  } catch {
    $git.status = 'version_failed'
  } finally {
    $process.Dispose()
  }
}

# Inspect a finite set of installation paths. Do not scan profiles or drives.
$candidates = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$localPrograms = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'
$roots = @(
  $localPrograms,
  [Environment]::GetFolderPath('ProgramFiles'),
  [Environment]::GetFolderPath('ProgramFilesX86')
) | Where-Object { $_ }
foreach ($root in $roots) {
  foreach ($relative in @('Trae CN\Trae CN.exe', 'Trae CN\trae-cn.exe', 'Trae\Trae.exe')) {
    [void]$candidates.Add((Join-Path $root $relative))
  }
}
foreach ($command in @(Get-Command -Name 'Trae CN.exe', 'trae-cn.exe', 'Trae.exe' -CommandType Application -All -ErrorAction SilentlyContinue)) {
  [void]$candidates.Add($command.Source)
}
foreach ($path in $TraeExecutable) {
  if ($path) {
    try { [void]$candidates.Add([IO.Path]::GetFullPath($path)) }
    catch { throw 'Invalid Trae executable path; provide a local file path.' }
  }
}
$installed = @(
  foreach ($path in $candidates) {
    try {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $item = Get-Item -LiteralPath $path
      $metadata = $item.VersionInfo
      [ordered]@{
        path = Convert-ToReportPath $item.FullName
        variant_hint = $(if ($item.Name -match 'CN|trae-cn') { 'Trae CN' } else { 'Trae' })
        product_name = $metadata.ProductName
        product_version = $metadata.ProductVersion
        file_version = $metadata.FileVersion
        metadata_status = 'read'
        metadata_only = $true
      }
    } catch {
      [ordered]@{ path = Convert-ToReportPath $path; metadata_status = 'unavailable'; metadata_only = $true }
    }
  }
)

$report = [ordered]@{
  schema_version = 1
  checked_at = [DateTime]::UtcNow.ToString('o')
  platform = 'native_windows'
  windows = $windows
  powershell_version = $PSVersionTable.PSVersion.ToString()
  path_format = 'redacted_known_folder_placeholders'
  git = $git
  trae = [ordered]@{ inspected_path_count = $candidates.Count; candidates = $installed }
  host_capabilities_tested = $false
}
$reportPath = Join-Path $PSScriptRoot 'synthetic-host-preflight.json'
try {
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
} catch {
  throw 'Cannot write synthetic-host-preflight.json in the test material directory.'
}
Write-Output ('Saved synthetic-host-preflight.json; Trae candidates: {0}; Git: {1}.' -f $installed.Count, $git.status)
