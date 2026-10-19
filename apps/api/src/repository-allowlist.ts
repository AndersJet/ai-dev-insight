import type {FastifyInstance} from 'fastify';
import type {RepositoryAllowlistService} from '@adi/domain';
import {repositoryAllowlistRoutes as routes,type RepositoryAllowlistQuery,type RepositoryRuleBody,type RepositoryRuleUpdate} from '@adi/contracts';

export function registerRepositoryAllowlist(app:FastifyInstance,service:RepositoryAllowlistService){
  app.get<{Querystring:RepositoryAllowlistQuery}>(routes.list.path,{schema:routes.list},async request=>({data:await service.list(request.sessionToken,request.query),meta:{request_id:request.id}}));
  app.post<{Body:RepositoryRuleBody}>(routes.create.path,{schema:routes.create},async(request,reply)=>reply.code(201).send({data:await service.create(request.sessionToken,request.body),meta:{request_id:request.id}}));
  app.patch<{Params:{id:string};Body:RepositoryRuleUpdate}>(routes.update.path,{schema:routes.update},async request=>({data:await service.update(request.sessionToken,request.params.id,request.body),meta:{request_id:request.id}}));
  app.delete<{Params:{id:string};Body:{version:number}}>(routes.remove.path,{schema:routes.remove},async(request,reply)=>{await service.remove(request.sessionToken,request.params.id,request.body.version);return reply.code(204).send();});
}
