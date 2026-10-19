import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/app.js';
import {openApi} from '@adi/contracts';

test('old anonymous registration is retired and never exposes the submitted proof',async t=>{
  const app=createApi();t.after(()=>app.close());
  const proof='s'.repeat(43);
  const response=await app.inject({method:'POST',url:'/api/v1/plugin/registration',payload:{nt_email:'person@example.invalid',source_secret:proof,source_config_id:'66c72520-8662-4b25-8e2f-9bd12b3b6d01',platform:'macos',plugin_version:'0.1.0'}});
  assert.equal(response.statusCode,410,response.body);
  assert.equal(response.json().error.code,'plugin_entry_retired');
  assert.ok(!response.body.includes(proof));
});

test('published plugin routes describe account and scoped download bearers without publishing retired issuance',()=>{
  const paths=openApi.paths as Record<string,Record<string,{security:unknown[];parameters?:{name:string}[]}>>;
  assert.equal(paths['/api/v1/plugin/registration'],undefined);
  assert.deepEqual(paths['/api/v1/plugin/sources']!.post!.security,[{pluginAccount:[]}]);
  assert.deepEqual(paths['/api/v1/plugin/observations']!.post!.security,[{pluginAccount:[]}]);
  assert.deepEqual(paths['/api/v1/plugin/collection-client']!.get!.security,[{installationGrant:[]}]);
  assert.deepEqual(paths['/api/v1/me/plugin-credential']!.post!.security,[{session:[]}]);
  assert.equal(paths['/api/v1/plugin/observations']!.post!.parameters?.some(p=>p.name==='X-CSRF-Token'),false);
});
