import type {TestContext} from 'node:test';
import type {Database} from '@adi/storage';
import type {IdentityService,InstallationService,RegistrationService,LoginResult} from '@adi/domain';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../packages/storage/test/helpers.js';
import {createIdentityService,createOrganizationService,createRegistrationService,createInstallationService,createAdoptionService,createAnalyticsService,createSessionReadService,createOperationsService,createRepositoryAllowlistService} from '@adi/domain';
import {createApi} from '../src/app.js';
import {loadClientDistribution} from '../src/client-distribution.js';
type SyntheticSource={source_secret:string;source_config_id:string;platform:'macos';plugin_version:string;collector_id:string;nt_email:string;uploadHeaders:{authorization:string;'x-adi-source-secret':string}};
interface PluginFixture {db:Database;identity:IdentityService;app:ReturnType<typeof createApi>;root:LoginResult;headers:{cookie:string;'x-csrf-token':string;origin:string};apiToken:string;bearer:{authorization:string};source:()=>Promise<SyntheticSource>;installations:InstallationService;registration:RegistrationService;department:{id:string;name:string;version:number}}
export async function pluginFixture(t:TestContext,clock?:()=>Date):Promise<PluginFixture>{
  const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.org']});
  const seed=await identity.bootstrap({email:'synthetic.plugin-admin@example.org',name:'合成插件管理员'}),initial=await identity.login('synthetic.plugin-admin@example.org',seed.temporaryPassword),root=await identity.changePassword(initial.token,seed.temporaryPassword,'synthetic-fixture-password');
  const organization=createOrganizationService(db,identity),registration=createRegistrationService(db,identity),department=await organization.createDepartment(root.token,'合成来源部门');
  await registration.activate(root.token,{department_id:department.id});
  const installations=createInstallationService(db,identity,{encryptionKey:Buffer.alloc(32,17),...(clock?{clock}:{})});
  const app=createApi(undefined,{identity,registration,organization,installations,adoption:createAdoptionService(db,identity),analytics:createAnalyticsService(db,identity,{providerAccount:'synthetic-plugin-billing'}),sessions:createSessionReadService(db,identity),operations:createOperationsService(db,identity),repositoryAllowlist:createRepositoryAllowlistService(db,identity),plugin:{db,signingKey:Buffer.alloc(32,17)},clientDistribution:await loadClientDistribution({collectorUrl:'http://web.example.invalid/hooks'}),allowedOrigin:'http://web.example.invalid'});t.after(()=>app.close());
  const headers={cookie:`adi_session=${root.token}`,'x-csrf-token':root.csrfToken,origin:'http://web.example.invalid'};
  const response=await app.inject({method:'POST',url:'/api/v1/me/plugin-credential',headers,payload:{}});if(response.statusCode!==200)throw new Error('synthetic_fixture_credential_failed');
  const apiToken=response.json().data.api_token as string,bearer={authorization:`Bearer ${apiToken}`};
  async function source(){const input={source_secret:randomBytes(32).toString('base64url'),source_config_id:randomUUID(),platform:'macos' as const,plugin_version:'0.3.0'};
    const reply=await app.inject({method:'POST',url:'/api/v1/plugin/sources',headers:bearer,payload:input});if(reply.statusCode!==200)throw new Error('synthetic_fixture_source_failed');
    return {...input,collector_id:reply.json().data.collector_id as string,nt_email:'synthetic.plugin-admin@example.org',uploadHeaders:{...bearer,'x-adi-source-secret':input.source_secret}};}
  return {db,identity,app,root,headers,apiToken,bearer,source,installations,registration,department};
}
