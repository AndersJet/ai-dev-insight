#!/bin/sh
# Sourced by this project's installers inside the pinned disposable CI image.
set -eu
[ "${CI:-}" = true ] && [ "$(id -u)" = 0 ] && [ -f /.dockerenv ] || { echo 'Disposable root Docker CI container required' >&2; exit 1; }
[ "$(node --version)" = v24.14.1 ] || { echo 'Pinned Node 24.14.1 CI runtime required' >&2; exit 1; }
case "${ADI_CI_APT_SOURCE:-tuna}" in tuna|official) ;; *) echo 'Unsupported CI APT source' >&2; exit 1 ;; esac
ADI_CI_APT_CA_FILE=$(mktemp /tmp/adi-ci-apt-ca.XXXXXX)
export ADI_CI_APT_CA_FILE
trap 'rm -f -- "$ADI_CI_APT_CA_FILE"' EXIT
node --input-type=module - "$ADI_CI_APT_CA_FILE" <<'NODE'
import fs from 'node:fs';
import {rootCertificates} from 'node:tls';
import process from 'node:process';
const sourcePath='/etc/apt/sources.list.d/debian.sources',source=fs.readFileSync(sourcePath,'utf8');
const fields=[...source.matchAll(/^URIs:[ \t]*(\S+)[ \t]*\r?$/gmi)];
const headerCount=[...source.matchAll(/^URIs:/gmi)].length;
const sources={tuna:['https://mirrors.tuna.tsinghua.edu.cn/debian','https://mirrors.tuna.tsinghua.edu.cn/debian-security'],official:['https://deb.debian.org/debian','https://security.debian.org/debian-security']};
const selected=process.env.ADI_CI_APT_SOURCE||'tuna';
if(!Object.hasOwn(sources,selected))throw new Error('Unsupported CI APT source');
const [mirror,securityMirror]=sources[selected];
const main=new Set(['http://deb.debian.org/debian','https://deb.debian.org/debian',sources.tuna[0]]);
const security=new Set(['http://deb.debian.org/debian-security','https://deb.debian.org/debian-security','http://security.debian.org/debian-security','https://security.debian.org/debian-security',sources.tuna[1]]);
if(headerCount!==2||fields.length!==2||/^URIs:[^\n]*\n[ \t]+\S/mi.test(source)||fields.filter(field=>main.has(field[1])).length!==1||fields.filter(field=>security.has(field[1])).length!==1)throw new Error('Expected one supported Debian main URI and one supported security URI');
if(!Array.isArray(rootCertificates)||rootCertificates.length===0)throw new Error('Bundled Node public CA store unavailable');
const prepared=fields.reduceRight((text,field)=>{
  const changed=field[0].replace(field[1],main.has(field[1])?mirror:securityMirror);
  return text.slice(0,field.index)+changed+text.slice(field.index+field[0].length);
},source);
fs.writeFileSync(process.argv[2],rootCertificates.join('\n')+'\n');
fs.chmodSync(process.argv[2],0o644); // Public CA data must be readable by APT's _apt sandbox.
if(prepared!==source)fs.writeFileSync(sourcePath,prepared);
NODE
