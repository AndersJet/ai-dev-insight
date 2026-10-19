import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {mkdtemp,mkdir,writeFile,stat,rename,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unpackAnalysis,saveAnalysis} from '../src/analysis-package.js';
function fixture(){
 const id=randomUUID();const files:Record<string,Uint8Array>={};
 for(const path of ['prompt.md','report-template.html','README.md','official-usage.json',`sessions/${id}.json`])files[path]=strToU8('合成内容');
 files['manifest.json']=strToU8(JSON.stringify({version:'token-efficiency-v1',session_ids:[id],files:Object.entries(files).map(([path,value])=>({path,bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')}))}));
 const zip=zipSync(files),hash=createHash('sha256').update(zip).digest('hex');return {zip,hash,files};
}
test('archive rejects tampering, path traversal and manifest mismatch before writes',()=>{
 const {zip,hash,files}=fixture();assert.ok(unpackAnalysis(zip,hash)['prompt.md']);assert.throws(()=>unpackAnalysis(zip,'0'.repeat(64)));
 for(const evil of [{...files,'../escape':strToU8('bad')},{...files,'prompt.md':strToU8('tampered')}]){const z=zipSync(evil);assert.throws(()=>unpackAnalysis(z,createHash('sha256').update(z).digest('hex')));}
});
test('local material is fully extracted, retained zip is intact and timestamp collisions never overwrite',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));const {zip,hash}=fixture();
 const fs={join,stat:async(p:string)=>{const s=await stat(p);return {type:s.isDirectory()?2:1};},read:readFile,mkdir:async(p:string)=>{await mkdir(p,{recursive:true});},write:writeFile,rename,remove:async(p:string)=>{await rm(p,{recursive:true,force:true});}};
 const date=new Date('2026-10-19T02:26:00Z');const a=await saveAnalysis(fs,root,zip,hash,()=>true,date),b=await saveAnalysis(fs,root,zip,hash,()=>true,date);
 assert.equal(a.relative,'.ai-dev-insight/analysis/20261019102600');assert.notEqual(a.relative,b.relative);assert.equal(await readFile(join(a.directory,'prompt.md'),'utf8'),'合成内容');assert.deepEqual(await readFile(join(a.directory,'analysis.zip')),Buffer.from(zip));
});
test('remote URI provider writes exclusively within SSH root and failed writes remove incomplete staging',async()=>{
 const {zip,hash}=fixture(),root='vscode-remote://ssh-remote+synthetic/home/project';const entries=new Map<string,Uint8Array|undefined>([[root,undefined],[root+'/.gitignore',strToU8('node_modules/\n')]]);let fail=false;
 const fs={join:(p:string,...parts:string[])=>p+'/'+parts.join('/'),stat:async(p:string)=>{if(!entries.has(p))throw Object.assign(new Error(),{code:'FileNotFound'});return {type:entries.get(p)?1:2};},read:async(p:string)=>entries.get(p)!,mkdir:async(p:string)=>{entries.set(p,undefined);},write:async(p:string,b:Uint8Array)=>{assert.ok(p.startsWith(root+'/'));if(fail&&p.endsWith('prompt.md'))throw new Error('transport disconnected');entries.set(p,b);},rename:async(a:string,b:string)=>{for(const [key,value] of [...entries])if(key===a||key.startsWith(a+'/')){entries.delete(key);entries.set(b+key.slice(a.length),value);}},remove:async(p:string)=>{for(const key of entries.keys())if(key===p||key.startsWith(p+'/'))entries.delete(key);}};
 const result=await saveAnalysis(fs,root,zip,hash,()=>true);assert.ok(entries.has(result.directory+'/prompt.md'));assert.equal(new TextDecoder().decode(entries.get(root+'/.gitignore')),'node_modules/\n/.ai-dev-insight/\n');assert.ok([...entries.keys()].every(p=>p.startsWith(root)));
 fail=true;await assert.rejects(saveAnalysis(fs,root,zip,hash,()=>true),/disconnected/);assert.ok(![...entries.keys()].some(k=>k.includes('.pending-')));
 await assert.rejects(saveAnalysis(fs,root,zip,hash,()=>false),/账号或工作区/);
});

test('downloads append an ignore rule to existing .gitignore, preserve CRLF and never create an absent file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-analysis-ignore-'));t.after(()=>rm(root,{recursive:true,force:true}));const {zip,hash}=fixture();
 const fs={join,stat:async(p:string)=>{const s=await stat(p);return {type:s.isDirectory()?2:1};},read:readFile,mkdir:async(p:string)=>{await mkdir(p,{recursive:true});},write:writeFile,rename,remove:async(p:string)=>{await rm(p,{recursive:true,force:true});}};
 await saveAnalysis(fs,root,zip,hash,()=>true);await assert.rejects(readFile(join(root,'.gitignore')),{code:'ENOENT'});
 await writeFile(join(root,'.gitignore'),'\ufeffnode_modules/\r\n# 保留原有规则');
 await saveAnalysis(fs,root,zip,hash,()=>true);const first=await readFile(join(root,'.gitignore'),'utf8');assert.equal(first,'\ufeffnode_modules/\r\n# 保留原有规则\r\n/.ai-dev-insight/\r\n');
 await saveAnalysis(fs,root,zip,hash,()=>true);assert.equal(await readFile(join(root,'.gitignore'),'utf8'),first);
 await writeFile(join(root,'.gitignore'),'.ai-dev-insight/\n!*\n');await saveAnalysis(fs,root,zip,hash,()=>true);assert.equal(await readFile(join(root,'.gitignore'),'utf8'),'.ai-dev-insight/\n!*\n/.ai-dev-insight/\n');
});
