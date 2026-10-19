import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProjectPath} from '../src/project-path.js';

test('project identity preserves platform roots and directory spelling without guessing aliases',()=>{
  assert.equal(normalizeProjectPath('c:\\','windows'),'C:/');
  assert.equal(normalizeProjectPath('\\\\server\\share\\','windows'),'//server/share');
  assert.equal(normalizeProjectPath('c:\\工作 区\\App\\','windows'),'C:/工作 区/App');
  assert.equal(normalizeProjectPath('/','macos'),'/');
  assert.equal(normalizeProjectPath('/工作 区/App///','macos'),'/工作 区/App');
  assert.notEqual(normalizeProjectPath('C:/App','windows'),normalizeProjectPath('C:/app','windows'));
  assert.notEqual(normalizeProjectPath('/repo/link','macos'),normalizeProjectPath('/repo/real','macos'));
  assert.equal(normalizeProjectPath('C:relative','windows'),null);
  assert.equal(normalizeProjectPath('relative','macos'),null);
  assert.equal(normalizeProjectPath('/bad\npath','macos'),null);
});
