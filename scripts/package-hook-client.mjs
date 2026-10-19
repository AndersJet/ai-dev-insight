import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('Use --output DIRECTORY');
const output = args[1] ? resolve(args[1]) : fileURLToPath(new URL('../apps/hook-client/dist/release/', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../apps/hook-client/package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid client release version');
const files = {};
// Explicit allowlist: never package an installed config, credentials, source
// maps, node_modules or a developer's local profile.
for (const name of ['install-hook.sh', 'install-hook.ps1', 'send-hook.sh', 'send-hook.ps1', 'send-worker.ps1']) {
  files[name] = await readFile(new URL(`../apps/hook-client/native/${name}`, import.meta.url));
  if (files[name].length > 512 * 1024) throw new Error('Client module exceeds release limit');
}
files['native-macos.js'] = Buffer.concat([
  await readFile(new URL('../apps/hook-client/native/core.js', import.meta.url)), Buffer.from('\n'),
  await readFile(new URL('../apps/hook-client/native/macos.js', import.meta.url)),
]);
const modules = await Promise.all(['project-core.ps1','project-io.ps1','project-git.ps1'].map(name=>readFile(new URL('../apps/hook-client/native/'+name,import.meta.url),'utf8')));
const processSource=await readFile(new URL('../apps/hook-client/native/windows-process.cs',import.meta.url),'utf8');
const clientSource=await readFile(new URL('../apps/hook-client/native/windows-client.cs',import.meta.url),'utf8');
const windows=await readFile(new URL('../apps/hook-client/native/native-windows.ps1',import.meta.url),'utf8');
files['native-windows.ps1']=Buffer.from(windows.replace('# ADI_PROJECT_MODULE_INSERT',()=>modules.join('\n')).replace('# ADI_PROCESS_SOURCE_INSERT',()=>"$script:AdiProcessSource=@'\n"+processSource+"\n'@" ).replace('# ADI_CLIENT_SOURCE_INSERT',()=>"$script:AdiClientSource=@'\n"+clientSource+"\n'@"));
for(const name of ['LICENSE','NOTICE'])files[name]=await readFile(new URL('../'+name,import.meta.url));
files['INSTALL.md'] = await readFile(new URL('../apps/hook-client/INSTALL.md', import.meta.url));
const archive = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
const sha256 = createHash('sha256').update(archive).digest('hex');
const manifest = { schema_version: 2, version, runtime: 'system', platforms: ['windows', 'macos'], channel: 'preview', file_name: `adi-hook-client-${version}-${sha256.slice(0, 12)}.zip`, sha256, bytes: archive.length };
await mkdir(output, { recursive: true });
for (const [name, data] of [['client.zip', archive], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n']]) {
  const temp = join(output, `.build-${randomUUID()}`); await writeFile(temp, data); await rename(temp, join(output, name));
}
console.log(JSON.stringify({ output, ...manifest }));
