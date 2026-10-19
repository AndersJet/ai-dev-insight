// Invoked with the remote IDE's bundled Node runtime. Never spools event text.
import {readFileSync} from 'node:fs';
import {uniqueRemoteRelay} from './remote-presence.js';
import {dirname} from 'node:path';
import {uptime} from 'node:os';
import {request} from 'node:http';
const timer=setTimeout(()=>process.exit(0),650);
try{
  const base=dirname(process.argv[1]!),boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const config=uniqueRemoteRelay(base,boot,uptime()*1000);if(!config)process.exit(0);
  const chunks:Buffer[]=[];let bytes=0;process.stdin.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>900000)process.exit(0);chunks.push(chunk);});
  process.stdin.on('end',()=>{const body=Buffer.concat(chunks),req=request({host:'127.0.0.1',port:config.port,path:'/hook',method:'POST',agent:false,headers:{authorization:`Bearer ${config.token}`,'content-length':body.length}},res=>{res.resume();res.once('end',()=>process.exit(0));});req.on('error',()=>process.exit(0));req.end(body);});process.stdin.on('error',()=>process.exit(0));
}catch{clearTimeout(timer);process.exit(0);}
