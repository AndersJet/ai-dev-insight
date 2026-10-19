import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,link,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
const fail=()=>Object.assign(new Error('Private recovery artifact is unavailable or invalid'),{code:'recovery_artifact_invalid'});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function parent(path:string){
 if(!isAbsolute(path)||process.platform==='win32')throw fail();const directory=dirname(path),info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw fail();return directory;
}
export async function prepareRecoveryArtifact(path:string){await parent(path);try{await lstat(path);throw fail();}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='ENOENT')throw error;}}
export async function writeRecoveryArtifact(path:string,data:unknown,maximum=16778240){
 const directory=await parent(path),hash=digest(data),encoded=JSON.stringify({version:1,digest:hash,data})+'\n';if(Buffer.byteLength(encoded)>maximum)throw fail();const temporary=join(directory,`.tmp-${randomUUID()}`);let file;
 try{file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.writeFile(encoded);await file.sync();await file.close();file=undefined;await link(temporary,path);const folder=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await folder.sync();}finally{await folder.close();}return {path,digest:hash};}
 catch{throw fail();}finally{await file?.close();await unlink(temporary).catch(()=>{});}
}
export async function readRecoveryArtifact(path:string,expected:string,maximum=16778240):Promise<unknown>{
 await parent(path);if(!/^[0-9a-f]{64}$/.test(expected))throw fail();const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.size>maximum)throw fail();const value=JSON.parse(await file.readFile('utf8')) as {version:number;digest:string;data:unknown};if(!value||value.version!==1||Object.keys(value).sort().join(',')!=='data,digest,version'||value.digest!==expected||digest(value.data)!==expected)throw fail();return value.data;}catch{throw fail();}finally{await file.close();}
}
