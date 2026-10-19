import {analysisHtml} from './analysis-ui.js';
export {analysisHtml} from './analysis-ui.js';
import type * as VSCode from 'vscode';
import {randomBytes} from 'node:crypto';
import {platformRequest} from './platform-session.js';
import {PluginHttpError} from './http-client.js';
import {saveAnalysis} from './analysis-package.js';


export function openTokenAnalysis(vscode:typeof VSCode,binding:{origin:string;api_token:string},valid:()=>boolean){
  const panel=vscode.window.createWebviewPanel('adiTokenAnalysis','Token能效分析',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
  const abort=new AbortController();let busy=false;const nonce=randomBytes(18).toString('base64url');
  const poll=setInterval(()=>{if(!valid())panel.dispose();},500);poll.unref();
  panel.onDidDispose(()=>{clearInterval(poll);abort.abort();});
  const guard=()=>{if(abort.signal.aborted||!valid())throw new Error('登录或平台已变化，请重新打开分析窗口');};
  const fs=vscode.workspace.fs;
  let savedMaterial:Awaited<ReturnType<typeof saveAnalysis<VSCode.Uri>>>|undefined;
  panel.webview.onDidReceiveMessage(async(message:unknown)=>{
    if(!message||typeof message!=='object'||busy)return;
    const input=message as {op?:string;query?:Record<string,unknown>;ids?:string[]};busy=true;
    try{
      guard();
      if(input.op==='list'){
        const reply=await platformRequest(binding.origin,'/api/v1/plugin/analysis/sessions',abort.signal,{method:'POST',body:input.query??{},headers:{Authorization:`Bearer ${binding.api_token}`},maxBytes:1024*1024,timeout:30000});guard();
        await panel.webview.postMessage({type:'list',data:reply.data});
      }else if(input.op==='copy'||input.op==='open-folder'){
        if(!savedMaterial)throw new Error('请先下载分析材料');
        if(input.op==='copy'){await vscode.env.clipboard.writeText(savedMaterial.prompt);guard();await panel.webview.postMessage({type:'copied'});}
        else {await vscode.commands.executeCommand('revealInExplorer',savedMaterial.directory);guard();await panel.webview.postMessage({type:'folder-opened'});}
      }else if(input.op==='download'){
        if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>20||input.ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new Error('请选择1至20个会话');
        if(!vscode.workspace.isTrusted)throw new Error('请先信任当前项目，再保存分析材料');
        const roots=vscode.workspace.workspaceFolders??[];if(!roots.length)throw new Error('请先打开项目文件夹');
        const root=roots.length===1?roots[0]:await vscode.window.showWorkspaceFolderPick({placeHolder:'选择分析材料保存的项目根目录'});if(!root)throw new Error('已取消保存');guard();
        const rootKey=root.uri.toString();const current=()=>!abort.signal.aborted&&valid()&&vscode.workspace.isTrusted&&(vscode.workspace.workspaceFolders??[]).some(f=>f.uri.toString()===rootKey);
        const reply=await platformRequest(binding.origin,'/api/v1/plugin/analysis/package',abort.signal,{method:'POST',body:{session_ids:input.ids},headers:{Authorization:`Bearer ${binding.api_token}`},binary:true,maxBytes:32*1024*1024,timeout:60000});guard();
        const hash=reply.headers['x-content-sha256'];if(typeof hash!=='string'||!Buffer.isBuffer(reply.data))throw new Error('分析包响应不正确');
        const saved=await saveAnalysis({join:(uri,...parts)=>vscode.Uri.joinPath(uri,...parts),stat:async uri=>fs.stat(uri),read:async uri=>fs.readFile(uri),mkdir:async uri=>fs.createDirectory(uri),write:async(uri,body)=>fs.writeFile(uri,body),rename:async(from,to)=>fs.rename(from,to,{overwrite:false}),remove:async uri=>fs.delete(uri,{recursive:true,useTrash:false})},root.uri,reply.data,hash,current);
        guard();savedMaterial=saved;await panel.webview.postMessage({type:'saved',prompt:saved.prompt,path:saved.relative});
      }
    }catch(error){
      if(!abort.signal.aborted){const code=error instanceof PluginHttpError?error.reason:undefined;const hints:Record<string,string>={analysis_too_large:'材料过大，请减少所选会话',plugin_unauthorized:'API码无效，请重新登录绑定',invalid_period:'请选择最近45天内的有效日期',content_changed:'材料已变化，请重新选择下载'};
        await panel.webview.postMessage({type:'error',clear:error instanceof PluginHttpError&&[401,403,409,410].includes(error.status),message:code?hints[code]??'读取或下载失败，请重试':error instanceof Error?error.message:'操作失败，请重试'});}
    }finally{busy=false;}
  });
  panel.webview.html=analysisHtml(nonce);
  return panel;
}
