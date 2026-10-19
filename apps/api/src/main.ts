import { createApi } from './app.js';
import { configuredServices } from './config.js';
import { loadClientDistribution } from './client-distribution.js';
import {setTimeout as delay} from 'node:timers/promises';
const services = configuredServices();
const web=new URL(process.env.ADI_WEB_ORIGIN??'http://127.0.0.1:4181');
if(!['http:','https:'].includes(web.protocol)||web.username||web.password||web.search||web.hash||web.pathname!=='/')throw new Error('invalid_public_web_origin');
const app = createApi(undefined, {
  clientDistribution: await loadClientDistribution({ ...(process.env.ADI_CLIENT_RELEASE_DIR ? { directory: process.env.ADI_CLIENT_RELEASE_DIR } : {}),collectorUrl:new URL('/hooks',web).href }),
  ...(services ? { plugin:services.plugin, pluginReleases:services.pluginReleases, repositoryAllowlist:services.repositoryAllowlist, adoption: services.adoption, registration: services.registration, identity: services.identity, operations:services.operations, cleanup:services.cleanup, organization: services.organization, administration: services.administration, imports: services.imports, installations: services.installations, analytics: services.analytics, usageMappings:services.usageMappings, sessions: services.sessions,sessionModels:services.sessionModels,codeFlow:services.codeFlow } : {}),
  secureCookies: web.protocol === 'https:',
  allowedOrigin: web.origin,
});
let stopping=false;
let prepareTimer:ReturnType<typeof setTimeout>|undefined,preparing:Promise<string>|undefined;
async function prepareMetadata(){
 if(!services)return;
 const work=services.warmSessionList();preparing=work;
 try{return await work;}finally{if(preparing===work)preparing=undefined;}
}
function scheduleMetadata(){
 if(stopping||!services)return;
 prepareTimer=setTimeout(()=>{
  prepareTimer=undefined;
  void prepareMetadata().catch(()=>{
   if(!stopping)process.stderr.write(JSON.stringify({code:'session_list_prepare_failed'})+'\n');
  }).finally(scheduleMetadata);
 },1000);
 prepareTimer.unref();
}
if (services) app.addHook('onClose', async () => {
 stopping=true;clearTimeout(prepareTimer);
 await preparing?.catch(()=>{});
 await services.db.close();
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping=true;void app.close(); });
try {
 await services?.db.assertNotRecovering();
 // API readiness includes the first complete publication and its metadata.
 // Keep later metadata ready while idle; searches are never prewarmed.
 while(services&&!stopping){
  try{await prepareMetadata();break;}
  catch(error){if(stopping)break;if(!(error instanceof Error)||!('code'in error)||!['session_snapshot_pending','session_snapshot_expired','content_changed'].includes(String(error.code)))throw error;await delay(250);}
 }
 if(!stopping){await app.listen({ host: process.env.ADI_API_HOST ?? '127.0.0.1', port: Number(process.env.ADI_API_PORT ?? 4180) });scheduleMetadata();}
}
catch { const interrupted=stopping;await app.close();if(!interrupted){process.stderr.write(JSON.stringify({ code: 'api_start_failed' }) + '\n'); process.exitCode = 1;} }
