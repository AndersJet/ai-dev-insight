import type { FastifyInstance } from 'fastify';
import type { AnalyticsService } from '@adi/domain';
import { analyticsRoutes as routes, type AnalyticsQueryDto, type AnalyticsPageQueryDto, type AnalyticsTrendQueryDto,type AnalyticsModelQueryDto } from '@adi/contracts';
export function registerAnalytics(app: FastifyInstance, analytics: AnalyticsService) {
  app.get<{Querystring:AnalyticsModelQueryDto}>(routes.models.path,{schema:routes.models},async request=>({data:await analytics.models(request.sessionToken,request.query),meta:{request_id:request.id}}));
  app.get<{Querystring:AnalyticsPageQueryDto}>(routes.declaredModels.path,{schema:routes.declaredModels},async request=>({data:await analytics.declaredModels(request.sessionToken,request.query),meta:{request_id:request.id}}));
  app.get<{ Querystring: AnalyticsQueryDto }>(routes.officialUsage.path,{schema:routes.officialUsage},async request=>({data:await analytics.officialUsage(request.sessionToken,request.query),meta:{request_id:request.id}}));
  app.get<{Params:{id:string};Querystring:AnalyticsQueryDto}>(routes.member.path,{schema:routes.member},async request=>({data:await analytics.member(request.sessionToken,request.params.id,request.query),meta:{request_id:request.id}}));
  const wrap = (data: unknown, id: string) => ({ data, meta: { request_id: id } });
  app.get<{ Querystring: AnalyticsQueryDto }>(routes.contentEstimate.path, { schema: routes.contentEstimate }, async request => wrap(await analytics.contentEstimate(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AnalyticsQueryDto }>(routes.overview.path, { schema: routes.overview }, async request => wrap(await analytics.overview(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AnalyticsQueryDto }>(routes.purposes.path, { schema: routes.purposes }, async request => wrap(await analytics.purposes(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AnalyticsTrendQueryDto }>(routes.trends.path, { schema: routes.trends }, async request => wrap(await analytics.trends(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AnalyticsPageQueryDto }>(routes.departments.path, { schema: routes.departments }, async request => wrap(await analytics.departments(request.sessionToken, request.query), request.id));
  app.get<{ Querystring: AnalyticsPageQueryDto }>(routes.members.path, { schema: routes.members }, async request => wrap(await analytics.members(request.sessionToken, request.query), request.id));
}
