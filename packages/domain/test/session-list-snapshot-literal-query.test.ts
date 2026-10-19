import {test} from 'node:test';
import assert from 'node:assert/strict';
import {literalPromptQuery} from '../src/session-list-snapshot-reading.js';

test('literal query decodes LIKE escapes without JavaScript case folding',()=>{
 const query=literalPromptQuery(String.raw`%a\%\_\\b%`);assert.equal(query?.literal,'a%_\\b');
 assert.equal(literalPromptQuery('%İABC%')?.literal,'İABC','only the PostgreSQL caller may lowercase');
 for(const pattern of ['abc','%abc_%','%abc%%','%a\\%','%\0%','%\ud800%'])assert.equal(literalPromptQuery(pattern),null);
});

test('packed query uses full Unicode codepoints and exact signed bigint values',()=>{
 assert.deepEqual(literalPromptQuery('%abc%')?.grams,['426610717098083']);
 assert.deepEqual(literalPromptQuery('%\u{10ffff}\u{10ffff}\u{10ffff}%')?.grams,['4899914332993814527']);
 assert.deepEqual(literalPromptQuery('%😀猫%')?.grams,[],'two Unicode codepoints cannot supply a three-codepoint gram');
 assert.deepEqual(literalPromptQuery('%%')?.grams,[]);
 const repeated=literalPromptQuery('%aaaaa%');assert.equal(repeated?.literal.length,5);assert.equal(repeated?.grams.length,1,'a singleton set does not authorize an exact-three shortcut');
});
