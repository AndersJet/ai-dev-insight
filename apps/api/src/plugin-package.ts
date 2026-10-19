import {unzipSync} from 'fflate';
import {crc32} from 'node:zlib';
import {PLUGIN_RELEASE_MAX_BYTES} from '@adi/contracts';
import {DomainError,type PluginArtifact} from '@adi/domain';
/** Bound the archive before validating every payload and its ZIP checksum. */
export function inspectPluginPackage(data:Buffer):PluginArtifact{
 const bad=()=>new DomainError('plugin_invalid_package',422);
 if(!data.length||data.length>PLUGIN_RELEASE_MAX_BYTES)throw bad();
 try{
  let end=-1;for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50&&i+22+data.readUInt16LE(i+20)===data.length){end=i;break;}
  if(end<0||data.readUInt16LE(end+4)||data.readUInt16LE(end+6))throw bad();
  const count=data.readUInt16LE(end+10),offset=data.readUInt32LE(end+16),length=data.readUInt32LE(end+12);
  if(count<1||count>200||data.readUInt16LE(end+8)!==count||offset+length!==end||end>=20&&data.readUInt32LE(end-20)===0x07064b50)throw bad();
  let at=offset,total=0;const names=new Set<string>(),sizes=new Map<string,number>(),checksums=new Map<string,number>();
  for(let i=0;i<count;i++){
   if(at+46>end||data.readUInt32LE(at)!==0x02014b50)throw bad();
   const nameBytes=data.readUInt16LE(at+28),extra=data.readUInt16LE(at+30),comment=data.readUInt16LE(at+32),size=data.readUInt32LE(at+24);
   if(at+46+nameBytes+extra+comment>end||nameBytes>256||data.readUInt16LE(at+8)&1||(data.readUInt32LE(at+38)>>>16&0xf000)===0xa000)throw bad();
   const name=data.subarray(at+46,at+46+nameBytes).toString('utf8'),parts=name.replace(/\/$/,'').split('/');
   if((/[\\:]/.test(name)||Array.from(name).some(c=>c.charCodeAt(0)<32))||parts.some(p=>!p||p==='.'||p==='..')||(!name.startsWith('extension/')&&!['extension.vsixmanifest','[Content_Types].xml'].includes(name))||names.has(name.toLowerCase()))throw bad();
   names.add(name.toLowerCase());sizes.set(name,size);checksums.set(name,data.readUInt32LE(at+16));total+=size;if(total>32*1024*1024)throw bad();at+=46+nameBytes+extra+comment;
  }
  if(at!==end||!sizes.has('extension/package.json')||sizes.get('extension/package.json')!>65536)throw bad();
  const files=unzipSync(data);for(const [name,size] of sizes){const bytes=files[name];if(!bytes||bytes.length!==size||crc32(bytes)!==checksums.get(name))throw bad();}
  for(const name of ['extension.vsixmanifest','[Content_Types].xml'])if(!files[name]?.length||files[name]!.length>65536)throw bad();
  const manifest=JSON.parse(Buffer.from(files['extension/package.json']!).toString('utf8'));
  if(manifest.name!=='adi-project-tracker'||manifest.publisher!=='ai-dev-insight'||typeof manifest.version!=='string'||!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(manifest.version)||typeof manifest.adiBuildId!=='string'||!/^[a-f0-9]{64}$/.test(manifest.adiBuildId)||manifest.main!=='./dist/extension.cjs'||!sizes.get('extension/dist/extension.cjs')||typeof manifest.engines?.vscode!=='string'||manifest.engines.vscode.length>64)throw bad();
  const xml=Buffer.from(files['extension.vsixmanifest']!).toString('utf8'),identity=/<Identity\b([^>]*)\/?\s*>/.exec(xml)?.[1];if(!identity||/<!DOCTYPE|<!ENTITY/i.test(xml))throw bad();
  const attributes=Object.fromEntries(Array.from(identity.matchAll(/\b(Id|Version|Publisher)\s*=\s*["']([^"']*)["']/g),match=>[match[1],match[2]]));if(attributes.Id!==manifest.name||attributes.Version!==manifest.version||attributes.Publisher!==manifest.publisher)throw bad();
  return {version:manifest.version,build_id:manifest.adiBuildId,package:data};
 }catch{throw bad();}
}
