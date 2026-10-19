param([string]$Config)
$ErrorActionPreference='Stop'
try {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  # Installed Hooks invoke the compiled sender directly; this is a manual entry.
  . (Join-Path $PSScriptRoot 'native-windows.ps1')
  Import-AdiProcessLibrary
  $program="& '"+(Join-Path $PSScriptRoot 'send-worker.ps1').Replace("'","''")+"' -Config '"+$Config.Replace("'","''")+"'"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
  $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  [Adi.Native.ProcessRunner]::SendWorker($exe,@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded),[Console]::OpenStandardInput(),750-[int]$clock.ElapsedMilliseconds)
} catch { }
exit 0
