import {createServer,createConnection,type Socket,type AddressInfo} from 'node:net';
import {once} from 'node:events';

/** Local integration boundary only: never records or prints protocol bytes. */
export async function postgresFaultProxy(upstreamUrl:string){
 const target=new URL(upstreamUrl);const local=['127.0.0.1','localhost'].includes(target.hostname)&&target.port==='55438';const ci=process.env.CI==='true'&&target.hostname==='postgres-test'&&target.port==='5432';
 if(!(local||ci)||target.pathname!=='/adi_test'||target.username!=='adi_test'||target.search||target.hash)throw new Error('Fault proxy requires the isolated synthetic database');
 const sockets=new Set<Socket>();let mode:'healthy'|'drop-responses'|'drop-requests'='healthy';let dropped=0;let connections=0;
 const server=createServer(downstream=>{
  connections++;const upstream=createConnection({host:target.hostname,port:Number(target.port)});sockets.add(downstream);sockets.add(upstream);
  const forward=(source:Socket,destination:Socket,direction:'drop-responses'|'drop-requests')=>{source.on('data',chunk=>{if(mode===direction){dropped+=chunk.length;return;}if(!destination.write(chunk)){source.pause();destination.once('drain',()=>source.resume());}});};
  forward(downstream,upstream,'drop-requests');forward(upstream,downstream,'drop-responses');
  for(const [source,peer] of [[downstream,upstream],[upstream,downstream]] as const){source.on('error',()=>{source.destroy();peer.destroy();});source.on('close',()=>{sockets.delete(source);peer.destroy();});}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=new URL(upstreamUrl);url.hostname='127.0.0.1';url.port=String((server.address() as AddressInfo).port);
 return {connectionString:url.href,setMode:(value:typeof mode)=>{mode=value;},disconnect:()=>{for(const socket of sockets)socket.destroy();},snapshot:()=>({droppedBytes:dropped,connections}),close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
