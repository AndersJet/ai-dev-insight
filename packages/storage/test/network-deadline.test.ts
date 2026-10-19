import {test} from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {testDatabase,connectionString} from './helpers.js';import {openDatabase} from '../src/index.js';import {postgresFaultProxy} from './fixtures/pg-fault-proxy.js';

test('PostgreSQL reclaims abandoned idle transactions even if the URL disables its timeout',{timeout:22000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const url=new URL(connectionString);url.searchParams.set('idle_in_transaction_session_timeout','0');const db=openDatabase({connectionString:url.href,schema:baseline.schema,maxConnections:1});
 try{
  await assert.rejects(db.transaction(async client=>{
   await client.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'abandoned')");await delay(16000);return 'callback-returned';
  }),{code:'database_unavailable'});
  assert.equal((await baseline.query('SELECT count(*)::int AS count FROM departments')).rows[0]?.count,0);assert.equal((await db.query('SELECT 3 AS marker')).rows[0]?.marker,3);
 }finally{await db.close();}
});

test('a swallowed SQL failure cannot report a rolled-back transaction as committed',async t=>{
 const db=await testDatabase(t);await db.migrate();
 await assert.rejects(db.transaction(async client=>{
  await client.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'must-rollback')");
  try{await client.query('SELECT 1/0');}catch{return 'swallowed';}return 'unexpected';
 }),{code:'22012'});
 assert.equal((await db.query('SELECT count(*)::int AS count FROM departments')).rows[0]?.count,0);
});

test('disconnecting a checked-out transaction rejects safely and permits recovery',{timeout:15000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const proxy=await postgresFaultProxy(connectionString);const db=openDatabase({connectionString:proxy.connectionString,schema:baseline.schema,maxConnections:1});
 try{
  await assert.rejects(db.transaction(async client=>{
   await client.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'must-rollback')");proxy.disconnect();await delay(100);
   try{await client.query('SELECT 1');}catch{return 'swallowed';}return 'unexpected';
  }),{code:'database_unavailable'});
  assert.equal((await db.query('SELECT 3 AS marker')).rows[0]?.marker,3);assert.equal((await baseline.query('SELECT count(*)::int AS count FROM departments')).rows[0]?.count,0);
 }finally{await proxy.close();await db.close();}
});

test('a silent database response has a client deadline and recovery uses a fresh connection',{timeout:15000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const proxy=await postgresFaultProxy(connectionString);const url=new URL(proxy.connectionString);
 const db=openDatabase({connectionString:url.href,schema:baseline.schema,maxConnections:1});
 try{
  assert.equal((await db.query('SELECT 1 AS marker')).rows[0]?.marker,1);const initialConnections=proxy.snapshot().connections;
  proxy.setMode('drop-responses');const started=performance.now();const pending=db.query('SELECT 2 AS marker').then(()=>({kind:'resolved' as const}),error=>({kind:'rejected' as const,code:error.code as unknown}));
  const deadline=new AbortController();const result=await Promise.race([pending,delay(7500,{kind:'hung' as const},{signal:deadline.signal})]).finally(()=>deadline.abort());
  assert.equal(result.kind,'rejected','a live TCP socket with a lost reply must not occupy the pool indefinitely');if(result.kind==='rejected')assert.equal(result.code,'database_io_timeout');assert.ok(performance.now()-started<7200);assert.ok(proxy.snapshot().droppedBytes>0);
  proxy.setMode('healthy');assert.equal((await db.query('SELECT 3 AS marker')).rows[0]?.marker,3);assert.ok(proxy.snapshot().connections>initialConnections,'the uncertain connection must not be reused');
 }finally{await proxy.close();await db.close();}
});

test('a lost COMMIT reply stays uncertain even when PostgreSQL committed the write',{timeout:15000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const proxy=await postgresFaultProxy(connectionString);const db=openDatabase({connectionString:proxy.connectionString,schema:baseline.schema,maxConnections:1});
 try{
  await assert.rejects(db.transaction(async client=>{
   await client.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'committed-without-reply')");proxy.setMode('drop-responses');
  }),{code:'database_io_timeout'});
  assert.deepEqual((await baseline.query('SELECT name FROM departments')).rows.map(row=>row.name),['committed-without-reply']);
  proxy.setMode('healthy');assert.equal((await db.query('SELECT 3 AS marker')).rows[0]?.marker,3);
  assert.equal((await baseline.query('SELECT count(*)::int AS count FROM departments')).rows[0]?.count,1,'the adapter must never replay an uncertain transaction');
 }finally{await proxy.close();await db.close();}
});

test('a swallowed transaction read timeout cannot commit or retain a poisoned pool connection',{timeout:15000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const proxy=await postgresFaultProxy(connectionString);const url=new URL(proxy.connectionString);url.searchParams.set('query_timeout','60000');
 const db=openDatabase({connectionString:url.href,schema:baseline.schema,maxConnections:1});
 try{
  const started=performance.now();const pending=db.transaction(async client=>{
   proxy.setMode('drop-responses');try{await client.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'must-rollback')");}catch{return 'swallowed';}return 'unexpected';
  }).then(()=>({kind:'resolved' as const}),error=>({kind:'rejected' as const,code:error.code as unknown}));
  const deadline=new AbortController();const result=await Promise.race([pending,delay(7500,{kind:'hung' as const},{signal:deadline.signal})]).finally(()=>deadline.abort());
  assert.equal(result.kind,'rejected','timeouts must poison the whole transaction even when the callback catches them');if(result.kind==='rejected')assert.equal(result.code,'database_io_timeout');assert.ok(performance.now()-started<7200);
  proxy.setMode('healthy');await db.query("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'after-recovery')");assert.deepEqual((await baseline.query('SELECT name FROM departments ORDER BY name')).rows.map(row=>row.name),['after-recovery']);
 }finally{await proxy.close();await db.close();}
});
