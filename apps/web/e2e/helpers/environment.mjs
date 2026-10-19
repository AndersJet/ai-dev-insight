import process from 'node:process';
import {URL,fileURLToPath} from 'node:url';
import {join} from 'node:path';

export function e2eEnvironment(env=process.env){
  const databaseURL=env.ADI_TEST_DATABASE_URL??'postgres://adi_test:adi_test_local_only@127.0.0.1:55438/adi_test',target=new URL(databaseURL);
  const local=['localhost','127.0.0.1'].includes(target.hostname)&&target.port==='55438';
  const ci=env.CI==='true'&&target.hostname==='postgres-test'&&target.port==='5432';
  if(!['postgres:','postgresql:'].includes(target.protocol)||!(local||ci)||target.pathname!=='/adi_test'||target.username!=='adi_test'||target.search||target.hash)throw new Error('E2E requires the isolated adi_test database');
  const schema=env.ADI_E2E_SCHEMA??'test_browser_e2e',portBase=Number(env.ADI_E2E_PORT_BASE??'4184');
  if(!/^test_[a-z0-9_]{1,58}$/.test(schema))throw new Error('E2E schema must be a bounded test_ identifier');
  if(!/^[1-9][0-9]{3,4}$/.test(env.ADI_E2E_PORT_BASE??'4184')||!Number.isInteger(portBase)||portBase<1024||portBase>65532)throw new Error('E2E port base must be a local unprivileged port range');
  const webURL=`http://127.0.0.1:${portBase+1}`,apiURL=`http://127.0.0.1:${portBase}`,collectorURL=`http://127.0.0.1:${portBase+3}`,httpWebURL=`http://adi-http.test:${portBase+1}`;
  const artifactRoot=fileURLToPath(new URL(`../../../../.run/${schema==='test_browser_e2e'?'':schema+'/'}`,import.meta.url));
  return {schema,portBase,webURL,apiURL,collectorURL,httpWebURL,databaseURL,artifactRoot};
}
export const environment=e2eEnvironment();
export const e2eArtifact=name=>join(environment.artifactRoot,name);
