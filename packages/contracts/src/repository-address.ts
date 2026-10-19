/** Safe, explicit network repository identity; no DNS or Git configuration resolution. */
export interface RepositoryAddress { address: string; host: string; internal_ipv4: boolean }
export function normalizeRepositoryHost(input: string): string | null {
  const host=input.toLowerCase();
  if(!host||host.length>253||/[\s\\/@?#%]/.test(host))return null;
  if(host.startsWith('[')){
    if(!/^\[[0-9a-f:.]+\]$/.test(host))return null;
    try {const parsed=new URL(`http://${host}/`);return parsed.hostname.startsWith('[')&&parsed.host===parsed.hostname?parsed.hostname:null;}catch{return null;}
  }
  if(/^[0-9.]+$/.test(host)){
    const parts=host.split('.');
    return parts.length===4&&parts.every(part=>/^(?:0|[1-9][0-9]{0,2})$/.test(part)&&Number(part)<=255)?host:null;
  }
  return host.split('.').every(label=>label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))?host:null;
}

export function parseRepositoryAddress(input: string): RepositoryAddress | null {
  if(typeof input!=='string'||input.length>4096||/[\s\\]/.test(input)||Array.from(input).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))return null;
  if(!input.includes('://')){
    if(/^[a-z]:\//i.test(input))return null;
    const scp=/^(?:[^:@/]+@)?(\[[^\]]+\]|[^:/@]+):([^?#]+)(?:[?#].*)?$/.exec(input);
    if(!scp||scp[2]!.startsWith(':')||/[<>"']|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(scp[2]!))return null;
    const host=normalizeRepositoryHost(scp[1]!);
    return host?{address:`${host}:${scp[2]}`,host,internal_ipv4:/^10\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host)}:null;
  }
  const match=/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)(?:[?#].*)?$/i.exec(input);
  if(!match||!['https','http','ssh','git'].includes(match[1]!.toLowerCase()))return null;
  const authority=match[2]!.slice(match[2]!.lastIndexOf('@')+1),path=match[3]!;
  const parts=/^(\[[^\]]+\]|[^:]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if(!parts||path==='/'||/[<>"']|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(path))return null;
  const host=normalizeRepositoryHost(parts[1]!);
  if(!host||(parts[2]!==undefined&&(Number(parts[2])<1||Number(parts[2])>65535)))return null;
  return {address:`${match[1]!.toLowerCase()}://${host}${parts[2]!==undefined?`:${parts[2]}`:''}${path}`,host,internal_ipv4:/^10\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host)};
}

/** Address-only evidence in source order, after removing credentials and invalid addresses. */
export function normalizeRepositoryAddresses(remotes:readonly {address:string|null}[]):{address:string|null}[] {
  const seen=new Set<string|null>(),addresses:{address:string|null}[]=[];
  for(const remote of remotes){
    const address=remote.address===null?null:parseRepositoryAddress(remote.address)?.address??null;
    if(seen.has(address))continue;
    seen.add(address);addresses.push({address});
  }
  return addresses;
}
