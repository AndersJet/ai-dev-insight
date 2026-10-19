import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const {Client}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('pg');
const connectionString=process.env.ADI_TEST_DATABASE_URL??'postgres://adi_test:adi_test_local_only@127.0.0.1:55438/adi_test';
const url=new URL(connectionString),local=['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='55438',ci=process.env.CI==='true'&&url.hostname==='postgres-test'&&url.port==='5432';
assert.ok((local||ci)&&url.username==='adi_test'&&url.pathname==='/adi_test'&&!url.search&&!url.hash,'Only the isolated synthetic adi_test administrator is allowed');
const client=new Client({connectionString,connectionTimeoutMillis:2000,statement_timeout:5000,query_timeout:6000});
try{await client.connect();await client.query(await readFile(new URL('../packages/storage/test/extensions.sql',import.meta.url),'utf8'));console.log('Synthetic public extensions ready: btree_gist, pg_trgm');}finally{await client.end();}
