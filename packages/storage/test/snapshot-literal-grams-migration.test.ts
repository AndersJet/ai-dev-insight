import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIntoClientConfig } from 'pg-connection-string';
import { testDatabase, connectionString, migrationPrefix } from './helpers.js';
import { migrateDatabase } from '../src/migrate.js';
import { createCleanupJournal } from '../src/cleanup-journal.js';
import { createIdentityService } from '../../domain/src/identity.js';
import { createCleanupService } from '../../domain/src/cleanup.js';

const file = '202610100005_snapshot_literal_prompt_grams.sql';
const version = file.slice(0, -4);
const sql = await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8');
const body = sql.match(/\$grams\$([\s\S]*?)\$grams\$/)?.[1];
assert.equal(typeof body, 'string');
const functionSql = 'CREATE FUNCTION hook_prompt_codepoint_grams(l pg_catalog.text) RETURNS pg_catalog.int8[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $grams$' + body + '$grams$';
const indexSql = "CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin(hook_prompt_codepoint_grams(prompt_search) pg_catalog.array_ops) WHERE event_type='UserPromptSubmit'";
type Db = Awaited<ReturnType<typeof testDatabase>>;

async function beforeLiteral(t: TestContext) {
  const db = await testDatabase(t), directory = await migrationPrefix(t, '202610100004_snapshot_publication_tie_order');
  await migrateDatabase(parseIntoClientConfig(connectionString), db.schema, directory);
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-11-01Z'));
  return db;
}
async function ledger(db: Db) {
  return (await db.query('SELECT m.name,c.checksum FROM pgmigrations m JOIN migration_checksums c ON c.name=m.name ORDER BY m.id')).rows;
}
async function absentVersion(db: Db) {
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM pgmigrations WHERE name=$1', [version])).rows[0]!.n, 0);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM migration_checksums WHERE name=$1', [version])).rows[0]!.n, 0);
}
async function ids(db: Db) {
  return (await db.query("SELECT 'hook_prompt_codepoint_grams(text)'::regprocedure::oid AS fn,'hook_prompt_literal_grams'::regclass::oid AS idx")).rows[0]!;
}
async function verifyFamily(db: Db) {
  const rows = (await db.query(`SELECT part.relid::oid AS id,i.indrelid::oid AS table_id,part.isleaf,
    i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indnkeyatts AS keys,i.indnatts AS attributes,
    i.indcollation[0]::integer AS collation,key_attr.atttypid::regtype::text AS key_type,key_attr.attcollation::integer AS key_collation,
    am.amname AS method,op.opcname AS opclass,ns.nspname AS op_schema,
    pg_get_expr(i.indexprs,i.indrelid) AS expression,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    EXISTS(SELECT 1 FROM pg_depend dep WHERE dep.classid='pg_class'::regclass AND dep.objid=i.indexrelid
      AND dep.refclassid='pg_proc'::regclass AND dep.refobjid='hook_prompt_codepoint_grams(text)'::regprocedure AND dep.deptype='n') AS function_bound
    FROM pg_partition_tree('hook_prompt_literal_grams'::regclass) part JOIN pg_index i ON i.indexrelid=part.relid
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    JOIN pg_opclass op ON op.oid=i.indclass[0] JOIN pg_namespace ns ON ns.oid=op.opcnamespace
    JOIN pg_attribute key_attr ON key_attr.attrelid=i.indexrelid AND key_attr.attnum=1 ORDER BY part.relid`)).rows;
  const tables = (await db.query("SELECT relid::oid AS id FROM pg_partition_tree('hook_events'::regclass) ORDER BY relid")).rows;
  assert.deepEqual(rows.map(row => row.table_id).sort((a, b) => a - b), tables.map(row => row.id).sort((a, b) => a - b));
  assert.ok(rows.every(row => row.valid && row.ready && row.live && row.keys === 1 && row.attributes === 1 &&
    row.collation === 0 && row.key_type === 'bigint' && row.key_collation === 0 && row.method === 'gin' &&
    row.opclass === 'array_ops' && row.op_schema === 'pg_catalog' && row.function_bound &&
    row.expression === 'hook_prompt_codepoint_grams(prompt_search)' && row.predicate === "(event_type = 'UserPromptSubmit'::text)"));
  return rows;
}
function expectedGrams(value: string | null) {
  if (value === null) return null;
  const points = Array.from(value, character => BigInt(character.codePointAt(0)!)), grams = new Set<bigint>();
  for (let index = 0; index + 2 < points.length; index++) grams.add(points[index]! * 4398046511104n + points[index + 1]! * 2097152n + points[index + 2]!);
  return [...grams].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(String);
}

test('fresh literal grams migration keeps bounded settings and exact Unicode windows on every new partition', async t => {
  const db = await testDatabase(t);
  await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-11-01Z'));
  await verifyFamily(db);
  const fn = (await db.query(`SELECT l.lanname,p.provolatile,p.proparallel,p.proisstrict,p.prosecdef,p.proretset,
    p.proargtypes[0]::regtype::text AS input,p.prorettype::regtype::text AS output,p.proconfig,p.prosrc
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='hook_prompt_codepoint_grams(text)'::regprocedure`)).rows[0]!;
  assert.deepEqual(fn, { lanname: 'sql', provolatile: 'i', proparallel: 's', proisstrict: true, prosecdef: false, proretset: false,
    input: 'text', output: 'bigint[]', proconfig: ['search_path=pg_catalog'], prosrc: body });
  await db.query("CREATE FUNCTION ascii(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 0'");
  for (const value of [null, '', 'a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abc\ndef', 'ab\rcd', 'e\u0301猫😀', '😀汉\n字🙂', 'a % _ \\ b', '汉字🙂', '\u{10ffff}\u{10ffff}\u{10ffff}', '🙂🙂🙂', '汉字汉字']) {
    assert.deepEqual((await db.query('SELECT hook_prompt_codepoint_grams($1::text) AS grams', [value])).rows[0]!.grams, expectedGrams(value));
  }
  assert.equal((await db.query("SELECT current_setting('statement_timeout') AS deadline")).rows[0]!.deadline, '5s');
  const original = await ledger(db);
  await db.migrate();
  assert.deepEqual(await ledger(db), original);
  assert.ok(original.some(row => row.name === version));
  assert.equal((await db.query("SELECT to_regclass('hook_prompt_trgm') IS NOT NULL AND to_regclass('hook_prompt_search_trgm') IS NOT NULL AS retained")).rows[0]!.retained, true);
});

test('normal bounded migration reuses the exact administrator-prebuilt function and attached index OIDs', async t => {
  const db = await beforeLiteral(t), oldLedger = await ledger(db);
  await db.query(functionSql);
  await db.query(indexSql);
  const before = await ids(db);
  await db.migrate();
  assert.deepEqual(await ids(db), before);
  await verifyFamily(db);
  const after = await ledger(db);
  assert.deepEqual(after.slice(0, oldLedger.length), oldLedger, 'versions one through four keep their existing checksums');
  assert.equal(after[oldLedger.length]?.name, version);
  await db.migrate();
  assert.deepEqual(await ids(db), before);
  assert.deepEqual(await ledger(db), after);
});

for (const [kind, change] of [
  ['volatile', 'VOLATILE'], ['not strict', 'CALLED ON NULL INPUT'], ['parallel unsafe', 'PARALLEL UNSAFE'],
  ['security definer', 'SECURITY DEFINER'], ['unsafe search path', 'SET search_path=pg_catalog,public'], ['different planner cost', 'COST 1000'],
] as const) test('a prebuilt ' + kind + ' grams function is rejected without replacement', async t => {
  const db = await beforeLiteral(t);
  await db.query(functionSql);
  await db.query(indexSql);
  await db.query('ALTER FUNCTION hook_prompt_codepoint_grams(text) ' + change);
  const indexedBefore = await ids(db);
  const before = (await db.query("SELECT p.oid,p.prosrc,p.provolatile,p.proisstrict,p.proparallel,p.prosecdef,p.proconfig FROM pg_proc p WHERE p.oid='hook_prompt_codepoint_grams(text)'::regprocedure")).rows[0];
  await assert.rejects(db.migrate(), { code: '55000' });
  await absentVersion(db);
  assert.deepEqual((await db.query("SELECT p.oid,p.prosrc,p.provolatile,p.proisstrict,p.proparallel,p.prosecdef,p.proconfig FROM pg_proc p WHERE p.oid='hook_prompt_codepoint_grams(text)'::regprocedure")).rows[0], before);
  assert.deepEqual(await ids(db), indexedBefore, 'a rejected indexed function is never repaired or rebuilt');
});

for (const [kind, definition] of [
  ['wrong body', "CREATE FUNCTION hook_prompt_codepoint_grams(l text) RETURNS bigint[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS 'SELECT ARRAY[]::bigint[]'"],
  ['wrong result type', "CREATE FUNCTION hook_prompt_codepoint_grams(l text) RETURNS integer[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS 'SELECT ARRAY[]::integer[]'"],
  ['wrong input type', "CREATE FUNCTION hook_prompt_codepoint_grams(l bytea) RETURNS bigint[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS 'SELECT ARRAY[]::bigint[]'"],
] as const) test('a prebuilt grams function with ' + kind + ' cannot impersonate the exact definition', async t => {
  const db = await beforeLiteral(t);
  await db.query(definition);
  if (kind !== 'wrong input type') await db.query(indexSql);
  const prebuiltIndex = (await db.query("SELECT to_regclass('hook_prompt_literal_grams')::oid AS idx")).rows[0];
  const before = (await db.query("SELECT oid,prosrc,proargtypes,prorettype FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='hook_prompt_codepoint_grams'")).rows;
  await assert.rejects(db.migrate(), { code: '55000' });
  await absentVersion(db);
  assert.deepEqual((await db.query("SELECT oid,prosrc,proargtypes,prorettype FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='hook_prompt_codepoint_grams'")).rows, before);
  assert.deepEqual((await db.query("SELECT to_regclass('hook_prompt_literal_grams')::oid AS idx")).rows[0], prebuiltIndex);
});

for (const [kind, definition] of [
  ['btree', "CREATE INDEX hook_prompt_literal_grams ON hook_events(hook_prompt_codepoint_grams(prompt_search)) WHERE event_type='UserPromptSubmit'"],
  ['integer-array storage key', "CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin((hook_prompt_codepoint_grams(prompt_search)::integer[]) pg_catalog.array_ops) WHERE event_type='UserPromptSubmit'"],
  ['text/trigram opclass', "CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin(prompt_search public.gin_trgm_ops) WHERE event_type='UserPromptSubmit'"],
  ['other expression', "CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin(hook_prompt_codepoint_grams(lower(payload->>'prompt')) pg_catalog.array_ops) WHERE event_type='UserPromptSubmit'"],
  ['space inside predicate literal', "CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin(hook_prompt_codepoint_grams(prompt_search) pg_catalog.array_ops) WHERE event_type='User PromptSubmit'"],
  ['missing predicate', 'CREATE INDEX hook_prompt_literal_grams ON hook_events USING gin(hook_prompt_codepoint_grams(prompt_search) pg_catalog.array_ops)'],
  ['incomplete partition coverage', "CREATE INDEX hook_prompt_literal_grams ON ONLY hook_events USING gin(hook_prompt_codepoint_grams(prompt_search) pg_catalog.array_ops) WHERE event_type='UserPromptSubmit'"],
] as const) test('a prebuilt ' + kind + ' index is rejected without rebuilding the function', async t => {
  const db = await beforeLiteral(t);
  await db.query(functionSql);
  await db.query(definition);
  const before = await ids(db);
  await assert.rejects(db.migrate(), { code: '55000' });
  await absentVersion(db);
  assert.deepEqual(await ids(db), before);
  await db.query('DROP INDEX hook_prompt_literal_grams');
  await db.migrate();
  assert.equal((await ids(db)).fn, before.fn);
  await verifyFamily(db);
});

for (const [kind, setup, expression] of [
  ['substituted projection', null, "lower(payload->>'prompt')"],
  ['space inside payload key', null, "CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'pro mpt') END"],
  ['schema lower shadow', "CREATE FUNCTION lower(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT pg_catalog.upper($1)'", "CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END"],
  ['schema extraction operator shadow', 'CREATE OPERATOR ->> (LEFTARG=pg_catalog.jsonb,RIGHTARG=pg_catalog.text,FUNCTION=pg_catalog.jsonb_object_field_text)', "CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END"],
] as const) test('a leaf with ' + kind + ' is rejected beneath the exact prebuilt index', async t => {
  const db = await beforeLiteral(t);
  await db.query(functionSql);
  await db.query(indexSql);
  if (setup) await db.query(setup);
  // A leaf generated-expression rewrite must first release the parent indexes
  // that depend on that column. Dropping parents also drops their attached
  // leaves; the raw payload GIN remains present throughout this fixture.
  await db.query('DROP INDEX hook_prompt_search_trgm,hook_prompt_literal_grams');
  await db.query('ALTER TABLE hook_events_202609 ALTER COLUMN prompt_search SET EXPRESSION AS (' + expression + ')');
  await db.query(indexSql);
  const before = await ids(db), previousLedger = await ledger(db);
  assert.equal((await db.query("SELECT to_regclass('hook_prompt_trgm') IS NOT NULL AND to_regclass('hook_prompt_search_trgm') IS NULL AS fixture_indexes")).rows[0]!.fixture_indexes, true);
  await assert.rejects(db.migrate(), { code: '55000', message: 'literal prompt grams require the exact native stored prompt_search on every table partition' });
  await absentVersion(db);
  assert.deepEqual(await ids(db), before);
  assert.deepEqual(await ledger(db), previousLedger);
});

test('future partitions inherit literal GIN and row deletion and real cleanup remove indexed private prompts', async t => {
  const db = await testDatabase(t);
  await db.migrate();
  await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const before = await verifyFamily(db);
  await db.ensurePartitions(new Date('2026-12-01Z'), new Date('2027-01-01Z'));
  const after = await verifyFamily(db);
  assert.equal(after.filter(row => row.isleaf).length, before.filter(row => row.isleaf).length + 1);
  const clock = () => new Date('2026-12-25T12:00:00Z'), identity = createIdentityService(db, { clock, emailDomains: ['example.invalid'] });
  const seed = await identity.bootstrap({ email: 'grams-root@example.invalid', name: '清理超管' });
  const initial = await identity.login('grams-root@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(initial.token, seed.temporaryPassword, 'literal-grams-root-password');
  const owner = randomUUID(), installation = randomUUID();
  await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'grams-owner@example.invalid','清理目标')", [owner]);
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')", [installation, owner, 'b'.repeat(64)]);
  async function put(id: string, at: string, prompt: string) {
    const saved = await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: id, occurred_at: at,
      event_type: 'UserPromptSubmit', source_session_id: id, payload: { prompt } }, { admissionEpoch: 1, receivedAt: clock() });
    if (saved.outcome !== 'committed') throw new Error('Synthetic cleanup fact did not commit');
    return saved;
  }
  const deletedAt = '2026-12-09T10:00:00.123456Z';
  const deleted = await put('row-delete', deletedAt, 'row-delete-needle');
  await put('cleanup-target', '2026-12-10T10:00:00Z', 'cleanup-needle');
  await put('cleanup-survivor', '2026-12-11T10:00:00Z', 'cleanup-needle surviving');
  async function matches(term: string) {
    return (await db.query(`SELECT count(*)::integer AS n FROM hook_events WHERE user_id=$1 AND event_type='UserPromptSubmit'
      AND hook_prompt_codepoint_grams(prompt_search) @> hook_prompt_codepoint_grams(lower($2::text))
      AND prompt_search LIKE '%'||lower($2::text)||'%'`, [owner, term])).rows[0]!.n;
  }
  assert.equal(await matches('row-delete-needle'), 1);
  await db.query('DELETE FROM hook_events WHERE id=$1 AND occurred_at=$2', [deleted.eventId, deletedAt]);
  assert.equal(await matches('row-delete-needle'), 0);
  assert.equal(await matches('cleanup-needle'), 2);
  const directory = await mkdtemp(join(tmpdir(), 'adi-literal-grams-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cleanup = createCleanupService(db, identity, { clock, journal: createCleanupJournal(directory), batchSize: 2 });
  const preview = await cleanup.preview(root.token, { user_id: owner, from: '2026-12-10T00:00:00Z', to: '2026-12-11T00:00:00Z' });
  await cleanup.submit(root.token, { preview_id: preview.preview_id, user_id: owner, ...preview.range, confirmation_email: preview.target.email }, randomUUID());
  let iterations = 0;
  while (await cleanup.runOne()) assert.ok(++iterations < 80);
  assert.equal(await matches('cleanup-needle'), 1);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM hook_events WHERE user_id=$1 AND occurred_at>=$2 AND occurred_at<$3", [owner, preview.range.from, preview.range.to])).rows[0]!.n, 0);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM cleanup_tombstones WHERE user_id=$1', [owner])).rows[0]!.n, 1);
  await verifyFamily(db);
  assert.equal((await db.query("SELECT to_regclass('hook_prompt_trgm') IS NOT NULL AND to_regclass('hook_prompt_search_trgm') IS NOT NULL AS retained")).rows[0]!.retained, true);
});
