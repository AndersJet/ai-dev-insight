// Acceptance-only endpoints. Never imported by the employee extension.
import {isIP} from 'node:net';

export function nativeTestServer(){
  const configured=process.env.ADI_PLUGIN_TEST_SERVER;
  if(process.platform==='win32'&&!configured)throw new Error('Set ADI_PLUGIN_TEST_SERVER to the isolated acceptance server');
  let value:URL;try{value=new URL(configured??'http://127.0.0.1:4195');}catch{throw new Error('Invalid acceptance server origin');}
  const host=value.hostname.replace(/^\[|\]$/g,'');
  const parts=host.split('.').map(Number),privateV4=isIP(host)===4&&(parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]!>=16&&parts[1]!<=31);
  if(value.protocol!=='http:'||value.username||value.password||value.search||value.hash||value.pathname!=='/'||!(['127.0.0.1','localhost','::1'].includes(host)||privateV4))throw new Error('An isolated local or private HTTP acceptance origin is required');
  return value.origin;
}
