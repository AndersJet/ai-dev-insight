import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openApi } from '../packages/contracts/dist/index.js';
const target = new URL('../packages/contracts/generated/openapi.json', import.meta.url);
const expected = JSON.stringify(openApi, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== expected) throw new Error('OpenAPI drift: run pnpm contracts:generate');
} else {
  await mkdir(new URL('../packages/contracts/generated/', import.meta.url), { recursive: true });
  await writeFile(target, expected);
}
