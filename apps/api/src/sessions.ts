import {analysisRoutes,type AnalysisSelectionDto} from '@adi/contracts';
import {sendAnalysis} from './analysis-package.js';
import {billingSimulationRoute,sessionTokenCheckRoute,type BillingSimulationQueryDto} from '@adi/contracts';
import type { FastifyInstance } from 'fastify';
import type { SessionReadService } from '@adi/domain';
import { sessionRoutes as routes, type SessionTurnsQueryDto, type SessionQueryDto, type AllSessionQueryDto, type RecentSessionQueryDto, type SessionFragmentQueryDto, type SessionContentQueryDto } from '@adi/contracts';
export function registerSessions(app: FastifyInstance, sessions: SessionReadService) {
  app.get<{Params:{id:string}}>(sessionTokenCheckRoute.path,{schema:sessionTokenCheckRoute},async request=>({data:await sessions.tokenCheck(request.sessionToken,request.params.id),meta:{request_id:request.id}}));
  app.get<{Params:{id:string};Querystring:BillingSimulationQueryDto}>(billingSimulationRoute.path,{schema:billingSimulationRoute},async request=>({data:await sessions.simulation(request.sessionToken,request.params.id,request.query),meta:{request_id:request.id}}));
  app.post<{Body:AnalysisSelectionDto}>(analysisRoutes.download.path,{schema:analysisRoutes.download},async(request,reply)=>sendAnalysis(reply,await sessions.analysisData(request.sessionToken,request.body.session_ids)));
  const wrap = (data: unknown, id: string) => ({ data, meta: { request_id: id } });
  app.get<{ Querystring: SessionQueryDto }>(routes.mine.path, { schema: routes.mine }, async request => wrap(await sessions.listMine(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AllSessionQueryDto }>(routes.all.path, { schema: routes.all }, async request => wrap(await sessions.listAll(request.sessionToken, request.query), request.id));
  app.get<{ Params: { id: string }; Querystring: RecentSessionQueryDto }>(routes.detail.path, { schema: routes.detail }, async request => wrap(await sessions.detail(request.sessionToken, request.params.id, request.query), request.id));
  app.get<{Params:{id:string};Querystring:RecentSessionQueryDto}>(routes.officialUsage.path,{schema:routes.officialUsage},async request=>wrap(await sessions.officialUsage(request.sessionToken,request.params.id,request.query),request.id));
  app.get<{ Params: { id: string }; Querystring: SessionTurnsQueryDto }>(routes.turns.path, { schema: routes.turns }, async request => wrap(await sessions.turns(request.sessionToken, request.params.id, request.query), request.id));
  app.get<{ Params: { id: string }; Querystring: SessionFragmentQueryDto }>(routes.fragments.path, { schema: routes.fragments }, async request => wrap(await sessions.fragments(request.sessionToken, request.params.id, request.query), request.id));
  app.get<{ Params: { id: string; eventId: string }; Querystring: SessionContentQueryDto }>(routes.content.path, { schema: routes.content }, async request => wrap(await sessions.content(request.sessionToken, request.params.id, request.params.eventId, request.query), request.id));
}
