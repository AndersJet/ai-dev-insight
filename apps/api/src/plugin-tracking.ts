import {analysisRoutes,type SessionQueryDto,type AnalysisSelectionDto} from '@adi/contracts';
import {createSessionReadService,type SessionListSnapshotReader} from '@adi/domain';
import type {CurrentUser} from '@adi/contracts';
import {sendAnalysis} from './analysis-package.js';
import type {FastifyInstance} from 'fastify';
import {pluginRoutes,pluginAccessRoutes,type PluginObservation,type PluginQuery,type PluginSourceRegistration} from '@adi/contracts';
import {DomainError} from '@adi/domain';
import {createPluginCredentialService,createPluginTodayService,createRepositoryClassifier,type RepositoryRule,type IdentityService} from '@adi/domain';
import type {Database} from '@adi/storage';
import {createPluginObservationStore} from '@adi/storage';

export interface PluginBackend {db:Database;signingKey:Buffer;clock?:()=>Date;providerAccount?:string;snapshots?:SessionListSnapshotReader;stopWindowEnabled?:boolean}

function classified<T extends {remotes:{address:string|null}[]}>(record:T,classify:ReturnType<typeof createRepositoryClassifier>){
  return {...record,remotes:record.remotes.map(remote=>classify(remote.address??''))};
}

export function registerPluginTracking(app:FastifyInstance,backend?:PluginBackend,identity?:Partial<Pick<IdentityService,'mutate'|'requireUser'|'normalizeEmail'>>){
  const access=backend&&identity?.mutate&&identity?.requireUser&&identity?.normalizeEmail?createPluginCredentialService(backend.db,{mutate:identity.mutate,requireUser:identity.requireUser,normalizeEmail:identity.normalizeEmail},{encryptionKey:backend.signingKey,...(backend.clock?{clock:backend.clock}:{})}):null;
  app.get(pluginAccessRoutes.credentialStatus.path,{schema:pluginAccessRoutes.credentialStatus},async request=>{if(!access)throw new DomainError('plugin_unavailable',503);return {data:await access.status(request.sessionToken),meta:{request_id:request.id}};});
  app.post(pluginAccessRoutes.credential.path,{schema:pluginAccessRoutes.credential},async request=>{if(!access)throw new DomainError('plugin_unavailable',503);return {data:await access.credential(request.sessionToken),meta:{request_id:request.id}};});
  const history=backend&&access?createSessionReadService(backend.db,{async requireUser(token:string):Promise<CurrentUser>{
    const owner=await access.authorize(token);
    return {user_id:owner.id,email:owner.email_key,display_name:owner.display_name,registered:true,management_source:'system',roles:['employee'],managed_departments:[],allowed_actions:['self:read'],default_route:'/my/overview',must_change_password:false};
  }},{...(backend.clock?{clock:backend.clock}:{}),...(backend.providerAccount?{providerAccount:backend.providerAccount}:{}),...(backend.snapshots?{snapshots:backend.snapshots}:{}),stopWindowEnabled:backend.stopWindowEnabled===true}):null;
  app.post<{Body:SessionQueryDto}>(analysisRoutes.pluginList.path,{schema:analysisRoutes.pluginList},async request=>{
    if(!history)throw new DomainError('plugin_unavailable',503);return {data:await history.listMine(bearer(request),request.body),meta:{request_id:request.id}};
  });
  app.post<{Body:AnalysisSelectionDto}>(analysisRoutes.pluginDownload.path,{schema:analysisRoutes.pluginDownload},async(request,reply)=>{
    if(!history)throw new DomainError('plugin_unavailable',503);return sendAnalysis(reply,await history.analysisData(bearer(request),request.body.session_ids));
  });
  const today=backend&&access?createPluginTodayService(backend.db,access,{...(backend.clock?{clock:backend.clock}:{}),...(backend.providerAccount?{providerAccount:backend.providerAccount}:{})}):null;
  app.get(pluginAccessRoutes.today.path,{schema:pluginAccessRoutes.today},async request=>{if(!today)throw new DomainError('plugin_unavailable',503);return {data:await today.today(bearer(request)),meta:{request_id:request.id}};});
  function bearer(request:import('fastify').FastifyRequest){const value=request.headers.authorization;if(typeof value!=='string'||!value.startsWith('Bearer '))throw new DomainError('plugin_unauthorized',401);return value.slice(7);}
  app.get(pluginAccessRoutes.me.path,{schema:pluginAccessRoutes.me},async request=>{if(!access)throw new DomainError('plugin_unavailable',503);const owner=await access.authorize(bearer(request));return {data:{user_id:owner.id,email:owner.email_key,display_name:owner.display_name,registered:true},meta:{request_id:request.id}};});
  app.post<{Body:PluginSourceRegistration}>(pluginAccessRoutes.source.path,{schema:pluginAccessRoutes.source},async request=>{if(!access)throw new DomainError('plugin_unavailable',503);return {data:await access.registerSource(bearer(request),request.body),meta:{request_id:request.id}};});
  const store=backend?createPluginObservationStore(backend.db):null;
  const limits=new Map<string,{at:number;count:number}>();
  app.addHook('onRequest',async(request,reply)=>{
    const path=request.url.split('?')[0];
    if(request.method!=='POST'||!['/api/v1/plugin/registration','/api/v1/plugin/sources','/api/v1/plugin/observations'].includes(path??''))return;
    const key=`${request.ip}:${path}`,now=Date.now(),maximum=path==='/api/v1/plugin/observations'?600:20;
    let bucket=limits.get(key);
    if(!bucket||now-bucket.at>=60000){
      if(!bucket&&limits.size>=1000)limits.delete(limits.keys().next().value!);
      bucket={at:now,count:0};limits.set(key,bucket);
    }
    if(++bucket.count>maximum){reply.header('Retry-After','60');throw new DomainError('plugin_limited',429);}
  });
  app.post('/api/v1/plugin/registration',async()=>{throw new DomainError('plugin_entry_retired',410);});
  app.post<{Body:PluginObservation}>('/api/v1/plugin/observations',{schema:pluginRoutes.report},async(request,reply)=>{
    if(!access||!store)throw new DomainError('plugin_unavailable',503);
    const proof=request.headers['x-adi-source-secret'];if(typeof proof!=='string')throw new DomainError('plugin_unauthorized',401);
    const owner=await access.authorizeSource(bearer(request),request.body.collector_id,request.body.source_config_id,proof,request.body.platform);
    const data=await store.save({...request.body,nt_email:owner.email_key},{userId:owner.id});
    if(data.outcome==='saved')await access.markSaved(owner.id,request.body.collector_id,data.received_at);
    return reply.code(data.outcome==='saved'?201:200).send({data,meta:{request_id:request.id}});
  });
  function superadmin(request:import('fastify').FastifyRequest){if(!request.identity?.user.roles.includes('super'))throw new DomainError('forbidden',403);if(!store)throw new DomainError('plugin_unavailable',503);return store;}
  async function classifier(){return createRepositoryClassifier((await backend!.db.query<RepositoryRule>('SELECT kind,value FROM repository_allowlist')).rows);}
  app.delete(pluginRoutes.removeProject.path,async()=>{throw new DomainError('plugin_entry_retired',410);});
  app.get<{Querystring:PluginQuery}>('/api/v1/plugin/projects',{schema:pluginRoutes.projects},async request=>{
    const page=await superadmin(request).projects(request.query),classify=await classifier();
    return {data:{...page,items:page.items.map(item=>({...item,latest:item.latest?classified(item.latest,classify):null,confirmed:item.confirmed?classified(item.confirmed,classify):null}))},meta:{request_id:request.id}};
  });
  app.get<{Querystring:PluginQuery}>('/api/v1/plugin/observations',{schema:pluginRoutes.history},async request=>{
    const page=await superadmin(request).history(request.query),classify=await classifier();
    return {data:{...page,items:page.items.map(record=>classified(record,classify))},meta:{request_id:request.id}};
  });
  return access;
}
