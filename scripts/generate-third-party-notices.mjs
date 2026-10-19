import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import process from 'node:process';
import console from 'node:console';

// Use installed package archives, not pnpm's optional global store indexes.
const packages=new Map(),virtual='node_modules/.pnpm';
for(const entry of await readdir(virtual,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name==='node_modules')continue;
  const directory=join(virtual,entry.name,'node_modules');
  let children;try{children=await readdir(directory,{withFileTypes:true});}catch{continue;}
  for(const child of children){
    if(!child.isDirectory())continue;
    const base=join(directory,child.name),targets=child.name.startsWith('@')?(await readdir(base,{withFileTypes:true})).filter(value=>value.isDirectory()).map(value=>join(base,value.name)):[base];
    for(const target of targets){
      const metadata=JSON.parse(await readFile(join(target,'package.json'),'utf8')),key=metadata.name+'@'+metadata.version;
      if(packages.has(key))continue;
      const declared=typeof metadata.license==='string'?metadata.license:metadata.license?.type;
      if(!declared)throw new Error('Missing declared dependency license: '+key);
      const source=typeof metadata.repository==='string'?metadata.repository:metadata.repository?.url;
      const raw=metadata.homepage??source??'',url=String(raw).replace(/^git\+/,'').replace(/^git:\/\//,'https://').replace(/\.git$/,'');
      let upstream='';try{const parsed=new globalThis.URL(url);if(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)upstream=parsed.href;}catch{/* metadata may omit a public URL */}
      const files=(await readdir(target,{withFileTypes:true})).filter(file=>file.isFile()&&/^(?:licen[cs]e|copying|notice|third[-_]party[-_]licen[cs]e)(?:$|[._-])/i.test(file.name)).map(file=>file.name).sort();
      const texts=[];for(const file of files)texts.push(file+'\n'+await readFile(join(target,file),'utf8'));
      if(texts.length===0){
        const readme=(await readdir(target)).find(name=>/^readme(?:$|\.)/i.test(name));
        if(readme){const text=await readFile(join(target,readme),'utf8'),match=/^(?:#{1,6}\s+)?(?:licen[cs]e|copyright|copying)\b[^\n]*\n(?:[-=]{3,}\s*\n)?/im.exec(text);if(match)texts.push(readme+' (license section)\n'+text.slice(match.index));}
      }
      packages.set(key,{key,license:declared,upstream,texts,author:typeof metadata.author==='string'?metadata.author:metadata.author?.name??''});
    }
  }
}
if(packages.size===0)throw new Error('Install frozen dependencies before generating notices');
const supplements=JSON.parse(await readFile('third_party/upstream-licenses.json','utf8'));
for(const entry of packages.values()){
  const [name,version]=[entry.key.slice(0,entry.key.lastIndexOf('@')),entry.key.slice(entry.key.lastIndexOf('@')+1)];
  const parent=name.startsWith('@esbuild/')?'esbuild@'+version:name.startsWith('@rolldown/binding-')?'rolldown@'+version:null;
  if(parent&&entry.texts.length===0){const source=packages.get(parent);if(source?.license===entry.license&&source.texts.length)entry.texts.push('Matching upstream project '+parent+'\n'+source.texts.join('\n\n'));}
  const supplement=supplements[entry.key];
  if(supplement){if(!/^[a-zA-Z0-9._-]+$/.test(supplement.file))throw new Error('Invalid supplemental license filename');entry.texts.push('Supplemental source: '+supplement.source+'\n'+(supplement.note??'')+'\n'+await readFile(join('third_party/licenses',supplement.file),'utf8'));if(!entry.upstream)entry.upstream=supplement.source;}
}

const sorted=[...packages.values()].sort((a,b)=>a.key.localeCompare(b.key)),escape=value=>value.replaceAll('|','\\|').replaceAll('\n',' ');
const summary='# Third-party dependency notices\n\nGenerated from the installed locked dependency tree. Development tools and optional platform packages are included when installed; this is not an assertion that every listed package is bundled into every artifact. Project licensing does not replace these upstream terms.\n\nLicense/notice texts provided by package archives, matching-version parent packages and documented upstream supplements are retained in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). When an archive omits a standalone text, its declared license, available README license section, author metadata and upstream reference are preserved. Supplements are documented in third_party/upstream-licenses.json; standard terms supplied for an explicitly declared MIT license are labeled and are not presented as an original upstream notice. Runtime Node images also retain the original installed package archives and their license files.\n\nRegenerate after dependency changes with `pnpm notices:generate`; do not edit generated entries by hand.\n\n| Package | Declared license | Upstream | License material |\n| --- | --- | --- | --- |\n'+sorted.map(p=>'| '+escape(p.key)+' | '+escape(p.license)+' | '+(p.upstream?'[upstream]('+p.upstream+')':'Not specified')+' | '+(p.texts.length?'Included; provenance in full text':'Declaration only; upstream reference')+' |').join('\n')+'\n';
const full='Third-party license and attribution materials\nProject: AI Dev Insight\nPackage archives retain their original licensing; the project license does not relicense dependencies.\n\n'+sorted.map(p=>'='.repeat(72)+'\n'+p.key+'\nAuthor (package metadata): '+(p.author||'Not specified')+'\nDeclared license: '+p.license+'\nUpstream: '+(p.upstream||'Not specified')+'\n\n'+(p.texts.join('\n\n')||'The installed archive provides no separate license text. Its license declaration and upstream reference are recorded above.')+'\n').join('\n');
await writeFile('THIRD_PARTY_NOTICES.md',summary);await writeFile('THIRD_PARTY_LICENSES.txt',full);
for(const directory of ['apps/web/public/licenses','deploy/manual']){
  await mkdir(directory,{recursive:true});
  for(const [name,text] of [['LICENSE',await readFile('LICENSE','utf8')],['NOTICE',await readFile('NOTICE','utf8')],['THIRD_PARTY_NOTICES.md',summary],['THIRD_PARTY_LICENSES.txt',full]])await writeFile(join(directory,name),text);
}
console.log(JSON.stringify({packages:packages.size,withLicenseMaterial:sorted.filter(value=>value.texts.length).length}));
process.exitCode=0;
