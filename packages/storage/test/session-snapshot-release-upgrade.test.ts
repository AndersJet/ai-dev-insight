import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseIntoClientConfig } from 'pg-connection-string';
import { testDatabase, connectionString, migrationPrefix } from './helpers.js';
import { migrateDatabase } from '../src/migrate.js';

const generated = "CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END";
const snapshotPrefix = '20261010000';
const expectedNewMigrations = [
  '202610100001_session_list_snapshots',
  '202610100002_snapshot_safety_and_prompt_search',
  '202610100003_snapshot_normalized_prompt_search',
  '202610100004_snapshot_publication_tie_order',
  '202610100005_snapshot_literal_prompt_grams',
];
// Exact published origin/main/MERGE_HEAD b2b354cd3a51578d37a7bf1af7376dde9cb16af3.
// Pin both names and bytes: a convenient local subset is not proof of a real
// release upgrade, and the two plugin migrations belong to this prefix.
const publishedMainPrefix = [
  { name: '202609270001_initial', checksum: '6c9f2c14ddfaee08f37d701cc186dc995da2d69ef78db11854574bcf0cc89c71' },
  { name: '202609280001_registration_adoption', checksum: '449ae84e3df7c3bfcf9292b2631d7d2a25587d573dc52a4564aaf21ce421df45' },
  { name: '202609280002_remove_registration_verification', checksum: '27af3c60e9b7aee612e9608f92c7dbf50cae360e1a2a8e1b569fcf74ad78e8e2' },
  { name: '202609280003_account_collection_credentials', checksum: '9d41de1384aa922f282ba201c6e5ca7cfcf92cd9823a37107cc109ba1d253f80' },
  { name: '202609290001_usage_content_activity', checksum: '3a4ff5b695e17053d7cbbff4a2dd1b3e35c3e4a5ab6bed06191e09f4ca6c438b' },
  { name: '202609290002_usage_identity_lookup', checksum: '04416da6640e51c24cbab4f0c82eaaa51f5a2c974758db173b0a503e8f387925' },
  { name: '202609290003_usage_model_checks', checksum: '6db77415219ba5b9492d374463573939932fd1ab00580144ca04fd930e10c508' },
  { name: '202609290004_session_tool_lookup', checksum: 'e6121a4220fe742416e78bef2dd39d26028a4c55ce249645a5f7012fabbb8042' },
  { name: '202609290005_session_simulation_cache', checksum: 'cf3c9649385edc36b577713494d1bdcbe46d5e0ef62477620a875abf772519b8' },
  { name: '202609290006_session_token_checks', checksum: '27193a27334d272223d0be87786b3179b675ba685a726d4da9f68fc909d6136a' },
  { name: '202609300001_repository_allowlist', checksum: '920d48c6823b9eb64b9baf286f367f1fc36da24081edd334447cf7633d9f78a5' },
  { name: '202609300002_project_observations', checksum: '29530b8f0c89e172bf63467a98f96e69ea724fcddc86f256c690b1608252de1f' },
  { name: '202609300003_project_cleanup_proofs', checksum: '4a782726198b22038d0c1e7d4c819c692ce772f8c21299f3979c4c8511eba5f4' },
  { name: '202610030001_session_usage_queries', checksum: 'cffe5fe87fe54a4c2e0ada83f7be4af5c585ba85f385460c2ac7642d6bdfb2b9' },
  { name: '202610040001_plugin_project_observations', checksum: 'e83a0889f49ef7f5815065d2c00506071ba894728bc017af5e5a94ac59eddcba' },
  { name: '202610090001_plugin_account_credentials', checksum: 'dc69e22e9f7bb8d79b5d7eeee348459850f9ff82e6ee6ee61cd004645d549106' },
  { name: '202610090002_unified_project_observations', checksum: '1c85840bf50370c5b26ef56756f6d73848bd837d48207b7a134e91996066dede' },
];
const rawFacts = `SELECT id::text,(extract(epoch FROM occurred_at)*1000000)::bigint::text AS at_us,
  user_id::text,installation_id::text,session_id::text,event_type,payload
  FROM hook_events ORDER BY occurred_at,id`;

test('released-baseline upgrade reuses native prebuilds, preserves facts and ledger, and equips new partitions', async t => {
  const db = await testDatabase(t);
  const directory = await migrationPrefix(t, publishedMainPrefix.at(-1)!.name);
  const source = new URL('../migrations/', import.meta.url);
  const currentFiles = (await readdir(source)).filter(file => file.endsWith('.sql')).sort();
  const currentNames = currentFiles.map(file => file.slice(0, -4));
  const appendedMigrations = currentNames.slice(publishedMainPrefix.length);
  assert.deepEqual(appendedMigrations.slice(0, expectedNewMigrations.length), expectedNewMigrations,
    'the snapshot migrations must append directly after the exact published prefix');
  const finalFiles = currentFiles.filter(file => file.startsWith(snapshotPrefix));
  assert.deepEqual(finalFiles.map(file => file.slice(0, -4)), expectedNewMigrations,
    'the snapshot release must not create or retire the rejected experimental GIN');
  for (const file of finalFiles) {
    assert.ok(!(await readFile(new URL(file, source), 'utf8')).includes('hook_prompt_literal_trgm'),
      'the final migration chain must not construct an unused experimental index');
  }
  const publishedFiles = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  assert.deepEqual(publishedFiles.map(file => file.slice(0, -4)), publishedMainPrefix.map(row => row.name),
    'the pre-upgrade directory must be the exact seventeen published main migrations, including both plugin migrations');
  const publishedBytes = await Promise.all(publishedFiles.map(async file => ({
    name: file.slice(0, -4), checksum: createHash('sha256').update(await readFile(join(directory, file))).digest('hex'),
  })));
  assert.deepEqual(publishedBytes, publishedMainPrefix, 'published main SQL must keep its original bytes and checksums');
  // Normal migration establishes the genuine released prefix. No ledger insert,
  // checksum edit or copy from an experimental capacity schema is permitted.
  await migrateDatabase(parseIntoClientConfig(connectionString), db.schema, directory);
  const previousLedger = (await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c ON c.name=m.name ORDER BY m.id')).rows;
  assert.deepEqual(previousLedger, publishedMainPrefix, 'normal migration must record the genuine published main prefix without editing its ledger');
  assert.ok(previousLedger.every(row => !row.name.startsWith(snapshotPrefix)));
  const now = new Date();
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 2));
  await db.ensurePartitions(previousMonth, new Date(previousMonth.getTime() + 60000));
  const user = randomUUID(), installation = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',
    [user, `release-${user}@example.invalid`, 'Native release upgrade synthetic']);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',
    [installation, user, 'a'.repeat(64), 'Synthetic release install']);
  for (const [index, payload] of [{ prompt: 'ABC İA %_\\ 中文🙂' }, {}, { prompt: 'Stop stays NULL' }].entries()) {
    const occurredAt = previousMonth.toISOString().slice(0, 19) + '.' + String(123456 + index).padStart(6, '0') + 'Z';
    const saved = await db.ingest({ schema_version: 2, installation_id: installation,
      client_event_id: `before-release-${index}`, source_session_id: 'preserved-upgrade-session',
      event_type: index === 2 ? 'Stop' : 'UserPromptSubmit', occurred_at: occurredAt, payload },
    { admissionEpoch: 1, receivedAt: now });
    assert.equal(saved.outcome, 'committed');
  }
  const before = (await db.query(rawFacts)).rows;
  assert.equal(before.length, 3);
  assert.ok(before.every(row => !row.at_us.endsWith('000')));
  // Small isolated prebuilds verify the normal bounded migration's reuse path.
  // They do not claim a large populated production rewrite meets five seconds.
  await db.query(`ALTER TABLE hook_events ADD COLUMN prompt_search text GENERATED ALWAYS AS (${generated}) STORED`);
  await db.query("CREATE INDEX hook_prompt_trgm ON hook_events USING gin ((payload->>'prompt') public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'");
  await db.query("CREATE INDEX hook_prompt_search_trgm ON hook_events USING gin (prompt_search public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'");
  const indexIds = (await db.query("SELECT 'hook_prompt_trgm'::regclass::oid AS raw,'hook_prompt_search_trgm'::regclass::oid AS normalized")).rows[0];
  await db.migrate();
  assert.deepEqual((await db.query(rawFacts)).rows, before, 'exact UUID, timestamp microseconds and raw facts must survive the upgrade');
  assert.deepEqual((await db.query("SELECT 'hook_prompt_trgm'::regclass::oid AS raw,'hook_prompt_search_trgm'::regclass::oid AS normalized")).rows[0], indexIds,
    'normal migrations must reuse both exact administrative prebuilds');
  const ledger = (await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c ON c.name=m.name ORDER BY m.id')).rows;
  assert.deepEqual(ledger.slice(0, previousLedger.length), previousLedger, 'released checksums and order remain unchanged');
  assert.deepEqual(ledger.slice(previousLedger.length).map(row => row.name), appendedMigrations);
  await db.migrate();
  assert.deepEqual((await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c ON c.name=m.name ORDER BY m.id')).rows, ledger);

  // Normal ensurePartitions after the upgrade must inherit generated text and
  // all attached indexes, and real ingest must fill the new partition.
  await db.ensurePartitions(now, new Date(now.getTime() + 1000));
  const after = await db.ingest({ schema_version: 2, installation_id: installation,
    client_event_id: 'after-release-current-partition', source_session_id: 'new-partition-session',
    event_type: 'UserPromptSubmit', occurred_at: now.toISOString(), payload: { prompt: 'Current ABC 中文🙂' } },
  { admissionEpoch: 1, receivedAt: now });
  assert.equal(after.outcome, 'committed');
  if (after.outcome !== 'committed') throw new Error('Synthetic post-upgrade ingest did not commit');
  assert.equal((await db.query('SELECT prompt_search FROM hook_events WHERE id=$1', [after.eventId])).rows[0]!.prompt_search, 'current abc 中文🙂');
  const columns = (await db.query<{ relid: string; stored: string; exact: boolean }>(`
    SELECT p.relid::text,a.attgenerated AS stored,
      regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[[:space:]]','','g')=$1 AS exact
    FROM pg_partition_tree('hook_events') p JOIN pg_attribute a ON a.attrelid=p.relid AND a.attname='prompt_search'
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  `, ["CASEWHEN(event_type='UserPromptSubmit'::text)THENlower((payload->>'prompt'::text))ELSENULL::textEND"])).rows;
  assert.ok(columns.length >= 3, 'parent, pre-upgrade partition and newly created partition must be checked');
  assert.ok(columns.every(column => column.stored === 's' && column.exact));
  const leaves = (await db.query<{ relid: string }>("SELECT relid::oid::text AS relid FROM pg_partition_tree('hook_events') WHERE isleaf ORDER BY relid::oid")).rows;
  for (const name of ['hook_prompt_trgm', 'hook_prompt_search_trgm', 'hook_prompt_literal_grams']) {
    const indexes = (await db.query<{ relid: string; valid: boolean; ready: boolean; live: boolean }>(`
      SELECT i.indrelid::text AS relid,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live
      FROM pg_partition_tree($1::regclass) p JOIN pg_index i ON i.indexrelid=p.relid
      WHERE p.isleaf ORDER BY i.indrelid
    `, [name])).rows;
    assert.deepEqual(indexes.map(index => ({ relid: index.relid })), leaves, `${name} must cover every physical table leaf`);
    assert.ok(indexes.every(index => index.valid && index.ready && index.live));
  }
  assert.equal((await db.query("SELECT to_regclass('hook_prompt_literal_trgm') AS experimental")).rows[0]!.experimental, null);
  t.diagnostic('Exact published main b2b354cd seventeen-migration prefix (including both plugin migrations) and appended snapshot plus later migrations succeeded under ordinary deadlines; prebuild OIDs and all published checksums reused, raw UUID/microseconds preserved, newly created partition inherits generated text and all three attached GINs.');
});
