import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import type {AddressInfo} from 'node:net';
import {testDatabase} from '../../../storage/test/helpers.js';import {createDatabaseMonitor} from '../../src/database-monitor.js';import {createMonitorDelivery} from '../../src/monitor-delivery.js';
test('configured monitor webhook delivers only transition metadata and does not resend a confirmed event',async t=>{
 const db=await testDatabase(t);await db.migrate();const received:{body:string;key:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));received.push({body:Buffer.concat(chunks).toString(),key:req.headers['idempotency-key'] as string|undefined});res.end('ok');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const delivery=createMonitorDelivery(db,{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/alerts`});
 const monitor=createDatabaseMonitor(db,{storageBudgetBytes:'1',deliveryTarget:delivery.target});await monitor.runOne();assert.equal(await delivery.runOne(),true);assert.equal(await delivery.runOne(),false);assert.equal(received.length,1);assert.equal(JSON.parse(received[0]!.body).alert.severity,'critical');assert.equal(received[0]!.key,JSON.parse(received[0]!.body).event_id);assert.equal((await monitor.read()).events[0]?.status,'sent');assert.doesNotMatch(received[0]!.body,/postgres:|password|token|email|prompt/);
});

test('an uncertain webhook reply is retried with the same idempotency key and a changed target cannot receive old events',async t=>{
 const db=await testDatabase(t);await db.migrate();const ids:string[]=[];let lose=true;
 const server=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}ids.push(String(req.headers['idempotency-key']));if(lose){req.socket.destroy();return;}res.end('ok');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/alerts`,delivery=createMonitorDelivery(db,{url}),monitor=createDatabaseMonitor(db,{storageBudgetBytes:'1',deliveryTarget:delivery.target});await monitor.runOne();await delivery.runOne();assert.equal((await monitor.read()).events[0]?.status,'queued');assert.equal((await monitor.read()).events[0]?.last_error,'webhook_delivery_unconfirmed');assert.equal(await delivery.runOne(),false);
 await db.query("UPDATE monitor_alert_events SET available_at='1970-01-01Z'");assert.equal(await createMonitorDelivery(db,{url:url+'-changed'}).runOne(),false);lose=false;const results=await Promise.all([delivery.runOne(),createMonitorDelivery(db,{url}).runOne()]);assert.equal(results.filter(Boolean).length,1);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal((await monitor.read()).events[0]?.status,'sent');
 assert.throws(()=>createMonitorDelivery(db,{url:'http://example.invalid/alerts'}));assert.throws(()=>createMonitorDelivery(db,{url:'https://user:password@example.invalid/alerts'}));
});

import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createCleanupJournal} from '../../../storage/src/cleanup-journal.js';import {createRecoveryService} from '../../src/recovery.js';
test('quarantine invalidates pending pre-restore alerts but preserves their delivery history',async t=>{
 const db=await testDatabase(t);await db.migrate();const directory=await mkdtemp(join(tmpdir(),'adi-monitor-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));const delivery=createMonitorDelivery(db,{url:'https://example.invalid/never-called'}),monitor=createDatabaseMonitor(db,{storageBudgetBytes:'1',deliveryTarget:delivery.target});await monitor.runOne();assert.equal((await monitor.read()).events[0]?.status,'queued');
 const dataset=(await db.query('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;await createRecoveryService(db,createCleanupJournal(directory)).quarantine(dataset);assert.equal((await monitor.read()).events[0]?.status,'cancelled');assert.equal((await monitor.read()).state,'degraded');await assert.rejects(delivery.runOne(),{code:'recovery_quarantined'});
});

test('a silent alert endpoint has a bounded deadline and leaves an explicit unconfirmed retry',async t=>{
 const db=await testDatabase(t);await db.migrate();const server=createServer(async req=>{for await(const chunk of req){void chunk;}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const delivery=createMonitorDelivery(db,{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/silent`}),monitor=createDatabaseMonitor(db,{storageBudgetBytes:'1',deliveryTarget:delivery.target});await monitor.runOne();const started=Date.now();await delivery.runOne();assert.ok(Date.now()-started<5000);const event=(await monitor.read()).events[0]!;assert.equal(event.status,'queued');assert.equal(event.last_error,'webhook_delivery_unconfirmed');
});
