import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {type,release,version,arch,machine} from 'node:os';
export async function verificationEnvironment(appRoot:string,core:string,plugin:string,build:string){
  let trae='unknown';
  try{const path=join(appRoot,'product.json'),info=await lstat(path);if(appRoot&&info.isFile()&&!info.isSymbolicLink()&&info.size<1048576){const product=JSON.parse(await readFile(path,'utf8'));if(typeof product.appVersion==='string'&&/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9]+)*$/.test(product.appVersion))trae=product.appVersion;}}catch{/* Unknown is preferable to labelling the VS Code core as Trae. */}
  return {os:type(),os_release:release(),os_version:version().slice(0,160),os_machine:machine(),architecture:arch(),trae_version:trae,vscode_version:core, node_version:process.versions.node,plugin_version:plugin,plugin_build:build};
}
