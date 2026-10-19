import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {PluginHttpError} from '../src/http-client.js';

test('panel copies and reveals only host-validated saved materials; stale identity cannot act',async()=>{
 let valid=true,handler:(m:unknown)=>Promise<void>=async()=>{},copied='',revealed:unknown;
 const posted:Record<string,unknown>[]=[],uri={toString:()=> 'file:///synthetic-project'},directory={toString:()=> 'file:///synthetic-project/.ai-dev-insight/analysis/synthetic'};
 const panel={onDidDispose(){},dispose(){},webview:{html:'',onDidReceiveMessage(fn:typeof handler){handler=fn;},async postMessage(m:Record<string,unknown>){posted.push(m);}}};
 const sdk={ViewColumn:{Active:-1},window:{createWebviewPanel:()=>panel},workspace:{fs:{},isTrusted:true,workspaceFolders:[{uri}]},env:{clipboard:{async writeText(value:string){copied=value;}}},commands:{async executeCommand(command:string,value:unknown){assert.equal(command,'revealInExplorer');revealed=value;}},Uri:{joinPath(){}}};
 const replace:Record<string,unknown>={'./analysis-ui.js':{analysisHtml:()=>'<synthetic>'},'./http-client.js':{PluginHttpError},'./platform-session.js':{platformRequest:async()=>({headers:{'x-content-sha256':'synthetic'},data:Buffer.from('zip')})},'./analysis-package.js':{saveAnalysis:async()=>({prompt:'根据 .ai-dev-insight/analysis/synthetic/prompt.md 执行本次Token能效分析任务',directory,relative:'.ai-dev-insight/analysis/synthetic'})}};
 const {code}=await transform(await readFile(new URL('../src/analysis-panel.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'});
 const actualRequire=createRequire(import.meta.url),module={exports:{} as {openTokenAnalysis:typeof import('../src/analysis-panel.js').openTokenAnalysis}};
 runInNewContext(code,{module,exports:module.exports,require:(name:string)=>replace[name]??actualRequire(name),Buffer,AbortController,setInterval:()=>({unref(){}}),clearInterval(){}});
 module.exports.openTokenAnalysis(sdk as never,{origin:'http://example.invalid',api_token:'synthetic'},()=>valid);
 await handler({op:'copy',prompt:'forged'});assert.equal(copied,'');assert.match(String(posted.at(-1)?.message),/请先下载/);
 await handler({op:'download',ids:['c12825c1-f7f2-499b-91de-dc32e164227d']});assert.equal(posted.at(-1)?.type,'saved');
 await handler({op:'copy',prompt:'forged'});assert.match(copied,/synthetic\/prompt.md/);assert.equal(posted.at(-1)?.type,'copied');
 await handler({op:'open-folder',path:'/forged'});assert.equal(revealed,directory);assert.equal(posted.at(-1)?.type,'folder-opened');
 valid=false;copied='';await handler({op:'copy'});assert.equal(copied,'');assert.equal(posted.at(-1)?.type,'error');
});
