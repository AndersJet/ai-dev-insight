import {test} from 'node:test';import assert from 'node:assert/strict';import {zipSync} from 'fflate';import {createHash} from 'node:crypto';
import {validatePersonalArchive} from '../src/hook-setup.js';
test('only the actual bounded personal archive is accepted; extra paths and another site are refused',()=>{
  const files:Record<string,Uint8Array>={};for(const name of ['INSTALL.md','LICENSE','NOTICE','install-hook.ps1','install-hook.sh','native-macos.js','native-windows.ps1','send-hook.ps1','send-hook.sh','send-worker.ps1'])files[name]=Buffer.from('synthetic test material');
  files['adi-installation.json']=Buffer.from(JSON.stringify({installation_id:'a163f758-49a9-4d19-b713-0680c1810f66',token:'adi_'+'a'.repeat(43),endpoint:'http://example.invalid/hooks'}));
  const archive=Buffer.from(zipSync(files));const expected={bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')};
  assert.ok(validatePersonalArchive(archive,expected,'http://example.invalid','a'.repeat(64))['adi-installation.json']);
  assert.throws(()=>validatePersonalArchive(archive,{...expected,sha256:'0'.repeat(64)},'http://example.invalid','a'.repeat(64)),/archive_integrity/);
  assert.throws(()=>validatePersonalArchive(archive,expected,'http://another.invalid','a'.repeat(64)),/endpoint_mismatch/);
  const extra=Buffer.from(zipSync({...files,'../escape':Buffer.from('bad')}));assert.throws(()=>validatePersonalArchive(extra,{bytes:extra.length,sha256:createHash('sha256').update(extra).digest('hex')},'http://example.invalid','a'.repeat(64)),/archive_contents/);
});
