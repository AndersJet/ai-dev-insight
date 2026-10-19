import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createDatabaseMonitor} from '../../src/database-monitor.js';

test('database monitoring persists schema-only estimates and never claims exact reclaimable bytes',async t=>{
 const db=await testDatabase(t);await db.migrate();
 const monitor=createDatabaseMonitor(db);assert.equal((await monitor.read()).state,'unobserved');
 await db.query('CREATE TABLE monitor_fixture(body text) WITH(autovacuum_enabled=false)');
 await db.query("INSERT INTO monitor_fixture SELECT 'PRIVATE_BODY_'||g FROM generate_series(1,1000) g");
 await db.query('ANALYZE monitor_fixture');
 assert.equal(await monitor.runOne(),true);assert.equal(await monitor.runOne(),false);
 const status=await monitor.read();assert.equal(status.state,'observed');assert.equal(status.observation?.source,'postgres_catalog_estimates');assert.equal(status.observation?.bloat_bytes,null);
 assert.ok(BigInt(status.observation!.schema_bytes)>0n);
 const row=status.observation!.tables.find(row=>row.table==='monitor_fixture');assert.ok(row);assert.equal(row.autovacuum_enabled,false);assert.ok(BigInt(row.live_estimate!)>=1000n);
 assert.doesNotMatch(JSON.stringify(status),/PRIVATE_BODY_|password|connectionString/);
});

test('monitoring records alert transitions without duplicates and retains the last observation on failure',async t=>{
 const db=await testDatabase(t);await db.migrate();const low=createDatabaseMonitor(db,{storageBudgetBytes:'1'});
 await low.runOne();let status=await low.read();assert.equal(status.alerts.find(item=>item.key==='storage_budget')?.severity,'critical');
 await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");await low.runOne();assert.equal((await low.read()).events.length,1);
 await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");const high=createDatabaseMonitor(db,{storageBudgetBytes:'999999999999999'});await high.runOne();status=await high.read();assert.equal(status.alerts.length,0);assert.equal(status.events[0]?.severity,'resolved');
 await db.query("UPDATE database_monitor_state SET observed_at=clock_timestamp()-interval '5 minutes'");assert.equal((await high.read()).state,'stale');
});

test('a failed sample keeps the last successful observation and reports degradation until a later success',async t=>{
 const db=await testDatabase(t);await db.migrate();const monitor=createDatabaseMonitor(db);await monitor.runOne();const before=(await monitor.read()).observation;
 await db.query("CREATE FUNCTION fail_monitor_sample() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$");await db.query('CREATE TRIGGER fail_monitor BEFORE UPDATE ON database_monitor_state FOR EACH ROW EXECUTE FUNCTION fail_monitor_sample()');await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");
 await assert.rejects(monitor.runOne());const failed=await monitor.read();assert.equal(failed.state,'degraded');assert.deepEqual(failed.observation,before);assert.equal(failed.last_error,'monitor_sample_failed');assert.equal(await monitor.runOne(),false);
 await db.query('DROP TRIGGER fail_monitor ON database_monitor_state');await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");await monitor.runOne();assert.equal((await monitor.read()).state,'observed');
});

test('removing a budget makes its previous alert unknown rather than falsely recovered',async t=>{
 const db=await testDatabase(t);await db.migrate();await createDatabaseMonitor(db,{storageBudgetBytes:'1'}).runOne();await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");const monitor=createDatabaseMonitor(db);await monitor.runOne();let status=await monitor.read();assert.equal(status.alerts.find(item=>item.key==='storage_budget')?.severity,'unknown');assert.equal(status.events[0]?.severity,'unknown');
 await db.query("UPDATE database_monitor_state SET next_run_at='1970-01-01Z'");await monitor.runOne();status=await monitor.read();assert.equal(status.events.length,2);
});

test('disabled row statistics keep a prior dead-tuple condition unknown rather than resolved',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.query("INSERT INTO monitor_alerts(key,severity,subject,value) VALUES('dead_tuple_backlog:users','warning','users','10000')");
 await db.query('SET track_counts TO off');const monitor=createDatabaseMonitor(db);await monitor.runOne();const status=await monitor.read();assert.equal(status.observation?.track_counts,false);assert.ok(status.observation?.tables.every(row=>row.dead_estimate===null));assert.equal(status.alerts.find(row=>row.key==='dead_tuple_backlog:users')?.severity,'unknown');assert.equal(status.events.some(row=>row.key==='dead_tuple_backlog:users'&&row.severity==='resolved'),false);
});

test('bounded alert lists retain critical conditions ahead of warning rows and expose the full count',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.query("INSERT INTO monitor_alerts(key,severity) SELECT 'autovacuum_disabled:fixture_'||g,'warning' FROM generate_series(1,100) g");await db.query("INSERT INTO monitor_alerts(key,severity,value) VALUES('storage_budget','critical','95')");const status=await createDatabaseMonitor(db).read();assert.equal(status.alerts.length,100);assert.equal(status.alerts_total,101);assert.equal(status.alerts[0]?.key,'storage_budget');
});
