import {test} from 'node:test';import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';import {overviewHtml} from '../src/overview-ui.js';
class Element {open=false;setAttribute(){}addEventListener(){}disabled=false;hidden=false;textContent='';className='';classList={toggle(){}};value='';required=false;dataset:{op?:string}={};onclick:(()=>void)|undefined;onsubmit:unknown;children:unknown[]=[];replaceChildren(...items:unknown[]){this.children=items;}append(item:unknown){this.children.push(item);}add(item:unknown){this.children.push(item);}}
function renderer(){
 const html=overviewHtml(),elements=new Map<string,Element>(),buttons=new Map<string,Element>(),sent:{op:string}[]=[];let receive!:(event:unknown)=>void;
 const el=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
 for(const match of html.matchAll(/<button\b([^>]*)>/g)){const attrs=match[1]!,id=attrs.match(/\bid="([^"]+)"/)?.[1],op=attrs.match(/data-op="([^"]+)"/)?.[1],button=id?el(id):new Element();button.disabled=/\bdisabled\b/.test(attrs);if(op){button.dataset.op=op;buttons.set(op,button);}}
 const query=(selector:string):Element[]=>{
  if(selector==='[data-op]')return [...buttons.values()];
  if(selector==='#verification-controls button')return ['verification-check','verification-pass','verification-fail'].map(op=>buttons.get(op)!);
  if(selector==='#verification-guide button')return ['verification-global','verification-local','verification-platform','verification-session'].map(op=>buttons.get(op)!);
  if(selector.startsWith('#'))return [el(selector.slice(1))];
  const op=selector.match(/^\[data-op=["']?([^\]"']+)["']?\]$/)?.[1];return op&&buttons.has(op)?[buttons.get(op)!]:[];
 };
 const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
 runInNewContext(script,{acquireVsCodeApi:()=>({postMessage:(m:{op:string})=>sent.push(m)}),document:{getElementById:el,querySelectorAll:query,querySelector:(selector:string)=>query(selector)[0],createElement:()=>new Element()},setInterval:()=>0,clearInterval(){},window:{addEventListener:(_name:string,fn:typeof receive)=>{receive=fn;}}});
 const verification={result:'active',started:Date.now(),deadline:Date.now()+900000,checks:{plugin:true,account:true,hook:true,version:true,statistics:true},confirmed:{global:false,local:false,session:false},canPass:false,readOnly:false,finalizing:false};
 const state={origin:'http://example.invalid',email:'synthetic@example.invalid',busy:false,today:{data:null,stale:false},verification,recovery:{busy:false,blocked:false},updates:{version:'1.0.4',phase:'ready',message:'ready'}};
 return {buttons,sent,state,send:(value:unknown)=>receive({data:{type:'state',state:value}})};
}

test('verification controls recover after preflight or repair busy state and still dispatch their actions',()=>{
 const f=renderer();f.send({...f.state,recovery:{busy:true,blocked:true}});for(const op of ['verification-check','verification-platform','verification-global'])assert.equal(f.buttons.get(op)!.disabled,true);
 f.send(f.state);for(const op of ['verification-check','verification-platform','verification-global','verification-local'])assert.equal(f.buttons.get(op)!.disabled,false,op+' must be re-enabled');
 f.buttons.get('verification-check')!.onclick!();f.buttons.get('verification-platform')!.onclick!();assert.ok(f.sent.some(v=>v.op==='verification-check'));assert.ok(f.sent.some(v=>v.op==='verification-platform'));
 assert.equal(f.buttons.get('verification-pass')!.disabled,true,'preflight must not confirm a real session');
});
test('recovery completion does not override readonly verification or updater guards',()=>{
 const f=renderer();f.send({...f.state,recovery:{busy:true,blocked:true}});
 f.send({...f.state,verification:{...f.state.verification,readOnly:true,canPass:true},updates:{...f.state.updates,phase:'installing'}});
 for(const op of ['verification-pass','verification-fail','verification-global','verification-local','verification-session','update-apply'])assert.equal(f.buttons.get(op)!.disabled,true,op);
 assert.equal(f.buttons.get('verification-check')!.disabled,false,'observer can refresh status');
});
