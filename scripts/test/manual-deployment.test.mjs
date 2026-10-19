import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const source = fileURLToPath(new URL('../../deploy/manual/', import.meta.url));
const sha = '0123456789abcdef0123456789abcdef01234567';
const postgresParent = 'postgres:18.6@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae';
const localPrefix = 'candidate.local/work/ai-dev-insight';
const postgresAmd64 = 'postgres:18.6@sha256:0377e72c5289ed2f98cf61b1a9c2db9eb9d300317fe14244492fbc94343b3d04';
const options = { skip: process.platform === 'win32', timeout: 30000 };
test('install packaging succeeds without a live PostgreSQL index query', options, async t => {
  const f=await fixture(t),result=run(f,'export-images.sh',['--local','--tag',sha],{FIXTURE_FAIL:'pg-index-failed'});
  assert.equal(result.status,0,result.stderr);
  assert.equal((await calls(f)).filter(a=>a[0]==='buildx').length,0);
  const target=await bundle(f);
  assert.match(await readFile(join(target,'images.manifest'),'utf8'),/local\/ai-dev-insight-api:/);
  assert.ok((await readFile(join(target,'images.manifest'),'utf8')).includes('postgres\tpostgres:18.6@sha256:0377e72c5289ed2f98cf61b1a9c2db9eb9d300317fe14244492fbc94343b3d04\t'));
});
test('fixed PostgreSQL platform children match the retained immutable parent index', options, async () => {
  // Buildx --raw returned these exact bytes; the fixture ends with one editor newline.
  const raw=(await readFile(new URL('./fixtures/postgres-18.6-index.json',import.meta.url),'utf8')).replace(/\n$/,'');
  const digest='sha256:'+createHash('sha256').update(raw).digest('hex');
  assert.equal(digest,postgresParent.split('@')[1]);
  const index=JSON.parse(raw);assert.equal(index.mediaType,'application/vnd.oci.image.index.v1+json');
  for(const platform of ['linux/amd64','linux/arm64']){
    const [os,architecture]=platform.split('/'),children=index.manifests.filter(m=>m.platform.os===os&&m.platform.architecture===architecture);
    assert.equal(children.length,1);
    assert.equal(children[0].mediaType,'application/vnd.oci.image.manifest.v1+json');
    assert.ok(architecture==='amd64'?!children[0].platform.variant:children[0].platform.variant==='v8');
    const result=spawnSync('/bin/sh',['-c','. "$1"; manual_postgres_parent; postgres_platform_ref "$2"','postgres-pin',join(source,'lib.sh'),platform],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'),[postgresParent,'postgres:18.6@'+children[0].digest]);
  }
  const unsupported=spawnSync('/bin/sh',['-c','. "$1"; postgres_platform_ref linux/386','postgres-pin',join(source,'lib.sh')],{encoding:'utf8'});
  assert.notEqual(unsupported.status,0);assert.match(unsupported.stderr,/Unsupported PostgreSQL platform/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'adi-manual-')), manual = join(root, 'manual'), bin = join(root, 'bin');
  await mkdir(manual); await mkdir(bin);
  for (const file of ['docker-compose.yml', 'postgres-init.sql', '.env.example', 'lib.sh', 'export-images.sh', 'load-images.sh', 'backup.sh', 'deploy.sh', 'archive.sh', 'site-config.mjs', 'run-header.sh', 'README.md', 'REFERENCE.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) await copyFile(join(source, file), join(manual, file));
  await writeFile(join(manual, '.env'), 'DO_NOT_SHIP=synthetic-private-secret\n');
  await writeFile(join(bin, 'docker'), '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const a = process.argv.slice(2), fail = process.env.FIXTURE_FAIL || '';
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(a) + '\n');
let state = {}; try { state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE)); } catch {}
const role = ref => /(?:ai-dev-insight|ai-dev-insight-offline)-(api|collector|worker|web|postgres)/.exec(ref)?.[1] || (ref.startsWith('postgres:') ? 'postgres' : '');
const meta = ref => state[ref] || { id: 'sha256:' + String(['api','collector','worker','web','postgres'].indexOf(role(ref)) + 1).repeat(64), platform: process.env.FIXTURE_PLATFORM || 'linux/amd64', revision: process.env.FIXTURE_SHA };
const save = () => fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
if (a[0] === 'info') { if (a.includes('--format')) console.log(fail === 'server-arch' || process.env.FIXTURE_PLATFORM === 'linux/arm64' ? 'aarch64' : 'x86_64'); }
else if (a[0] === 'buildx' && a[1] === 'imagetools' && a[2] === 'inspect') {
  process.exit(4); // Index network access is unavailable, as on the affected Runner.
}
else if (a[0] === 'pull') { if (fail === 'pull-postgres' && a.at(-1).startsWith('postgres:')) process.exit(4); }
else if (a[0] === 'tag') {
  const id = a[1], r = a[2]; state[r] = { ...meta(r), id }; save();
}
else if (a[0] === 'image' && a[1] === 'inspect') {
  const ref = a[2], format = a.at(-1), m = meta(ref);
  if (/^(ai-dev-insight-offline|trae-hooks-offline)-/.test(ref) && !state[ref]) process.exit(1);
  if (fail === 'local-missing' && role(ref) === 'collector') process.exit(1);
  if (format.includes('revision')) console.log(fail === 'no-label' ? '' : (fail === 'mixed' && ref.endsWith(':latest') || fail === 'local-mixed') && role(ref) === 'worker' ? 'f'.repeat(40) : m.revision);
  else if (format.includes('Architecture')) console.log((fail === 'source-arch' && role(ref) === 'collector' || fail === 'pg-child-arch' && role(ref) === 'postgres') ? 'linux/arm64' : m.platform);
  else if (format.includes('.Id')) {
    if (fail === 'local-id-change' && role(ref) === 'web' && ref.endsWith(':' + process.env.FIXTURE_SHA)) {
      state.__inspects = state.__inspects || {}; state.__inspects[ref] = (state.__inspects[ref] || 0) + 1; save();
      console.log(state.__inspects[ref] > 1 ? 'sha256:' + 'f'.repeat(64) : m.id);
    } else console.log(m.id);
  }
  else process.exit(90);
}
else if (a[0] === 'image' && a[1] === 'save') {
  if (fail === 'save') process.exit(5);
  const index = a.indexOf('-o'), refs = a.slice(index + 2);
  fs.writeFileSync(a[index + 1], JSON.stringify(Object.fromEntries(refs.map(ref => [ref, meta(ref)]))));
}
else if (a[0] === 'image' && a[1] === 'load') {
  state = { ...state, ...JSON.parse(fs.readFileSync(a[a.indexOf('-i') + 1])) };
  if (fail === 'loaded-id') state['ai-dev-insight-offline-worker:' + process.env.FIXTURE_SHA].id = 'sha256:' + 'f'.repeat(64);
  save();
}
else if (a[0] === 'compose') {
  if (a[1] === 'config') process.exit(0);
  if (a[1] === 'ps') { if (a.includes('postgres') || fail === 'writers-running') console.log('container-id'); }
  else if (a[1] === 'exec') process.stdout.write('synthetic-db-dump');
  else if (a[1] === 'run') process.stdout.write('synthetic-volume-archive');
  else process.exit(91);
}
else process.exit(99);
`, { mode: 0o755 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, manual, bin, calls: join(root, 'calls.jsonl'), state: join(root, 'state.json') };
}
function run(f, name, args = [], env = {}, cwd = f.manual) {
  if (name === 'export-images.sh' && !args.includes('--local') && !args.includes('--image-prefix')) args = ['--image-prefix','registry.example.org/community/ai-dev-insight',...args];
  if (name === 'export-images.sh' && !args.includes('--kind')) args = ['--kind', 'install', ...args];
  return spawnSync(name === 'export-images.sh' ? '/bin/sh' : '/bin/bash', [join(cwd, name), ...args], { cwd, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, PATH: f.bin + ':' + process.env.PATH, FIXTURE_CALLS: f.calls, FIXTURE_STATE: f.state, FIXTURE_SHA: sha, ...env } });
}
async function calls(f) { return (await readFile(f.calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
async function bundle(f) {
  const file = (await readdir(join(f.manual, 'offline'))).find(name => name.endsWith('.run'));
  const bytes = await readFile(join(f.manual, 'offline', file)), marker = Buffer.from('\n__ADI_PAYLOAD_BELOW__\n');
  const offset = bytes.indexOf(marker) + marker.length, target = join(f.root, 'expanded');
  await mkdir(target);
  const extracted = spawnSync('tar', ['-xzf', '-', '-C', target], { input: bytes.subarray(offset) });
  assert.equal(extracted.status, 0, extracted.stderr.toString());
  await writeFile(f.state, '{}');
  return target;
}

test('offline bundle keeps init SQL readable by the PostgreSQL UID and configuration private', options, async t => {
  const f = await fixture(t), result = run(f, 'export-images.sh');
  assert.equal(result.status, 0, result.stderr);
  const target = await bundle(f);
  assert.equal((await stat(join(target, 'postgres-init.sql'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(target, '.env.example'))).mode & 0o777, 0o600);
});

test('import restores SQL readability after extraction with a restrictive umask', options, async t => {
  const f = await fixture(t), result = run(f, 'export-images.sh');
  assert.equal(result.status, 0, result.stderr);
  const target = await bundle(f);
  await import('node:fs/promises').then(fs => fs.chmod(join(target, 'postgres-init.sql'), 0o600));
  const loaded = run(f, 'load-images.sh', [], {}, target);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal((await stat(join(target, 'postgres-init.sql'))).mode & 0o777, 0o644);
});

test('latest export and offline import preserve five identities and never ship private .env', options, async t => {
  const f = await fixture(t), result = run(f, 'export-images.sh');
  assert.equal(result.status, 0, result.stderr);
  const target = await bundle(f);
  assert.doesNotMatch(await readFile(join(target, '.env.example'), 'utf8'), /synthetic-private-secret/);
  const rows = await calls(f), pulls = rows.filter(a => a[0] === 'pull');
  assert.equal(pulls.length, 9);
  assert.equal(pulls.filter(a => a.at(-1).endsWith(':' + sha)).length, 4);
  assert.deepEqual(pulls.slice(0,4).map(a=>a.at(-1)), ['api','collector','worker','web'].map(role=>'registry.example.org/community/ai-dev-insight-'+role+':latest'));
  assert.match(pulls.at(-1).at(-1), /^postgres:18\.6@sha256:[a-f0-9]{64}$/);
  assert.equal(rows.filter(a => ['push', 'login', 'build'].includes(a[0])).length, 0);
  assert.equal((await readFile(join(target, 'images.manifest'), 'utf8')).split('\n').filter(s => s && !s.startsWith('#')).length, 5);
  // Runtime configuration is intentionally mutable and excluded from checksums.
  await writeFile(join(target, '.env'), 'RUNTIME_CONFIG=synthetic\n');
  const loaded = run(f, 'load-images.sh', [], {}, target);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /5 images loaded and verified/);
});

async function rewriteBundle(target, transform) {
  for (const name of ['images.manifest','images.tar','docker-compose.yml']) {
    await writeFile(join(target,name), transform(await readFile(join(target,name),'utf8'),name));
  }
  const checksums=await readFile(join(target,'SHA256SUMS'),'utf8');
  const updated=await Promise.all(checksums.trim().split('\n').map(async line=>{
    const name=line.slice(66);return createHash('sha256').update(await readFile(join(target,name))).digest('hex')+'  '+name;
  }));
  await writeFile(join(target,'SHA256SUMS'),updated.join('\n')+'\n');
}

test('verified legacy bundles remain importable without retagging or starting services', options, async t => {
  const f=await fixture(t);assert.equal(run(f,'export-images.sh').status,0);
  const target=await bundle(f);
  await rewriteBundle(target,text=>text.replaceAll('ai-dev-insight-offline','trae-hooks-offline').replaceAll(':'+sha,':latest').replace(/^# kind .*\n/m,''));
  await writeFile(f.calls,'');
  const loaded=run(f,'load-images.sh',[],{},target);assert.equal(loaded.status,0,loaded.stderr);
  const rows=await calls(f);
  assert.equal(rows.filter(a=>a[0]==='image'&&a[1]==='load').length,1);
  assert.equal(rows.filter(a=>['tag','compose','push'].includes(a[0])).length,0);
});

test('mixed old and new image namespaces are rejected before Docker loads the archive', options, async t => {
  const f=await fixture(t);assert.equal(run(f,'export-images.sh').status,0);
  const target=await bundle(f);
  await rewriteBundle(target,text=>text.replaceAll('ai-dev-insight-offline-worker','trae-hooks-offline-worker'));
  await writeFile(f.calls,'');
  const loaded=run(f,'load-images.sh',[],{},target);assert.notEqual(loaded.status,0);
  assert.match(loaded.stderr,/Mixed manifest image namespaces/);
  assert.equal((await calls(f)).filter(a=>a[0]==='image'&&a[1]==='load').length,0);
});

for (const fail of ['mixed', 'source-arch', 'pull-postgres', 'save', 'no-label']) {
  test('export fails closed for ' + fail, options, async t => {
    const f = await fixture(t), result = run(f, 'export-images.sh', [], { FIXTURE_FAIL: fail });
    assert.notEqual(result.status, 0);
    assert.equal((await readdir(join(f.manual, 'offline'))).length, 0);
    await assert.rejects(access(join(f.manual, '.export-lock')), { code: 'ENOENT' });
  });
}

test('historical SHA without revision labels is rejected', options, async t => {
  const f = await fixture(t), result = run(f, 'export-images.sh', ['--tag', sha], { FIXTURE_FAIL: 'no-label' });
  assert.notEqual(result.status, 0);
});

test('local candidate export requires a full SHA before accessing Docker', options, async t => {
  const f=await fixture(t);
  for(const tag of ['latest',sha.slice(0,12)]){
    const result=run(f,'export-images.sh',['--local','--tag',tag]);assert.notEqual(result.status,0);
    assert.match(result.stderr,/full.*SHA/i);
    await assert.rejects(access(f.calls),{code:'ENOENT'});
  }
});

test('local arm64 candidate selects its own pinned PostgreSQL child and imports on matching architecture',options,async t=>{
  const f=await fixture(t),env={FIXTURE_PLATFORM:'linux/arm64'},result=run(f,'export-images.sh',['--local','--tag',sha,'--image-prefix',localPrefix,'--platform','linux/arm64'],env);
  assert.equal(result.status,0,result.stderr);
  const pulls=(await calls(f)).filter(a=>a[0]==='pull');assert.deepEqual(pulls,[['pull','--platform','linux/arm64','postgres:18.6@sha256:f4fcd2b983483177b15d72d94fb3614736211554f7cac5c2cc54a05c75110b90']]);
  const target=await bundle(f),loaded=run(f,'load-images.sh',[],env,target);assert.equal(loaded.status,0,loaded.stderr);
});

test('local candidate export checks four identities and labels without role pulls and resolves only fixed PostgreSQL child', options, async t => {
  const f=await fixture(t),result=run(f,'export-images.sh',['--local','--tag',sha,'--image-prefix',localPrefix]);
  assert.equal(result.status,0,result.stderr);
  const rows=await calls(f),pulls=rows.filter(a=>a[0]==='pull');
  assert.deepEqual(pulls,[['pull','--platform','linux/amd64',postgresAmd64]]);
  assert.equal(rows.filter(a=>['push','login','build'].includes(a[0])).length,0);
  assert.equal(rows.filter(a=>a[0]==='buildx').length,0);
  for(const role of ['api','collector','worker','web']){
    const ref=localPrefix+'-'+role+':'+sha,inspects=rows.filter(a=>a[0]==='image'&&a[1]==='inspect'&&a[2]===ref);
    assert.equal(inspects.filter(a=>a.at(-1)==='{{.Id}}').length,2);
    assert.equal(inspects.filter(a=>a.at(-1).includes('revision')).length,2);
    assert.equal(inspects.filter(a=>a.at(-1).includes('Architecture')).length,2);
  }
  const target=await bundle(f),manifest=await readFile(join(target,'images.manifest'),'utf8');
  assert.match(manifest,new RegExp('# postgres_parent '+postgresParent));
  assert.ok(manifest.includes('postgres\t'+postgresAmd64+'\t'));
  const loaded=run(f,'load-images.sh',[],{},target);assert.equal(loaded.status,0,loaded.stderr);
  assert.doesNotMatch(await readFile(join(target,'.env.example'),'utf8'),/synthetic-private-secret/);
});

for(const fail of ['no-label','local-mixed','local-missing','source-arch','local-id-change','pg-child-arch']){
  test('local candidate export fails closed for '+fail,options,async t=>{
    const f=await fixture(t),result=run(f,'export-images.sh',['--local','--tag',sha,'--image-prefix',localPrefix],{FIXTURE_FAIL:fail});
    assert.notEqual(result.status,0);
    assert.equal((await readdir(join(f.manual,'offline'))).length,0);
    await assert.rejects(access(join(f.manual,'.export-lock')),{code:'ENOENT'});
    assert.equal((await calls(f)).filter(a=>a[0]==='image'&&a[1]==='save').length,0);
  });
}

for (const fail of ['server-arch', 'loaded-id', 'corrupt']) {
  test('import rejects ' + fail, options, async t => {
    const f = await fixture(t), result = run(f, 'export-images.sh');
    assert.equal(result.status, 0, result.stderr);
    const target = await bundle(f);
    await writeFile(f.calls, '');
    if (fail === 'corrupt') await writeFile(join(target, 'images.tar'), 'broken');
    const loaded = run(f, 'load-images.sh', [], { FIXTURE_FAIL: fail }, target);
    assert.notEqual(loaded.status, 0);
    if (fail !== 'loaded-id') assert.equal((await calls(f)).filter(a => a[0] === 'image' && a[1] === 'load').length, 0);
  });
}

test('backup rejects active writers before creating an archive', options, async t => {
  const f = await fixture(t), result = run(f, 'backup.sh', [], { FIXTURE_FAIL: 'writers-running' });
  assert.notEqual(result.status, 0);
  assert.equal((await calls(f)).filter(a => a[1] === 'exec' || a[1] === 'run').length, 0);
});

test('backup reuses a site-local Compose V2 entry point for every operation', options, async t => {
  const f=await fixture(t),record=join(f.manual,'compose-used');
  await writeFile(join(f.manual,'docker-compose'), '#!/bin/sh\nprintf "used\\n" >> "$FIXTURE_COMPOSE_RECORD"\nexec docker compose "$@"\n',{mode:0o755});
  const result=run(f,'backup.sh',[],{FIXTURE_COMPOSE_RECORD:record});assert.equal(result.status,0,result.stderr);
  assert.equal((await readFile(record,'utf8')).trim().split('\n').length,5);
  const rows=(await calls(f)).filter(a=>a[0]==='compose');
  assert.equal(rows.length,5);
  for(const row of rows.filter(a=>['exec','run'].includes(a[1])))assert.ok(row.includes('-T'));
});

test('stopped-writer backup includes database, volumes and private config with checksums', options, async t => {
  const f = await fixture(t), result = run(f, 'backup.sh');
  assert.equal(result.status, 0, result.stderr);
  const target = join(f.manual, 'backups', (await readdir(join(f.manual, 'backups')))[0]);
  assert.match(await readFile(join(target, '.env'), 'utf8'), /synthetic-private-secret/);
  assert.ok((await readFile(join(target, 'SHA256SUMS'), 'utf8')).includes('database.dump'));
  const check = spawnSync('/bin/bash', ['-c', 'source "$1/lib.sh"; verify_checksums', '--', f.manual], { cwd: target, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
