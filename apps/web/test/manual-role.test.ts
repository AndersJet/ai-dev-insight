import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualPath } from '../src/router/manual.js';
test('manual follows effective role priority rather than the common employee grant',()=>{
  assert.equal(manualPath(['employee','super','anc_admin']),'/manual/system-admin');
  assert.equal(manualPath(['employee','anc_admin','department_admin']),'/manual/anc-admin');
  assert.equal(manualPath(['employee','department_admin']),'/manual/department-admin');
  assert.equal(manualPath(['employee']),'/manual/employee');
});
