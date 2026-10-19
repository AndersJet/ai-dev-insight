import {lstat,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {PluginReleaseDto} from '@adi/contracts';

async function json(path:string):Promise<Record<string,unknown>|undefined>{
 const info=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return;throw error;});
 if(!info)return;
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw new Error('unsafe_extension_metadata');
 const value:unknown=JSON.parse(await readFile(path,'utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_extension_metadata');
 return value as Record<string,unknown>;
}

/** Check the universal VSIX layout next to the running extension, including pending removal. */
export async function isPluginBuildInstalled(extensionPath:string,release:PluginReleaseDto):Promise<boolean>{
 const root=dirname(extensionPath),folder=`ai-dev-insight.adi-project-tracker-${release.version}`;
 const obsolete=await json(join(root,'.obsolete'));
 if(obsolete?.[folder]===true)return false;
 const manifest=await json(join(root,folder,'package.json'));
 return manifest?.publisher==='ai-dev-insight'&&manifest.name==='adi-project-tracker'&&manifest.version===release.version&&manifest.adiBuildId===release.build_id;
}
