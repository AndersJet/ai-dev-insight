import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
export interface RemotePresence {version:2;instance:string;boot:string;expires:number;active:boolean;owner:string|null;port?:number;token?:string}
const names=/^relay-[a-f0-9-]{36}\.json$/;
/** A shared project Hook has no trustworthy source-window ID. Never elect a peer. */
export function remotePresences(base:string,boot:string,now:number):RemotePresence[]|null {
 try {
 const files=readdirSync(base).filter(name=>names.test(name));if(files.length>4096)return null;
 const peers:RemotePresence[]=[];
 for(const name of files){
  const path=join(base,name),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048||(stat.mode&0o077)!==0)return null;
  const value=JSON.parse(readFileSync(path,'utf8')) as RemotePresence;
  if(typeof value.boot!=='string'||!Number.isSafeInteger(value.expires))return null;
  if(value.boot!==boot||value.expires<=now)continue;
  if(value.version!==2||value.instance!==name.slice(6,-5)||value.expires-now>20000||typeof value.active!=='boolean'||value.owner!==null&&!/^[a-f0-9]{64}$/.test(value.owner))return null;
  if(value.active&&(!value.owner||!Number.isInteger(value.port)||(value.port??0)<1024||(value.port??0)>65535||!/^[-_A-Za-z0-9]{43}$/.test(value.token??'')))return null;
  peers.push(value);if(peers.length>100)return null;
 }
 return peers;
 }catch{return null;}
}
export function uniqueRemoteRelay(base:string,boot:string,now:number):RemotePresence|undefined {
 const peers=remotePresences(base,boot,now);return peers?.length===1&&peers[0]!.active?peers[0]:undefined;
}
