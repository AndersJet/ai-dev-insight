/** Lexical project identity only: never resolves a symlink or folds path case. */
export function normalizeProjectPath(value:unknown,platform:'macos'|'windows'|'linux'):string|null{
  // eslint-disable-next-line no-control-regex -- Reject control bytes at the untrusted path boundary.
  if(typeof value!=='string'||!value||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))return null;
  if(platform!=='windows')return value.startsWith('/')?value.replace(/\/+$/,'')||'/':null;
  const path=value.replace(/\\/g,'/');
  if(/^[a-z]:\//i.test(path)){
    const normalized=path[0]!.toUpperCase()+path.slice(1);
    return /^[A-Z]:\/+$/i.test(normalized)?normalized.slice(0,2)+'/':normalized.replace(/\/+$/,'');
  }
  return /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(path)?path.replace(/\/+$/,''):null;
}
