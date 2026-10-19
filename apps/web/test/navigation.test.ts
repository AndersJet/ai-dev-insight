import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnPath } from '../src/router/access.js';
import {createPinia,setActivePinia} from 'pinia';
import {useSessionNavigation} from '../src/stores/session-navigation.js';
test('post-login navigation preserves an internal detail link and rejects external or looping destinations', () => {
  const detail = '/my/sessions/session-1?days=7&channel=official';
  assert.equal(safeReturnPath(detail, '/my/overview'), detail);
  for (const value of ['https://outside.invalid', '//outside.invalid', '/\\outside.invalid', '/login?redirect=/login', ['/my/overview'], null]) assert.equal(safeReturnPath(value, '/my/overview'), '/my/overview');
});
test('superadmin session details can return to a scoped project list but personal details cannot adopt that return target',()=>{
  setActivePinia(createPinia());const navigation=useSessionNavigation(),target='/code-flow?dept=department&search=project&project=selected';
  navigation.open('owner',target,1234);assert.equal(navigation.returnTo('owner',true,target),target);assert.equal(navigation.takeScroll('owner',target),1234);
  assert.equal(navigation.returnTo('owner',false,target),'/my/sessions');
  for(const value of ['//outside.invalid','/code-flow-evil','/code-flow\\outside.invalid'])assert.equal(navigation.returnTo('owner',true,value),'/all/sessions');
});
