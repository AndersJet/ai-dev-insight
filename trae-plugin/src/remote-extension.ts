import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {RemoteRuntime,linuxBoot} from './remote-runtime.js';
import {REMOTE_COMMAND,FORWARD_COMMAND} from './remote-protocol.js';
import {probeProject} from './git-probe.js';
declare const __ADI_PLUGIN_BUILD_ID__:string;
let runtime:RemoteRuntime|undefined;
export async function activate(context:vscode.ExtensionContext){
  if(process.platform!=='linux'||vscode.env.remoteName!=='ssh-remote')return;
  runtime=new RemoteRuntime({build:__ADI_PLUGIN_BUILD_ID__,node:process.execPath,boot:await linuxBoot(),sender:await readFile(join(context.extensionPath,'dist','remote-hook-sender.cjs')),trusted:()=>vscode.workspace.isTrusted,
    roots:()=>[...new Set((vscode.workspace.workspaceFolders??[]).filter(f=>['file','vscode-remote'].includes(f.uri.scheme)).map(f=>f.uri.fsPath))],
    probe:(root,signal)=>{const configured=vscode.workspace.getConfiguration('git').get<string|string[]>('path');return probeProject(root,signal,typeof configured==='string'?configured:Array.isArray(configured)?configured[0]??'git':'git');},
    forward:input=>vscode.commands.executeCommand(FORWARD_COMMAND,input)});
  const current=runtime;context.subscriptions.push(vscode.commands.registerCommand(REMOTE_COMMAND,(input:unknown)=>current.command(input)),vscode.workspace.onDidChangeWorkspaceFolders(()=>void current.stop()),{dispose:()=>void current.dispose()});
}
export async function deactivate(){await runtime?.dispose();runtime=undefined;}
