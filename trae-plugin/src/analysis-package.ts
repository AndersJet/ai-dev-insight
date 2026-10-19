import {createHash,randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
const maximum=48*1024*1024;
const allowed=(name:string)=>['prompt.md','report-template.html','README.md','official-usage.json','manifest.json'].includes(name)||/^sessions\/[a-f0-9-]{36}\.json$/.test(name);
export function unpackAnalysis(bytes:Uint8Array,expectedHash:string){
  if(bytes.length>32*1024*1024||!/^[a-f0-9]{64}$/.test(expectedHash)||createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw new Error('分析包校验失败，请重新下载');
  let expanded=0;const seen=new Set<string>();
  const files=unzipSync(bytes,{filter:file=>{
    expanded+=file.originalSize;
    if(!allowed(file.name)||seen.has(file.name)||seen.size>=32||file.originalSize>maximum||expanded>maximum+65536)throw new Error('分析包内容或大小不正确');
    seen.add(file.name);return true;
  }});
  const raw=files['manifest.json'];if(!raw)throw new Error('分析包缺少清单');
  const manifest=JSON.parse(strFromU8(raw)) as {version:string;session_ids:string[];files:{path:string;bytes:number;sha256:string}[]};
  if(manifest.version!=='token-efficiency-v1'||!Array.isArray(manifest.session_ids)||!manifest.session_ids.length||manifest.session_ids.length>20||new Set(manifest.session_ids).size!==manifest.session_ids.length||manifest.session_ids.some(id=>!/^[a-f0-9-]{36}$/.test(id))||!Array.isArray(manifest.files)||manifest.files.length!==Object.keys(files).length-1)throw new Error('分析包清单不正确');
  const listed=new Set<string>();
  for(const entry of manifest.files){const file=files[entry.path];if(listed.has(entry.path)||entry.path==='manifest.json'||!allowed(entry.path)||!file||file.length!==entry.bytes||createHash('sha256').update(file).digest('hex')!==entry.sha256)throw new Error('分析包文件校验失败');listed.add(entry.path);}
  for(const name of ['prompt.md','report-template.html','README.md','official-usage.json',...manifest.session_ids.map(id=>`sessions/${id}.json`)])if(!listed.has(name))throw new Error('分析包文件不完整');
  return files;
}
export interface AnalysisFileSystem<T>{join:(root:T,...parts:string[])=>T;stat:(uri:T)=>Promise<{type:number}>;read:(uri:T)=>Promise<Uint8Array>;mkdir:(uri:T)=>Promise<void>;write:(uri:T,body:Uint8Array)=>Promise<void>;rename:(from:T,to:T)=>Promise<void>;remove:(uri:T)=>Promise<void>}
/** URI operations keep SSH roots remote; authentication never crosses this boundary. */
export async function saveAnalysis<T>(fs:AnalysisFileSystem<T>,root:T,zip:Uint8Array,hash:string,valid:()=>boolean,date=new Date()){
  const files=unpackAnalysis(zip,hash);const check=()=>{if(!valid())throw new Error('账号或工作区已变化，请重新分析');};
  check();
  const exists=async(uri:T)=>{try{return await fs.stat(uri);}catch(e){if((e as {code?:string}).code==='FileNotFound'||(e as {code?:string}).code==='ENOENT')return null;throw e;}};
  const ignore=fs.join(root,'.gitignore'),ignoreState=await exists(ignore);
  if(ignoreState){
    if(ignoreState.type&64||!(ignoreState.type&1))throw new Error('.gitignore 不是普通文件，请检查后重试');
    const bytes=await fs.read(ignore),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),lines=text.split(/\r?\n/);
    const lastRule=lines.reduce((last,line,index)=>/^\/?\.ai-dev-insight\/?$/.test(line.trim())?index:last,-1);
    if(lastRule<0||lines.slice(lastRule+1).some(line=>line.trim().startsWith('!'))){
      const newline=text.includes('\r\n')?'\r\n':'\n';check();
      await fs.write(ignore,new TextEncoder().encode(text+(text&&!text.endsWith('\n')?newline:'')+'/.ai-dev-insight/'+newline));
    }
  }
  for(const uri of [fs.join(root,'.ai-dev-insight'),fs.join(root,'.ai-dev-insight','analysis')]){
    check();const state=await exists(uri);if(state&&(state.type&64||!(state.type&2)))throw new Error('分析目录不是可写的普通目录');if(!state)await fs.mkdir(uri);
  }
  const base=fs.join(root,'.ai-dev-insight','analysis');
  const stamp=new Date(date.getTime()+28800000).toISOString().replace(/[-:T]/g,'').slice(0,14);
  let name=stamp;let destination=fs.join(base,name);
  if(await exists(destination)){name=stamp+'-'+randomUUID().slice(0,8);destination=fs.join(base,name);}
  const staging=fs.join(base,'.pending-'+randomUUID());await fs.mkdir(staging);
  try{
    await fs.mkdir(fs.join(staging,'sessions'));
    for(const [path,body] of Object.entries(files)){check();await fs.write(fs.join(staging,...path.split('/')),body);}
    check();await fs.write(fs.join(staging,'analysis.zip'),zip);check();await fs.rename(staging,destination);
    if(!valid()){await fs.remove(destination);throw new Error('账号或工作区已变化，请重新分析');}
  }catch(error){await fs.remove(staging).catch(()=>{});throw error;}
  const relative=`.ai-dev-insight/analysis/${name}`;
  return {directory:destination,relative,prompt:`根据 ${relative}/prompt.md 执行本次Token能效分析任务，将结果保存为该目录下的分析结果.html。`};
}
