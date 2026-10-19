import {test} from 'node:test';
import assert from 'node:assert/strict';
import {e2eEnvironment} from '../e2e/helpers/environment.mjs';

test('a concurrent E2E run selects an independent test schema and local port range',()=>{
  const isolated=e2eEnvironment({ADI_E2E_SCHEMA:'test_plugin_unified_20261009',ADI_E2E_PORT_BASE:'4284'});
  assert.equal(isolated.schema,'test_plugin_unified_20261009');assert.equal(isolated.apiURL,'http://127.0.0.1:4284');assert.equal(isolated.webURL,'http://127.0.0.1:4285');assert.equal(isolated.collectorURL,'http://127.0.0.1:4287');
});

test('E2E isolation rejects business or injected schemas and ports outside the owned local range',()=>{
  for(const schema of ['public','business','test_x;DROP SCHEMA public','test_../prod','test_'+'x'.repeat(64),''])assert.throws(()=>e2eEnvironment({ADI_E2E_SCHEMA:schema}));
  for(const port of ['80','65534','-1','4284x','0x10bc',''])assert.throws(()=>e2eEnvironment({ADI_E2E_PORT_BASE:port}));
});

test('E2E defaults preserve CI and cannot redirect setup into another database',()=>{
  const defaults=e2eEnvironment({});assert.equal(defaults.schema,'test_browser_e2e');assert.equal(defaults.portBase,4184);
  for(const url of ['postgres://adi_test:x@127.0.0.1:55438/business','postgres://owner:x@127.0.0.1:55438/adi_test','postgres://adi_test:x@10.0.0.1:55438/adi_test','postgres://adi_test:x@127.0.0.1:55438/adi_test?schema=public'])assert.throws(()=>e2eEnvironment({ADI_TEST_DATABASE_URL:url}));
  assert.doesNotThrow(()=>e2eEnvironment({CI:'true',ADI_TEST_DATABASE_URL:'postgres://adi_test:x@postgres-test:5432/adi_test'}));
});
