/** List each observed repository address once, including one unknown address. */
export function repositoryAddresses(remotes:readonly {address:string|null}[]){
  return [...new Set(remotes.map(remote=>remote.address))];
}
