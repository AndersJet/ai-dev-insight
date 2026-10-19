import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Called in the image builder AFTER an offline, frozen production-only install.
// Keep pnpm's workspace-relative symlinks intact; copy no source, tests or .run.
const output = process.argv[2];
if (!output || !output.startsWith('/')) throw new Error('Absolute runtime output required');
await mkdir(output, { recursive: true });
for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','THIRD_PARTY_LICENSES.txt'])await cp(name,join(output,name));
await cp('node_modules', join(output, 'node_modules'), { recursive: true, verbatimSymlinks: true });
for (const name of ['apps/api', 'apps/collector', 'apps/worker', 'packages/contracts', 'packages/domain', 'packages/storage', 'packages/tsconfig']) {
  const target = join(output, name); await mkdir(target, { recursive: true });
  await cp(join(name, 'package.json'), join(target, 'package.json'));
  if (name === 'packages/tsconfig') continue;
  if (name === 'packages/storage') await cp(join(name, 'migrations'), join(target, 'migrations'), { recursive: true });
  await cp(join(name, 'dist'), join(target, 'dist'), { recursive: true });
  await cp(join(name, 'node_modules'), join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });
}
await cp('apps/hook-client/dist/release', join(output, 'apps/hook-client/dist/release'), { recursive: true });
