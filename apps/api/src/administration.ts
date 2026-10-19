import type { FastifyInstance } from 'fastify';
import type { AdministrationService } from '@adi/domain';
import { administrationRoutes as routes, type AccessBody, type StatusBody, type EmailCorrection, type Paging } from '@adi/contracts';
export function registerAdministration(app: FastifyInstance, administration: AdministrationService) {
  const wrap = (data: unknown, requestId: string) => ({ data, meta: { request_id: requestId } });
  app.get<{ Querystring: Paging }>(routes.list.path, { schema: routes.list }, async request => wrap(await administration.listAccounts(request.sessionToken, request.query), request.id));
  app.get<{ Params: { id: string } }>(routes.account.path, { schema: routes.account }, async request => wrap(await administration.getAccount(request.sessionToken, request.params.id), request.id));
  app.put<{ Params: { id: string }; Body: AccessBody }>(routes.access.path, { schema: routes.access }, async request => wrap(await administration.setAccess(request.sessionToken, request.params.id, request.body), request.id));
  app.patch<{ Params: { id: string }; Body: StatusBody }>(routes.status.path, { schema: routes.status }, async request => wrap(await administration.setStatus(request.sessionToken, request.params.id, request.body), request.id));
  app.patch<{ Params: { id: string }; Body: EmailCorrection }>(routes.email.path, { schema: routes.email }, async request => wrap(await administration.correctEmail(request.sessionToken, request.params.id, request.body), request.id));
}
