import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';

test('facts enter their occurrence month and bounded queries prune unrelated partitions', async t => {
  const db = await testDatabase(t); await db.migrate();
  await db.ensurePartitions(new Date('2026-08-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const user = randomUUID(); const installation = randomUUID(); const session = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [user, 'partition@example.invalid', '分区测试']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, user, 'a'.repeat(64), '测试设备']);
  await db.query('INSERT INTO sessions(id,user_id,source_session_id,first_at,last_at) VALUES($1,$2,$3,$4,$4)', [session, user, 'cross-month', '2026-08-31T23:59:00Z']);
  for (const [key, at] of [['august', '2026-08-31T23:59:00Z'], ['september', '2026-09-01T00:00:00Z']]) {
    await db.query('INSERT INTO hook_events(id,occurred_at,user_id,installation_id,session_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), at, user, installation, session, 'UserPromptSubmit', { key }]);
  }
  const rows = await db.query<{ partition: string }>('SELECT tableoid::regclass::text AS partition FROM hook_events ORDER BY occurred_at');
  assert.ok(rows.rows[0]?.partition.endsWith('hook_events_202608')); assert.ok(rows.rows[1]?.partition.endsWith('hook_events_202609'));
  const explain = await db.query('EXPLAIN (FORMAT JSON) SELECT id FROM hook_events WHERE occurred_at >= $1 AND occurred_at < $2', ['2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z']);
  const plan = JSON.stringify(explain.rows);
  assert.ok(plan.includes('hook_events_202609')); assert.ok(!plan.includes('hook_events_202608'));
});
