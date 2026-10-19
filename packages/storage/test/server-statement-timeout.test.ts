import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,connectionString} from './helpers.js';
import {openDatabase,DatabaseIoTimeout} from '../src/index.js';

function serverTimeout(error:unknown){
 assert.ok(error instanceof DatabaseIoTimeout);assert.equal(error.code,'database_io_timeout');
 assert.ok(error.cause instanceof Error&&'code'in error.cause);assert.equal(error.cause.code,'57014');
 assert.match(error.cause.message,/statement timeout/);return true;
}

test('a real server statement deadline is a counted I/O timeout and direct queries discard the failed connection',{timeout:12000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();
 const db=openDatabase({connectionString,schema:baseline.schema,maxConnections:1});t.after(()=>db.close());
 const before=(await db.query<{pid:number;budget:string}>("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS budget")).rows[0]!;
 assert.equal(before.budget,'5s');
 await assert.rejects(db.query('SELECT pg_sleep(8)'),serverTimeout);
 assert.equal(db.health().readTimeouts,1);
 const after=(await db.query<{pid:number;budget:string}>("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS budget")).rows[0]!;
 assert.notEqual(after.pid,before.pid);assert.equal(after.budget,'5s');
 assert.equal(db.health().readTimeouts,1,'recovering the pool must not count the same timeout again');
});

test('a caught server deadline poisons the entire transaction, rolls back writes and cannot be reused',{timeout:12000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();await baseline.query('CREATE TABLE statement_timeout_probe(id integer PRIMARY KEY)');
 const db=openDatabase({connectionString,schema:baseline.schema,maxConnections:1});t.after(()=>db.close());
 const before=(await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await assert.rejects(db.transaction(async client=>{
  await client.query('INSERT INTO statement_timeout_probe VALUES(1)');
  let caught:unknown;
  try{await client.query('SELECT pg_sleep(8)');}catch(error){caught=error;serverTimeout(error);}
  assert.ok(caught);await assert.rejects(client.query('SELECT 1'),error=>error===caught);
  return 'a swallowed timeout must not commit';
 }),serverTimeout);
 assert.equal(db.health().readTimeouts,1);
 const after=(await db.query<{pid:number;rows:number;budget:string}>("SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM statement_timeout_probe) AS rows,current_setting('statement_timeout') AS budget")).rows[0]!;
 assert.notEqual(after.pid,before);assert.equal(after.rows,0);assert.equal(after.budget,'5s');assert.equal(db.health().readTimeouts,1);
});
