import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const unitDirectories = [
  ['apps/api/test', '.test.ts'],
  ['apps/collector/test', '.test.ts'],
  ['apps/worker/test', '.test.ts'],
  ['apps/hook-client/test', '.test.ts'],
  ['packages/domain/test', '.test.ts'],
  ['apps/web/test', '.test.ts'],
  ['scripts/test', '.test.mjs'],
  ['trae-plugin/test', '.test.ts'],
];

// Shared by the self-contained local test command and the prepared CI command.
// Match the original top-level globs; integration suites have separate runners.
export function unitTestFiles(root = process.cwd()) {
  return unitDirectories.flatMap(([directory, suffix]) => {
    const files = readdirSync(join(root, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
      .map(entry => join(directory, entry.name)).sort();
    if (!files.length) throw new Error(`No unit tests found in ${directory}`);
    return files;
  });
}

function exitStatus(result) {
  return result.status ?? 1;
}

function unitTests() {
  const args = ['--import', 'tsx', '--test', '--test-concurrency=1'];
  if (process.env.ADI_UNIT_JUNIT === 'true') {
    mkdirSync('.run', { recursive: true });
    args.push('--test-reporter=spec', '--test-reporter=junit',
      '--test-reporter-destination=stdout', '--test-reporter-destination=.run/engineering-junit.xml');
  }
  args.push(...unitTestFiles());
  return exitStatus(spawnSync(process.execPath, args, { stdio: 'inherit' }));
}

function gateFailureReport(phase, status) {
  const report = '.run/engineering-junit.xml';
  // The real unit reporter is authoritative when the unit process created it.
  if (existsSync(report)) return;
  const message = `CI phase ${phase} failed with exit code ${status}`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<testsuites tests="1" failures="1" errors="0" skipped="0">` +
    `<testsuite name="engineering gates" tests="1" failures="1" errors="0" skipped="0">` +
    `<testcase name="${phase}" classname="engineering gate"><failure message="${message}">${message}</failure></testcase>` +
    `</testsuite></testsuites>\n`;
  try { writeFileSync(report, xml, { flag: 'wx' }); }
  catch { process.stderr.write('CI gate failure report could not be written\n'); }
}

function engineeringChecks() {
  mkdirSync('.run', { recursive: true });
  rmSync('.run/engineering-junit.xml', { force: true });
  const timer = fileURLToPath(new URL('./ci-step.sh', import.meta.url));
  const steps = [
    ['lint', 'lint'],
    ['build', 'build'],
    ['typecheck', 'typecheck:prepared'],
    ['contracts', 'contracts:check:prepared'],
    ['unit', 'test:unit:prepared'],
  ];
  for (const [phase, script] of steps) {
    const result = spawnSync('sh', [timer, phase, 'pnpm', script], {
      stdio: 'inherit', env: { ...process.env, ADI_UNIT_JUNIT: 'true' },
    });
    if (result.error) process.stderr.write(`CI phase ${phase} could not start\n`);
    const status = exitStatus(result);
    if (status !== 0) { gateFailureReport(phase, status); return status; }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) process.exitCode = engineeringChecks();
    else if (args.length === 1 && args[0] === '--unit') process.exitCode = unitTests();
    else throw new Error('Usage: node scripts/ci-check.mjs [--unit]');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
