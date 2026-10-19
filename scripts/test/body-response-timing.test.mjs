import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {createBodyResponseTiming,assessBodyResponseSlo} from '../lib/body-response-timing.mjs';

test('response timing starts at the complete request body, excluding earlier upload time',async t=>{
 let clock=0;const timing=createBodyResponseTiming(()=>clock);
 let firstChunk;const received=new Promise(resolve=>{firstChunk=resolve;});
 const server=createServer((req,res)=>{
  timing.observe(req,res);req.once('data',()=>firstChunk());
  req.once('end',()=>{clock=10080;res.end();});req.resume();
 });
 t.after(()=>{server.closeAllConnections();server.close();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const done=new Promise((resolve,reject)=>{
  const client=request({host:'127.0.0.1',port:server.address().port,path:'/hooks',method:'POST',headers:{'content-length':2}},res=>{res.resume();res.once('end',resolve);});
  client.once('error',reject);client.write('a');
  void received.then(()=>{clock=10000;client.end('b');});
 });
 await done;
 const measured=timing.snapshot();
 assert.equal(measured.samples,1);assert.equal(measured.max_ms,80);
 assert.equal(measured.p95_upper_bound_ms,100);assert.equal(measured.p99_upper_bound_ms,100);
 assert.equal(assessBodyResponseSlo(measured,1).pass,true);
});

test('early responses and aborted responses stay explicit instead of appearing as zero-latency success',async t=>{
 const timing=createBodyResponseTiming();let observedClose;const closed=new Promise(resolve=>{observedClose=resolve;});
 const server=createServer((req,res)=>{
  timing.observe(req,res);
  if(req.url==='/early'){res.end();return;}
  res.once('close',observedClose);req.once('end',()=>res.destroy());req.resume();
 });
 t.after(()=>{server.closeAllConnections();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const send=path=>new Promise(resolve=>{
  const client=request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'content-length':2}},res=>{res.resume();res.once('end',()=>{client.destroy();resolve('completed');});});
  client.once('error',error=>resolve(error.code));
  if(path==='/early')client.write('a');else client.end('ab');
 });
 assert.equal(await send('/early'),'completed');assert.equal(await send('/abort'),'ECONNRESET');await closed;
 const measured=timing.snapshot();assert.equal(measured.samples,0);assert.equal(measured.finished_before_body,1);assert.equal(measured.aborted_responses,1);
 assert.equal(measured.p95_upper_bound_ms,null);assert.equal(assessBodyResponseSlo(measured,2).pass,false);
});

test('bounded histogram applies nearest-rank percentile budgets and resets between bursts',async t=>{
 let clock=0,index=0;const durations=[...Array(95).fill(80),...Array(4).fill(200),350,500];
 const timing=createBodyResponseTiming(()=>clock);
 const server=createServer((req,res)=>{timing.observe(req,res);req.once('end',()=>{clock+=durations[index++];res.end();});req.resume();});
 t.after(()=>{server.closeAllConnections();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const send=()=>new Promise((resolve,reject)=>{const client=request({host:'127.0.0.1',port:server.address().port,method:'POST'},res=>{res.resume();res.once('end',resolve);});client.once('error',reject);client.end('x');});
 for(let i=0;i<100;i++)await send();
 const first=timing.snapshot();assert.equal(first.samples,100);assert.equal(first.p95_upper_bound_ms,100);assert.equal(first.p99_upper_bound_ms,200);assert.equal(first.max_ms,350);assert.equal(assessBodyResponseSlo(first,100).pass,true);
 assert.equal(assessBodyResponseSlo(first,101).pass,false,'missing observations must not pass');
 timing.reset();assert.equal(timing.snapshot().samples,0);assert.equal(assessBodyResponseSlo(timing.snapshot(),0).pass,false);
 await send();const second=timing.snapshot();assert.equal(second.samples,1);assert.equal(second.p95_upper_bound_ms,500);assert.equal(assessBodyResponseSlo(second,1).pass,false);assert.equal(first.samples,100);
});

test('a burst cannot reset while a request is still in flight',async t=>{
 const timing=createBodyResponseTiming();let received;const bodyStarted=new Promise(resolve=>{received=resolve;});
 const server=createServer((req,res)=>{timing.observe(req,res);req.once('data',received);req.once('end',()=>res.end());req.resume();});
 t.after(()=>{server.closeAllConnections();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
 let client;const done=new Promise((resolve,reject)=>{client=request({host:'127.0.0.1',port:server.address().port,method:'POST',headers:{'content-length':2}},res=>{res.resume();res.once('end',resolve);});client.once('error',reject);client.write('a');});
 await bodyStarted;
 try{assert.throws(()=>timing.reset(),/in flight/);}finally{client.end('b');await done;}
 timing.reset();assert.equal(timing.snapshot().samples,0);
});
