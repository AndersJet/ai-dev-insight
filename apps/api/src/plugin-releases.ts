import type {FastifyInstance,FastifyRequest} from 'fastify';
import {pluginReleaseRoutes as routes,PLUGIN_RELEASE_MAX_BYTES,type PluginPilotBody} from '@adi/contracts';
import {DomainError,type PluginReleaseService} from '@adi/domain';
import {inspectPluginPackage} from './plugin-package.js';
export const pluginReleaseMessages={plugin_releases_unavailable:'插件版本服务尚未配置',plugin_invalid_package:'请上传当前插件的有效 VSIX，安装包需包含构建标识且不超过16 MiB',plugin_release_immutable:'正式版本不可覆盖或撤回，请升版上传',plugin_build_reused:'构建标识已使用，请重新打包',invalid_plugin_testers:'请选择有效且已注册的试用人员',plugin_release_not_pilot:'请先将当前构建指定试用，再确认正式发布',plugin_release_not_newer:'正式发布必须使用高于当前正式版的版本号',plugin_upload_busy:'正在处理其他安装包，请稍后重试'};
export function registerPluginReleases(app:FastifyInstance,service?:PluginReleaseService){
 const ready=()=>{if(!service)throw new DomainError('plugin_releases_unavailable',503);return service;};
 const bearer=(r:FastifyRequest)=>{const value=r.headers.authorization;return typeof value==='string'&&value.startsWith('Bearer ')?value.slice(7):'';};
 const wrap=(data:unknown,id:string)=>({data,meta:{request_id:id}});
 const superadmin=(r:FastifyRequest)=>{if(!r.identity?.user.roles.includes('super'))throw new DomainError('forbidden',403);return ready();};
 app.get(routes.current.path,{schema:routes.current},async r=>wrap(await ready().current(),r.id));
 app.get(routes.trial.path,{schema:routes.trial},async r=>wrap(await ready().trial(bearer(r)),r.id));
 app.get<{Params:{build:string}}>(routes.build.path,{schema:routes.build},async r=>wrap(await ready().describe(r.params.build,bearer(r)),r.id));
 app.get<{Params:{build:string}}>(routes.download.path,{schema:routes.download},async(r,reply)=>{const result=await ready().download(r.params.build,bearer(r));reply.type('application/octet-stream').header('Cache-Control','no-store').header('Content-Length',result.release.bytes).header('Content-Disposition',`attachment; filename="adi-project-tracker-${result.release.version}.vsix"`);return reply.send(result.package);});
 app.get(routes.list.path,{schema:routes.list},async r=>wrap(await superadmin(r).list(r.sessionToken),r.id));
 app.get<{Querystring:{search?:string;release_id?:string}}>(routes.testers.path,{schema:routes.testers},async r=>wrap(await superadmin(r).testers(r.sessionToken,r.query.search,r.query.release_id),r.id));
 let uploads=0;
 app.post(routes.upload.path,{schema:routes.upload,bodyLimit:PLUGIN_RELEASE_MAX_BYTES+8192},async r=>{
  const s=superadmin(r);if(uploads>=2)throw new DomainError('plugin_upload_busy',429);uploads++;
  try{let data:Buffer|undefined;for await(const part of r.parts({limits:{fileSize:PLUGIN_RELEASE_MAX_BYTES,files:1,fields:0,parts:1}})){if(part.type!=='file'||part.fieldname!=='file'||data||!part.filename.toLowerCase().endsWith('.vsix'))throw new DomainError('plugin_invalid_package',422);data=await part.toBuffer();}if(!data)throw new DomainError('plugin_invalid_package',422);return wrap(await s.upload(r.sessionToken,inspectPluginPackage(data)),r.id);}finally{uploads--;}
 });
 app.post<{Params:{id:string};Body:PluginPilotBody}>(routes.pilot.path,{schema:routes.pilot},async r=>wrap(await superadmin(r).setPilot(r.sessionToken,r.params.id,r.body),r.id));
 app.post<{Params:{id:string};Body:{build_id:string}}>(routes.publish.path,{schema:routes.publish},async r=>wrap(await superadmin(r).publish(r.sessionToken,r.params.id,r.body.build_id),r.id));
}
