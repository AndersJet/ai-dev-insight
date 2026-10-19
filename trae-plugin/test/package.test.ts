import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {unzipSync} from 'fflate';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));

test('the VSIX contains its executable entry and preset endpoint but no personal NT email or credential',async()=>{
  const manifestSource=JSON.parse(await readFile(join(root,'trae-plugin/package.json'),'utf8'));
  const artifact=`adi-project-tracker-${manifestSource.version}.vsix`;
  const releaseFiles=['extension.cjs','extension.cjs.map','native-test.cjs',artifact];
  const releaseSnapshot=()=>Promise.all(releaseFiles.map(async name=>{
    try{return createHash('sha256').update(await readFile(join(root,'trae-plugin/dist',name))).digest('hex');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }));
  const before=await releaseSnapshot(),output=await mkdtemp(join(tmpdir(),'adi-plugin-package-test-'));
  try{
  await promisify(execFile)(process.execPath,['trae-plugin/scripts/build.mjs'],{cwd:root,env:{...process.env,ADI_PLUGIN_SERVER_URL:'http://127.0.0.1:4184',ADI_PLUGIN_OUTPUT_DIR:output},maxBuffer:8192});
  assert.deepEqual(await releaseSnapshot(),before,'Package tests must not overwrite deployment release artifacts');
  const files=unzipSync(await readFile(join(output,artifact)));
  const manifest=JSON.parse(Buffer.from(files['extension/package.json']!).toString('utf8'));
  assert.equal(manifest.icon,'media/adi-icon.png');
  assert.deepEqual(Buffer.from(files['extension/'+manifest.icon]!),await readFile(join(root,'trae-plugin/media/adi-icon.png')));
  assert.match(Buffer.from(files['extension.vsixmanifest']!).toString(),/Type="Microsoft\.VisualStudio\.Services\.Icons\.Default" Path="extension\/media\/adi-icon\.png"/);
  assert.equal(manifest.contributes.configuration.properties['adiProjectTracker.ntEmail'],undefined);
  assert.equal(manifest.contributes.configuration.properties['adiProjectTracker.serverUrl'],undefined);
  assert.equal(manifest.contributes.configuration.properties['adiProjectTracker.webUrl'].default,'http://127.0.0.1:4184');
  const helper=unzipSync(files['extension/dist/remote-workspace.vsix']!);const helperManifest=JSON.parse(Buffer.from(helper['extension/package.json']!).toString('utf8'));assert.deepEqual(manifest.extensionKind,['ui']);assert.deepEqual(helperManifest.extensionKind,['workspace']);assert.equal(helperManifest.adiBuildId,manifest.adiBuildId);assert.equal(helperManifest.version,manifest.version);assert.ok(helper['extension/dist/remote-hook-sender.cjs']?.length);assert.equal(Object.keys(helper).some(name=>/state\.json|relay.*\.json/.test(name)),false);
  for(const archive of [files,helper]){
    assert.ok(archive['extension/CHANGELOG.md']?.length,'both published plugins must include the changelog linked by their README');
    assert.deepEqual(Buffer.from(archive['extension/CHANGELOG.md']!),await readFile(join(root,'trae-plugin/CHANGELOG.md')));
  }
  assert.equal(helperManifest.icon,manifest.icon);
  assert.deepEqual(Buffer.from(helper['extension/'+helperManifest.icon]!),Buffer.from(files['extension/'+manifest.icon]!));
  assert.match(Buffer.from(helper['extension.vsixmanifest']!).toString(),/Type="Microsoft\.VisualStudio\.Services\.Icons\.Default" Path="extension\/media\/adi-icon\.png"/);
  assert.ok(files['extension/dist/extension.cjs']?.length);assert.ok(files['extension.vsixmanifest']?.length);
  assert.equal(Object.keys(files).some(name=>/state\.json|\.key$|installation\.json/.test(name)),false);
  }finally{await rm(output,{recursive:true,force:true});}
});
