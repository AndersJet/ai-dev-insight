import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('disabled macOS diagnostics preserve overlapping curl startup before configuration is available',{skip:process.platform==='win32'},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'adi-native-overlap-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const producer=join(directory,'producer.sh'),transport=join(directory,'transport.sh'),marker=join(directory,'transport-started'),result=join(directory,'overlap');
  await writeFile(producer,'#!/bin/bash\nfor ((i=0;i<30;i++)); do [ -f "$ADI_TEST_TRANSPORT_MARKER" ] && break; /bin/sleep 0.01; done\nif [ -f "$ADI_TEST_TRANSPORT_MARKER" ]; then echo overlap; else echo serialized; fi > "$ADI_TEST_OVERLAP_RESULT"\nprintf "silent\\n"\n',{mode:0o700});
  await writeFile(transport,'#!/bin/bash\nprintf started > "$ADI_TEST_TRANSPORT_MARKER"\n/bin/cat >/dev/null\n',{mode:0o700});
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  const script=(await readFile(new URL('../native/send-hook.sh',import.meta.url),'utf8')).replaceAll('/usr/bin/osascript','/bin/bash '+quote(producer)).replaceAll('/usr/bin/curl','/bin/bash '+quote(transport));
  const launcher=join(directory,'send-hook.sh');await writeFile(launcher,script);
  const reply=await promisify(execFile)('/bin/bash',[launcher],{timeout:2000,env:{...process.env,HOME:directory,ADI_TEST_TRANSPORT_MARKER:marker,ADI_TEST_OVERLAP_RESULT:result}});
  assert.equal(reply.stdout,'');assert.equal(reply.stderr,'');
  assert.equal((await readFile(result,'utf8')).trim(),'overlap','normal collection must start its transport without waiting for JXA configuration');
});
