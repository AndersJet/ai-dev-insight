import {test} from 'node:test';import assert from 'node:assert/strict';import {TodayOverview} from '../src/today-overview.js';
import {PluginHttpError} from '../src/http-client.js';
test('offline overview is scoped to the same owner, site and Beijing day, and late replies cannot refill cleared data',async()=>{
  let now=Date.parse('2026-10-09T01:00:00Z'),offline=false;let release:((value:unknown)=>void)|undefined;
  const saved=new Map<string,unknown>();const cache={get:(key:string)=>saved.get(key),update:async(key:string,value:unknown)=>{saved.set(key,value);}};
  const today=new TodayOverview(cache,()=>now);
  const dto={business_date:'2026-10-09',as_of:'2026-10-09T01:00:00Z',official_chat_tokens:null,official_cue_tokens:'12',hook_sessions:2,prompt_turns:3,cleanup_generation:0};
  const fetcher=async()=>{if(offline)throw new Error('offline');return dto;};
  await today.refresh('owner-site',fetcher);assert.equal(today.snapshot().stale,false);
  offline=true;await today.refresh('owner-site',fetcher);assert.equal(today.snapshot().stale,true);
  now=Date.parse('2026-10-09T16:01:00Z');await today.refresh('owner-site',fetcher);assert.equal(today.snapshot().data,null);
  now=Date.parse('2026-10-09T01:00:00Z');const pending=today.refresh('owner-site',()=>new Promise(resolve=>{release=resolve;}));await today.clear();release?.(dto);await pending;assert.equal(today.snapshot().data,null);
});
test('a fresh host can show the matching persisted overview offline, but explicit platform barriers remove it',async()=>{
  const now=Date.parse('2026-10-09T01:00:00Z'),dto={business_date:'2026-10-09',as_of:'2026-10-09T01:00:00Z',official_chat_tokens:'100',official_cue_tokens:null,hook_sessions:1,prompt_turns:2,cleanup_generation:0};
  for(const barrier of [new PluginHttpError(409,'content_changed'),new PluginHttpError(503,'collection_disabled'),new PluginHttpError(503,'recovery_quarantined')]){
    const values=new Map<string,unknown>([['today-summary-v1',{scope:'owner-site',business_date:'2026-10-09',data:dto}]]),cache={get:(key:string)=>values.get(key),update:async(key:string,value:unknown)=>{values.set(key,value);}};
    const overview=new TodayOverview(cache,()=>now);await overview.refresh('owner-site',async()=>{throw new Error('offline');});assert.equal(overview.snapshot().data?.official_chat_tokens,'100');assert.equal(overview.snapshot().stale,true);
    await assert.rejects(overview.refresh('owner-site',async()=>{throw barrier;}));assert.equal(overview.snapshot().data,null);assert.equal(values.get('today-summary-v1'),undefined);
  }
});
test('the overview and status getters discard yesterday at midnight even while no refresh is running',async()=>{
  let now=Date.parse('2026-10-09T15:59:00Z');const values=new Map<string,unknown>(),cache={get:(key:string)=>values.get(key),update:async(key:string,value:unknown)=>{values.set(key,value);}};
  const overview=new TodayOverview(cache,()=>now);await overview.refresh('owner-site',async()=>({business_date:'2026-10-09',as_of:'2026-10-09T15:59:00Z',official_chat_tokens:'100',official_cue_tokens:null,hook_sessions:1,prompt_turns:2,cleanup_generation:0}));
  now=Date.parse('2026-10-09T16:01:00Z');assert.equal(overview.snapshot().data,null);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(values.get('today-summary-v1'),undefined);
});

test('official breakdown survives offline restart, old servers remain usable, and malformed new fields are rejected',async()=>{
 const now=Date.parse('2026-10-09T01:00:00Z'),saved=new Map<string,unknown>(),cache={get:(key:string)=>saved.get(key),update:async(key:string,value:unknown)=>{saved.set(key,value);}};
 const dto={business_date:'2026-10-09',as_of:'2026-10-09T01:00:00Z',official_chat_tokens:'100',official_cue_tokens:null,hook_sessions:1,prompt_turns:2,cleanup_generation:0};
 const q=(tokens:string|null,known_tokens=tokens??'0',missing_token_records=0)=>({tokens,known_tokens,missing_token_records});
 const usage={records:1,...q('100'),calls:'2',known_calls:'2',missing_call_records:0,token_breakdown:{input:q('90'),output:q('10'),cache_read:q(null,'0',1),cache_creation:q('0')}};
 const today=new TodayOverview(cache,()=>now);await today.refresh('owner-site',async()=>({...dto,official_chat_usage:usage}));
 assert.equal(today.snapshot().data?.official_chat_usage?.token_breakdown.cache_read.tokens,null);
 const restarted=new TodayOverview(cache,()=>now);await restarted.refresh('owner-site',async()=>{throw new Error('offline');});assert.equal(restarted.snapshot().stale,true);assert.equal(restarted.snapshot().data?.official_chat_usage?.calls,'2');
 await restarted.refresh('owner-site',async()=>dto);assert.equal(restarted.snapshot().data?.official_chat_usage,undefined);assert.equal(restarted.snapshot().data?.official_chat_tokens,'100');
 await restarted.refresh('owner-site',async()=>({...dto,official_chat_usage:{...usage,token_breakdown:{...usage.token_breakdown,input:q('-1')}}}));assert.equal(restarted.snapshot().stale,true);assert.equal(restarted.snapshot().data?.official_chat_usage,undefined);
});
