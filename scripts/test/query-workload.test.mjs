import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createQueryWorkload,assessQuerySlo} from '../lib/query-workload.mjs';

test('twenty clients really reach HTTP together and each route keeps its own complete latency population', {timeout:10000},async t=>{
 let active=0,peak=0,release,arrived;
 const gate=new Promise(resolve=>{release=resolve;}),firstWave=new Promise(resolve=>{arrived=resolve;});
 const server=createServer(async(req,res)=>{active++;peak=Math.max(peak,active);if(active===20)arrived();await gate;res.end(JSON.stringify({data:{route:req.url}}));active--;});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{release();server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const workload=createQueryWorkload({clients:20,targets:[{name:'overview',url:base+'/overview'},{name:'members',url:base+'/members'}]});
 t.after(()=>workload.stop());await firstWave;
 assert.equal(peak,20);assert.equal(workload.snapshot().active_requests,20);
 assert.equal(assessQuerySlo(workload.snapshot()).pass,false,'incomplete observations cannot pass');
 release();const until=Date.now()+5000;while(workload.snapshot().targets.some(row=>row.samples<20)&&Date.now()<until)await delay(10);
 await workload.stop();const result=workload.snapshot();
 assert.equal(result.active_requests,0);assert.equal(result.peak_active_requests,20);
 assert.equal(result.query_errors,0);assert.ok(result.clients.every(row=>row.completed>0));
 assert.equal(result.targets.reduce((sum,row)=>sum+row.samples,0),result.query_ok);
 for(const row of result.targets)assert.equal(row.histogram.reduce((sum,n)=>sum+n,0),row.samples);
 assert.equal(assessQuerySlo(result).pass,true);
 assert.equal(result.interval_ms,250);assert.ok(Number.isFinite(result.elapsed_ms));
 const completed=result.query_ok;await delay(30);assert.equal(workload.snapshot().query_ok,completed,'stop prevents further requests');assert.equal(workload.snapshot().elapsed_ms,result.elapsed_ms,'the measured run ends when clients finish');
});

test('HTTP errors, malformed data and timeouts stay failures and stop drains every request', {timeout:10000},async t=>{
 let received=0,arrived;const firstWave=new Promise(resolve=>{arrived=resolve;});
 const server=createServer((req,res)=>{received++;if(received===20)arrived();if(req.url==='/timeout')return;if(req.url==='/http'){res.statusCode=503;res.end();}else res.end(req.url==='/json'?'not-json':'{"data":null}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const workload=createQueryWorkload({clients:20,targets:['http','json','data','timeout'].map(name=>({name,url:base+'/'+name})),requestTimeoutMs:200,intervalMs:1000});
 t.after(()=>workload.stop());await firstWave;await workload.stop();const measured=workload.snapshot();
 assert.equal(measured.requests,20);assert.equal(measured.query_errors,20);assert.equal(measured.query_ok,0);assert.equal(measured.active_requests,0);
 assert.equal(measured.query_error_codes.http_503,5);assert.equal(measured.query_error_codes.invalid_response,5);assert.equal(measured.query_error_codes.request_failed,10);
 assert.equal(measured.targets.reduce((sum,row)=>sum+row.samples,0),20);assert.equal(assessQuerySlo(measured).pass,false);
});

test('a complete population of successful but slow HTTP queries fails the statistical latency budget', {timeout:10000},async t=>{
 let received=0,release,arrived;const gate=new Promise(resolve=>{release=resolve;}),firstWave=new Promise(resolve=>{arrived=resolve;});
 const server=createServer(async(_req,res)=>{received++;if(received===20)arrived();await gate;await delay(1600);res.end('{"data":{}}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{release();server.closeAllConnections();server.close();});
 const workload=createQueryWorkload({clients:20,targets:[{name:'overview',url:`http://127.0.0.1:${server.address().port}/`} ]});
 t.after(()=>workload.stop());await firstWave;const stopped=workload.stop();release();await stopped;
 const measured=workload.snapshot();assert.equal(measured.query_ok,20);assert.equal(measured.query_errors,0);assert.equal(measured.active_requests,0);
 assert.ok(measured.targets[0].p95_upper_bound_ms>1500);assert.equal(assessQuerySlo(measured).pass,false);
});

test('explicit query bursts run one request per client and never become automatic polling', {timeout:10000},async t=>{
 let received=0;const server=createServer((_req,res)=>{received++;res.end('{"data":{}}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const workload=createQueryWorkload({mode:'burst',clients:20,targets:[{name:'overview',url:`http://127.0.0.1:${server.address().port}/`}]});
 t.after(()=>workload.stop());assert.equal(workload.snapshot().requests,0);
 const first=workload.runBurst();await assert.rejects(workload.runBurst(),/already running/);await first;assert.equal(received,20);await delay(300);assert.equal(received,20);
 await workload.runBurst();assert.equal(received,40);await workload.stop();
 const measured=workload.snapshot();assert.equal(measured.mode,'burst');assert.equal(measured.interval_ms,null);assert.equal(measured.requests,40);assert.equal(measured.query_errors,0);assert.equal(measured.active_requests,0);
 assert.ok(measured.clients.every(client=>client.completed===2));assert.equal(assessQuerySlo(measured).pass,true);
 await assert.rejects(workload.runBurst(),/stopped/);
});
