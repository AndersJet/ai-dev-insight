import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createServer as createHttpsServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {pluginRequest,requestFailure,pluginFailureHint} from '../src/http-client.js';
import {platformRequest} from '../src/platform-session.js';

test('实际连接拒绝保留可定位的错误码，两条插件请求路径均不暴露原始异常',async()=>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as AddressInfo).port;
 await new Promise<void>(resolve=>server.close(()=>resolve()));const origin=`http://127.0.0.1:${port}`;
 for(const request of [()=>pluginRequest(origin,'/api/v1/plugin/observations',{},undefined,new AbortController().signal),()=>platformRequest(origin,'/api/v1/plugin-releases/current',new AbortController().signal)]){
  await assert.rejects(request(),error=>{assert.equal((error as {transportCode:string}).transportCode,'ECONNREFUSED');assert.equal(pluginFailureHint(error),'网络连接失败：ECONNREFUSED');return true;});
 }
 const hidden=requestFailure({code:'synthetic-secret-code',message:'SyntheticPassword',headers:{Authorization:'SyntheticToken'}});
 assert.equal(hidden.transportCode,'');assert.equal(pluginFailureHint(hidden),'网络请求失败');assert.ok(!JSON.stringify(hidden).includes('Synthetic'));
});

test('plugin HTTP sends JSON to the configured endpoint and returns its data envelope',async t=>{
  const bodies:unknown[]=[];
  const server=createServer((req,res)=>{let input='';req.on('data',part=>{input+=part;});req.on('end',()=>{bodies.push(JSON.parse(input));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{accepted:true}}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const result=await pluginRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'/api/v1/plugin/registration',{nt_email:'test.nt@example.org'},undefined,new AbortController().signal);
  assert.deepEqual(result,{accepted:true});assert.deepEqual(bodies,[{nt_email:'test.nt@example.org'}]);
});

test('a stalled real response is abandoned within the three-second total deadline',async t=>{
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"data":');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const start=performance.now();await assert.rejects(pluginRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'/api/v1/plugin/observations',{},'synthetic-only',new AbortController().signal),{reason:'request_timeout'});
  assert.ok(performance.now()-start<3600,'response body stall must remain bounded');
});

test('slow initialization succeeds without extending collection HTTP or delaying cancellation',async t=>{
 const server=createServer((_req,res)=>{const timer=setTimeout(()=>res.end('{"data":{"accepted":true}}'),3200);res.on('close',()=>clearTimeout(timer));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const result=await platformRequest(origin,'/api/v1/plugin/me',new AbortController().signal);assert.deepEqual(result.data,{accepted:true});
 const started=performance.now();await assert.rejects(platformRequest(origin,'/api/v1/plugin/observations',new AbortController().signal,{method:'POST',body:{}}),{reason:'request_timeout'});
 assert.ok(performance.now()-started<3600,'background collection retains the three-second network budget');
 const controller=new AbortController(),cancelled=performance.now();setTimeout(()=>controller.abort(),50);
 await assert.rejects(platformRequest(origin,'/api/v1/plugin/me',controller.signal),{reason:'aborted'});assert.ok(performance.now()-cancelled<1000);
});

test('redirect responses cannot forward a source proof or reporting token to another endpoint',async t=>{
  let forwarded=0;const target=createServer((_req,res)=>{forwarded++;res.end('{"data":{}}');});target.listen(0,'127.0.0.1');await once(target,'listening');
  const server=createServer((_req,res)=>{res.writeHead(307,{location:`http://127.0.0.1:${(target.address() as AddressInfo).port}/capture`});res.end();});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{target.closeAllConnections();server.closeAllConnections();target.close();server.close();});
  await assert.rejects(pluginRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'/api/v1/plugin/registration',{source_secret:'synthetic-only'},undefined,new AbortController().signal),{status:307});assert.equal(forwarded,0);
});

test('a real 429 HTTP-date retry hint postpones sending instead of falling back to a short local retry',async t=>{
  const retryAt=new Date(Date.now()+3600000).toUTCString();
  const server=createServer((_req,res)=>{res.writeHead(429,{'retry-after':retryAt});res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  await assert.rejects(pluginRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'/api/v1/plugin/observations',{},'synthetic-only',new AbortController().signal),error=>{
    const hint=error as {status:number;retryAfterMs:number};assert.equal(hint.status,429);assert.ok(hint.retryAfterMs>=3598000&&hint.retryAfterMs<=3600000,'a future HTTP date is a valid one-hour retry hint');return true;
  });
});


test('HTTPS rejects an untrusted certificate even when another host component disabled the Node default',async t=>{
  // Public, synthetic material keeps this test independent of a system OpenSSL install.
  const {key,cert}=JSON.parse(await readFile(new URL('./fixtures/synthetic-tls.json',import.meta.url),'utf8'));
  const server=createHttpsServer({key,cert},(_req,res)=>res.end('{"data":{"accepted":true}}'));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
  try{await assert.rejects(pluginRequest(`https://127.0.0.1:${(server.address() as AddressInfo).port}`,'/api/v1/plugin/observations',{},'synthetic-only',new AbortController().signal),{reason:'request_failed'});}
  finally{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;}
});
