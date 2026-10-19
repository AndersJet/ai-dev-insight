param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Sender)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id)
if($id.IsSystem -or $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ordinary_user_required'}
if([IO.Path]::GetFileName($Root) -notmatch '^adi-native-validation-[a-f0-9-]{36}$' -or !$Sender.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'isolated_inputs_required'}
$dir=Join-Path $Root ('job-'+[guid]::NewGuid().ToString().Substring(0,8));[void][IO.Directory]::CreateDirectory($dir)
$exe=Join-Path $dir 'tree.exe'
$source=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
public static class TreeFixture {
 public static void Main(string[] args) {
  if(args[0]=="child"){Thread.Sleep(30000);return;}
  var info=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"child");info.UseShellExecute=false;info.CreateNoWindow=true;
  var child=Process.Start(info);
  if(args[0]=="exit"){Console.WriteLine(child.Id);return;}
  File.WriteAllText(args[1],child.Id.ToString());Thread.Sleep(30000);
 }
}
'@
$provider=New-Object Microsoft.CSharp.CSharpCodeProvider
$options=New-Object CodeDom.Compiler.CompilerParameters
$options.GenerateExecutable=$true;$options.GenerateInMemory=$false;$options.OutputAssembly=$exe;$options.CompilerOptions='/optimize'
$null=$options.ReferencedAssemblies.Add('System.dll')
$compiled=$provider.CompileAssemblyFromSource($options,[string[]]@($source));if($compiled.Errors.HasErrors){throw 'fixture_compile_failed'};$provider.Dispose()
$null=[Reflection.Assembly]::LoadFrom($Sender)
$result=[Adi.Native.ProcessRunner]::RunGit($exe,[string[]]@('exit'),700)
$descendant=[int]$result['out'].Trim();Start-Sleep -Milliseconds 100
$alive=Get-Process -Id $descendant -ErrorAction SilentlyContinue
if($alive){if($alive.Path -ceq $exe){Stop-Process -Id $descendant};throw 'descendant_survived_or_pid_reused_after_root_exit'}
$pidFile=Join-Path $dir 'timeout.pid'
try{$null=[Adi.Native.ProcessRunner]::RunGit($exe,[string[]]@('timeout',$pidFile),700);throw 'missing_timeout'}catch{if($_.Exception.GetBaseException().Message -cne 'timeout'){throw}}
if(![IO.File]::Exists($pidFile)){throw 'timeout_descendant_not_started'}
$descendant=[int][IO.File]::ReadAllText($pidFile);Start-Sleep -Milliseconds 100
$alive=Get-Process -Id $descendant -ErrorAction SilentlyContinue
if($alive){if($alive.Path -ceq $exe){Stop-Process -Id $descendant};throw 'descendant_survived_or_pid_reused_after_timeout'}
Write-Output 'passed: ordinary user Job boundary kills started descendants after root exit and timeout (700ms fixture budget)'
