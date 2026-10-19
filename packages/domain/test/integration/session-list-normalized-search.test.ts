import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { Database } from '../../../storage/src/index.js';
import { testDatabase } from '../../../storage/test/helpers.js';

const escaped = (value: string) => '%' + value.replace(/[\\%_]/g, character => '\\' + character) + '%';
const prompt = "CASE WHEN event_type='UserPromptSubmit' THEN payload->>'prompt' END";
const identity = '(extract(epoch FROM occurred_at)*1000000)::bigint::text AS at_us';
type Case = { label: string; event_type: string; payload: { prompt?: string | null } | null; pattern: string };
type Match = { id: string; at_us: string; case_id: number; search?: number };

async function probe(t: TestContext) {
  const db = await testDatabase(t);
  const environment = (await db.query<{ encoding: string; version: number; deterministic: boolean; uses_default: boolean; locale: string }>(`
    SELECT current_setting('server_encoding') AS encoding,current_setting('server_version_num')::int AS version,
      c.collisdeterministic AS deterministic,pg_collation_for('probe'::text)::regcollation=c.oid AS uses_default,
      d.datcollate||' / '||d.datctype AS locale
    FROM pg_database d JOIN pg_collation c ON c.oid='pg_catalog."default"'::regcollation
    WHERE d.datname=current_database()
  `)).rows[0]!;
  assert.equal(environment.encoding, 'UTF8');
  assert.ok(environment.version >= 180000 && environment.version < 190000, 'this proof targets PostgreSQL 18');
  assert.equal(environment.deterministic, true, 'ILIKE requires a deterministic collation');
  assert.equal(environment.uses_default, true, 'both expressions must use the database default collation');
  await db.query(`CREATE SCHEMA "${db.schema}"`);
  await db.query(`CREATE TABLE normalized_prompt_probe (
    case_id integer NOT NULL UNIQUE,
    label text NOT NULL,
    id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    pattern text NOT NULL,
    prompt_normalized text GENERATED ALWAYS AS (
      CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END
    ) STORED,
    PRIMARY KEY(id,occurred_at)
  )`);
  const column = (await db.query<{ generated: string; uses_default: boolean }>(`
    SELECT attgenerated AS generated,attcollation='pg_catalog."default"'::regcollation AS uses_default
    FROM pg_attribute WHERE attrelid='normalized_prompt_probe'::regclass AND attname='prompt_normalized'
  `)).rows[0]!;
  assert.deepEqual(column, { generated: 's', uses_default: true });
  return { db, environment };
}

async function insert(db: Database, cases: Case[]) {
  await db.query(`INSERT INTO normalized_prompt_probe(case_id,label,id,occurred_at,event_type,payload,pattern)
    SELECT case_id,label,('00000000-0000-4000-8000-'||lpad((case_id/2)::text,12,'0'))::uuid,
      '2026-10-09T01:02:03.123000Z'::timestamptz+(case_id+1)*interval '1 microsecond',event_type,payload,pattern
    FROM jsonb_to_recordset($1::jsonb) r(case_id integer,label text,event_type text,payload jsonb,pattern text)
  `, [JSON.stringify(cases.map((row, case_id) => ({ ...row, case_id })))]);
}

function corpus() {
  const cases: Case[] = [];
  const add = (label: string, source: string | null, needle: string, event_type = 'UserPromptSubmit') => {
    cases.push({ label, event_type, payload: { prompt: source }, pattern: escaped(needle) });
  };
  const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
  const punctuation = printable.filter(value => /[^A-Za-z0-9 ]/.test(value)).join('');
  const unicode = ['中文', '🙂', '👩‍💻', 'İ', 'ı', 'K', 'ſ', 'ß', 'ẞ', 'Σ', 'σ', 'ς', 'ΑΒΓ', 'É', 'é', 'E\u0301', 'e\u0301', 'Å', 'å', 'A\u030a', '\u00a0'];
  const needles = [...new Set(['AbC', '0123456789', punctuation, '%_\\', '\\%_', ' ', '\t', '\n', '\r', '\v', '\f', ' \t\n\r\v\f ', 'aaa', 'aaaaa', 'a a', "x'y", '中文AbC🙂', ...unicode, ...printable, ...printable.map(value => 'A' + value + 'z')])];
  for (const [index, needle] of needles.entries()) {
    const sources = [needle, needle.toUpperCase(), needle.toLowerCase(), needle + ' 后中文🙂', '前中文🙂 ' + needle + ' 后中文🙂', '前中文🙂 ' + needle, needle.repeat(3), 'UNRELATED_SYNTHETIC_🧪', null];
    for (const [variant, source] of sources.entries()) add(`literal-${index}-${variant}`, source, needle);
  }
  // Cross-script cases include Unicode relations touching ASCII and cases whose
  // database lower differs by locale. No application lower decides the result.
  const sources = ['İIK', 'ıik', 'KſI', 'KSI', 'ßx', 'ẞX', 'SSX', 'Σσς', 'ΟΣ', 'οσ', 'ος', 'ΑΒΓ', 'αβγ', 'É', 'é', 'E\u0301', 'e\u0301', 'Å', 'A\u030a', 'ﬀABC', 'ＡＢＣ', '中文🙂AbC%_\\'];
  const crossNeedles = ['iik', 'ksi', 'ssx', 'abc', 'σ', 'ς', 'οσ', 'ος', 'é', 'e\u0301', 'å', 'a\u030a', '%_\\', ...unicode];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const [needleIndex, needle] of crossNeedles.entries()) add(`unicode-${sourceIndex}-${needleIndex}`, source, needle);
  }
  for (let index = 0; index < 256; index++) {
    const needle = Array.from({ length: 3 + index % 23 }, (_, offset) => String.fromCharCode(32 + (index * 37 + offset * 53) % 95)).join('');
    add(`ascii-${index}-same`, needle, needle);
    add(`ascii-${index}-middle`, '中文🙂 ' + needle.toUpperCase() + ' 后', needle);
    add(`ascii-${index}-different`, 'DIFFERENT_' + needle.slice(0, -1) + '🧪', needle);
  }
  const suffix = 'Tail_50%\\İéΣ🙂';
  const long = 'A'.repeat(512 * 1024 - Buffer.byteLength(suffix)) + suffix;
  assert.ok(Buffer.byteLength(long) <= 512 * 1024, 'the complete UTF8 prompt must fit the 512 KiB limit');
  assert.equal(Buffer.byteLength(long), 512 * 1024, 'the long-body fixture must exercise the exact limit');
  for (const [index, needle] of [suffix, 'tail_50%\\İéσ🙂', '50%\\', '🙂', 'Tail_51%\\', 'A' + suffix, 'a'.repeat(32), 'a'.repeat(32) + 'Tail'].entries()) add(`long-512KiB-suffix-${index}`, long, needle);
  add('non-prompt-matching', 'AbC %_\\ 中文🙂', 'AbC', 'Stop');
  add('non-prompt-unicode', 'İ é Σ %_\\', 'İ', 'PostToolUse');
  cases.push({ label: 'missing-prompt', event_type: 'UserPromptSubmit', payload: {}, pattern: escaped('AbC') });
  cases.push({ label: 'sql-null-payload', event_type: 'UserPromptSubmit', payload: null, pattern: escaped('AbC') });
  return cases;
}

test('UTF8 default deterministic ILIKE and PostgreSQL native lower LIKE have identical complete literal results', async t => {
  const { db, environment } = await probe(t);
  const cases = corpus();
  await insert(db, cases);
  // PG18 Generic_Text_IC_like lowercases both the complete pattern and source
  // before UTF8_MatchText. Deterministic LIKE uses that same matching path:
  // https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/like.c#L134-L216
  // https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/like_match.c#L69-L94
  const compared = (await db.query<{ label: string; original: boolean | null; normalized: boolean | null; stored: boolean | null }>(`
    SELECT label,(${prompt}) ILIKE pattern AS original,
      lower(${prompt}) LIKE lower(pattern) AS normalized,prompt_normalized LIKE lower(pattern) AS stored
    FROM normalized_prompt_probe ORDER BY case_id
  `)).rows;
  assert.equal(compared.length, cases.length);
  for (const row of compared) {
    assert.equal(row.normalized, row.original, `${row.label}: native lower LIKE must equal ILIKE, including false and NULL`);
    assert.equal(row.stored, row.original, `${row.label}: stored lower LIKE must equal ILIKE, including false and NULL`);
  }
  assert.ok(compared.some(row => row.original === true));
  assert.ok(compared.some(row => row.original === false));
  assert.ok(compared.some(row => row.original === null));
  const select = `SELECT id::text,${identity},case_id FROM normalized_prompt_probe`;
  const order = 'ORDER BY id,occurred_at';
  const original = (await db.query<Match>(`${select} WHERE event_type='UserPromptSubmit' AND payload->>'prompt' ILIKE pattern ${order}`)).rows;
  const normalized = (await db.query<Match>(`${select} WHERE lower(${prompt}) LIKE lower(pattern) ${order}`)).rows;
  const stored = (await db.query<Match>(`${select} WHERE prompt_normalized LIKE lower(pattern) ${order}`)).rows;
  assert.deepEqual(normalized, original, 'exact qualifying row identities and all timestamp microseconds must match');
  assert.deepEqual(stored, original, 'the stored column must return exactly the original result without an ILIKE recheck');
  assert.ok(original.some((row, index) => index > 0 && row.id === original[index - 1]!.id && row.at_us !== original[index - 1]!.at_us), 'same UUID events with distinct sub-millisecond timestamps must both survive');
  assert.ok(original.some(row => !row.at_us.endsWith('000')), 'identity comparison must retain sub-millisecond precision');
  t.diagnostic(`PostgreSQL ${environment.version}, UTF8, default deterministic ${environment.locale}: ${cases.length} corpus rows; ${original.length} exact UUID/microsecond matches; all true/false/NULL predicates and native/stored lower LIKE results equal ILIKE.`);
});

async function matching(db: Database, needles: string[]) {
  const searches = JSON.stringify(needles.map((needle, search) => ({ search, pattern: escaped(needle) })));
  const select = `SELECT p.search,e.id::text,(extract(epoch FROM e.occurred_at)*1000000)::bigint::text AS at_us,e.case_id
    FROM normalized_prompt_probe e CROSS JOIN jsonb_to_recordset($1::jsonb) p(search integer,pattern text)`;
  const order = 'ORDER BY p.search,e.id,e.occurred_at';
  const original = (await db.query<Match>(`${select} WHERE e.event_type='UserPromptSubmit' AND e.payload->>'prompt' ILIKE p.pattern ${order}`, [searches])).rows;
  const normalized = (await db.query<Match>(`${select} WHERE lower(CASE WHEN e.event_type='UserPromptSubmit' THEN e.payload->>'prompt' END) LIKE lower(p.pattern) ${order}`, [searches])).rows;
  const stored = (await db.query<Match>(`${select} WHERE e.prompt_normalized LIKE lower(p.pattern) ${order}`, [searches])).rows;
  assert.deepEqual(normalized, original);
  assert.deepEqual(stored, original);
  return original;
}

async function generated(db: Database, case_id: number) {
  const row = (await db.query<{ prompt_normalized: string | null }>('SELECT prompt_normalized FROM normalized_prompt_probe WHERE case_id=$1', [case_id])).rows[0];
  assert.ok(row, 'the fixture row exists');
  return row.prompt_normalized;
}

test('prompt-only generated STORED lower values follow insert, payload/type updates, NULL and delete automatically', async t => {
  const { db } = await probe(t);
  const initial = 'First ABC %_\\';
  const cases: Case[] = [
    { label: 'prompt', event_type: 'UserPromptSubmit', payload: { prompt: initial }, pattern: escaped('ABC') },
    { label: 'same-uuid-next-microsecond', event_type: 'UserPromptSubmit', payload: { prompt: 'Other ABC' }, pattern: escaped('ABC') },
    { label: 'missing', event_type: 'UserPromptSubmit', payload: {}, pattern: escaped('ABC') },
    { label: 'json-null', event_type: 'UserPromptSubmit', payload: { prompt: null }, pattern: escaped('ABC') },
    { label: 'sql-null', event_type: 'UserPromptSubmit', payload: null, pattern: escaped('ABC') },
    { label: 'stop', event_type: 'Stop', payload: { prompt: initial }, pattern: escaped('ABC') },
    { label: 'tool', event_type: 'PostToolUse', payload: { prompt: 'Replacement XYZ %_\\' }, pattern: escaped('XYZ') },
  ];
  await insert(db, cases);
  assert.deepEqual(await Promise.all(cases.map((_, index) => generated(db, index))), ['first abc %_\\', 'other abc', null, null, null, null, null]);
  const needles = ['ABC', 'XYZ', '%_\\', '%', '_', '\\', 'İ', '中文🙂', 'absent'];
  const before = await matching(db, needles);
  assert.deepEqual(before.filter(row => row.search === 0).map(row => row.case_id), [0, 1]);
  assert.equal(before[0]!.id, before[1]!.id);
  assert.equal(BigInt(before[1]!.at_us) - BigInt(before[0]!.at_us), 1n);

  await db.query("UPDATE normalized_prompt_probe SET payload=jsonb_build_object('prompt',$1::text) WHERE case_id=0", ['Replacement XYZ %_\\']);
  assert.equal(await generated(db, 0), 'replacement xyz %_\\');
  assert.deepEqual((await matching(db, needles)).filter(row => row.search === 1).map(row => row.case_id), [0]);
  await db.query("UPDATE normalized_prompt_probe SET event_type='Stop' WHERE case_id=0");
  assert.equal(await generated(db, 0), null);
  assert.ok(!(await matching(db, needles)).some(row => row.case_id === 0));
  await db.query("UPDATE normalized_prompt_probe SET event_type='UserPromptSubmit' WHERE case_id IN (0,5)");
  assert.equal(await generated(db, 0), 'replacement xyz %_\\');
  assert.equal(await generated(db, 5), 'first abc %_\\');
  await db.query("UPDATE normalized_prompt_probe SET payload=jsonb_build_object('prompt',$1::text) WHERE case_id IN (2,3,4,6)", ['ABC 中文🙂 İ']);
  assert.equal(await generated(db, 6), null, 'updating a non-prompt payload must keep the generated column NULL');
  assert.deepEqual((await matching(db, needles)).filter(row => row.search === 0).map(row => row.case_id), [1, 2, 3, 4, 5]);
  await db.query("UPDATE normalized_prompt_probe SET payload='{}'::jsonb WHERE case_id=2");
  await db.query("UPDATE normalized_prompt_probe SET payload='{\"prompt\":null}'::jsonb WHERE case_id=3");
  await db.query('UPDATE normalized_prompt_probe SET payload=NULL WHERE case_id=4');
  assert.deepEqual(await Promise.all([2, 3, 4].map(index => generated(db, index))), [null, null, null]);
  assert.deepEqual((await matching(db, needles)).filter(row => row.search === 0).map(row => row.case_id), [1, 5]);
  const removed = await db.query('DELETE FROM normalized_prompt_probe WHERE case_id IN (0,5)');
  assert.equal(removed.rowCount, 2);
  const after = await matching(db, needles);
  assert.ok(!after.some(row => row.case_id === 0 || row.case_id === 5));
  assert.deepEqual(after.filter(row => row.search === 0).map(row => row.case_id), [1]);
  assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM normalized_prompt_probe')).rows[0]!.n, 5);
  t.diagnostic('Generated STORED prompt lower follows all insert/update/delete operations; non-prompt and absent/JSON-null/SQL-null prompts do not match; UUID and one-microsecond event identity remain exact.');
});
