import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputCacheHitRate } from '../src/lib/official-usage-quantities.js';
import type { SessionOfficialUsageDto } from '@adi/contracts';
function group(input:string|null,read:string|null):SessionOfficialUsageDto['groups'][number] {
 const quantity=(tokens:string|null)=>({tokens,known_tokens:tokens??'0',missing_token_records:tokens===null?1:0});
 return {model_name:'synthetic',scene:'Chat',client:'ide',model_source:'Trae',consumption_source:'basic',currency:null,records:1,tokens:null,known_tokens:'0',missing_token_records:1,calls:'1',known_calls:'1',missing_call_records:0,amount:null,known_amount:null,unknown_amount_records:1,amount_missing_reasons:[],quality_records:0,
  token_breakdown:{input:quantity(input),output:quantity('0'),cache_read:quantity(read),cache_creation:quantity('0')}};
}
test('input cache hit rate uses weighted input token counts rather than averaging per-model percentages',()=>{
 assert.equal(inputCacheHitRate([group('100','100'),group('900','0')]),'10.00%');
 assert.equal(inputCacheHitRate([group('1000','0')]),'0.00%');
 assert.equal(inputCacheHitRate([group('3','2')]),'66.67%');
 assert.equal(inputCacheHitRate([group('900719925474099300000','450359962737049650000')]),'50.00%');
});
test('missing fields, zero input and inconsistent counters cannot produce a cache hit rate',()=>{
 for(const rows of [[],[group(null,'0')],[group('100',null)],[group('0','0')],[group('100','101')],[group('100','90'),group('100',null)]])assert.equal(inputCacheHitRate(rows),undefined);
 const legacy=group('100','90');delete legacy.token_breakdown;assert.equal(inputCacheHitRate([legacy]),undefined);
});
