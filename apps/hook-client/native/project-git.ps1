# Read-only local Git commands. The process adapter owns timeout, byte limits
# and child cleanup; no fetch, remote connection, credential helper or DNS.
function Get-AdiGitObservation([string]$Workspace,[string]$Platform,[scriptblock]$Runner) {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  function Failed-Git([string]$Reason){return @{state='failed';reason=$Reason;git_root=$null;remotes=@()}}
  function Run-ProjectGit([string[]]$Arguments) {
    $remaining=180-[int]$clock.ElapsedMilliseconds;if($remaining -le 0){throw 'timeout'}
    $result=& $Runner (@('-C',$Workspace)+$Arguments) $remaining
    if($clock.ElapsedMilliseconds -ge 180){throw 'timeout'}
    if($result.out -isnot [string] -or $result.err -isnot [string]){throw 'invalid_git_output'}
    if([Text.Encoding]::UTF8.GetByteCount($result.out) -gt 262144 -or [Text.Encoding]::UTF8.GetByteCount($result.err) -gt 262144){throw 'output_limit'}
    return $result
  }
  try {
    $top=Run-ProjectGit @('rev-parse','--show-toplevel')
    if($top.code -ne 0){
      if($top.err -match '(^|\n)fatal: not a git repository'){return @{state='not_git';reason=$null;git_root=$null;remotes=@()}}
      if($top.err -match 'cannot change to|Permission denied|Access is denied'){return Failed-Git 'inaccessible'}
      return Failed-Git 'git_error'
    }
    $gitRoot=[regex]::Replace($top.out,'\r?\n$','')
    if(!(Get-AdiProjectPath $gitRoot $Platform)){return Failed-Git 'invalid_git_output'}
    $config=Run-ProjectGit @('config','--null','--get-regexp','^remote\..*\.(url|pushurl)$')
    if($config.code -eq 1 -and !$config.out){return @{state='no_remote';reason=$null;git_root=$gitRoot;remotes=@()}}
    if($config.code -ne 0 -or !$config.out -or !$config.out.EndsWith([string][char]0)){return Failed-Git 'git_error'}
    $entries=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $configured=0
    foreach($line in $config.out.Substring(0,$config.out.Length-1).Split([char]0)){
      if($clock.ElapsedMilliseconds -ge 180){throw 'timeout'}
      $configured++;if($configured -gt 64){return Failed-Git 'output_limit'}
      $separator=$line.IndexOf([char]10);if($separator -lt 0){return Failed-Git 'invalid_git_output'}
      $match=[regex]::Match($line.Substring(0,$separator),'^remote\.(.+)\.(url|pushurl)$');$value=$line.Substring($separator+1)
      if(!$match.Success -or !$value){return Failed-Git 'invalid_git_output'}
      $name=$match.Groups[1].Value;$type=$match.Groups[2].Value
      if($name.Length -gt 128 -or ($name+$value) -match '[\x00-\x1f\x7f]'){return Failed-Git 'invalid_git_output'}
      if(!$entries.ContainsKey($name)){$entries[$name]=@{url=New-Object Collections.Generic.List[string];pushurl=New-Object Collections.Generic.List[string]}}
      $entries[$name][$type].Add($value)
    }
    $remotes=New-Object Collections.Generic.List[object]
    [string[]]$names=@($entries.Keys);[Array]::Sort($names,[StringComparer]::Ordinal)
    foreach($name in $names){
      $entry=$entries[$name]
      foreach($direction in @('fetch','push')){
        $expected=$entry.url.Count
        if($direction -eq 'push' -and $entry.pushurl.Count){$expected=$entry.pushurl.Count}
        if(!$expected){continue}
        if($remotes.Count+$expected -gt 64){return Failed-Git 'output_limit'}
        $arguments=@('remote','get-url');if($direction -eq 'push'){$arguments+=@('--push')}
        $arguments+=@('--all','--',$name)
        $urls=Run-ProjectGit $arguments
        if($urls.code -ne 0 -or !$urls.out.EndsWith([string][char]10)){return Failed-Git 'git_error'}
        $values=[regex]::Split([regex]::Replace($urls.out,'\r?\n$',''),'\r?\n')
        if($values.Length -ne $expected){return Failed-Git 'invalid_git_output'}
        foreach($value in $values){$remotes.Add([ordered]@{address=$value})}
      }
    }
    $state='no_remote';if($remotes.Count){$state='repository'}
    if($clock.ElapsedMilliseconds -ge 180){throw 'timeout'}
    return @{state=$state;reason=$null;git_root=$gitRoot;remotes=@(Get-AdiRepositoryAddresses $remotes.ToArray() $Platform)}
  }catch{
    $reason=$_.Exception.GetBaseException().Message;if(@('git_missing','timeout','output_limit','invalid_git_output') -cnotcontains $reason){$reason='git_error'}
    return Failed-Git $reason
  }
}
