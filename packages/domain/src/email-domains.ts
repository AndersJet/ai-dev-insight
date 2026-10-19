/** An empty setting allows any domain; malformed nonempty settings never do. */
export function configuredEmailDomains(values:readonly string[]=[]):ReadonlySet<string>{
  const domains=values.map(value=>value.trim().toLowerCase());
  if(domains.length===0||domains.length===1&&domains[0]==='')return new Set();
  if(domains.some(domain=>domain.length>253||!domain.includes('.')||domain.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))throw new Error('Invalid email domain configuration');
  return new Set(domains);
}

export function emailDomainAllowed(domains:ReadonlySet<string>,email:string){
  return domains.size===0||domains.has(email.split('@')[1]!);
}
