import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uiEnvironment} from '../ui/environment.mjs';
test('a complete mock UI run selects its own local port and report capture',()=>{
  const isolated=uiEnvironment({ADI_UI_PORT:'4199'});assert.equal(isolated.baseURL,'http://127.0.0.1:4199');assert.equal(isolated.reportRoot,'.run/ui-4199');
});
test('mock UI port overrides cannot use privileged, malformed or overflowing ports',()=>{
  for(const port of ['80','-1','65536','4199x','0x1067',''])assert.throws(()=>uiEnvironment({ADI_UI_PORT:port}));
  const defaults=uiEnvironment({});assert.equal(defaults.port,4189);assert.equal(defaults.reportRoot,'.run');
});
