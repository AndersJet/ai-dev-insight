import type { FastifyInstance } from 'fastify';
import type { SessionPersonalModelService } from '@adi/domain';
import { personalModelRoutes as routes,type PersonalModelBodyDto } from '@adi/contracts';
export function registerSessionPersonalModels(app:FastifyInstance,service:SessionPersonalModelService){
 app.get<{Params:{id:string}}>(routes.read.path,{schema:routes.read},async request=>({data:await service.read(request.sessionToken,request.params.id),meta:{request_id:request.id}}));
 app.put<{Params:{id:string};Body:PersonalModelBodyDto}>(routes.replace.path,{schema:routes.replace},async request=>({data:await service.replace(request.sessionToken,request.params.id,request.body),meta:{request_id:request.id}}));
}
