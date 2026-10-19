import type {FastifyInstance} from 'fastify';import type {UsageMappingService} from '@adi/domain';import {usageMappingRoutes as routes,type UsageMappingQueryDto,type UsageMappingBodyDto} from '@adi/contracts';
export function registerUsageMappings(app:FastifyInstance,mappings:UsageMappingService){
 app.get<{Querystring:UsageMappingQueryDto}>(routes.list.path,{schema:routes.list},async request=>{const {department_id,...query}=request.query;return {data:await mappings.list(request.sessionToken,department_id,query),meta:{request_id:request.id}};});
 app.post<{Body:UsageMappingBodyDto}>(routes.create.path,{schema:routes.create},async(request,reply)=>reply.code(201).send({data:await mappings.create(request.sessionToken,request.body),meta:{request_id:request.id}}));
 app.delete<{Params:{id:string};Body:{version:number}}>(routes.remove.path,{schema:routes.remove},async request=>({data:await mappings.remove(request.sessionToken,request.params.id,request.body.version),meta:{request_id:request.id}}));
}
