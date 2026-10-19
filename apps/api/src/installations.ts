import type { FastifyInstance } from 'fastify';
import type { InstallationService } from '@adi/domain';
import { installationRoutes as routes } from '@adi/contracts';
export function registerInstallations(app: FastifyInstance, installations: InstallationService) {
  const wrap = (data: unknown, id: string) => ({ data, meta: { request_id: id } });
  app.get(routes.status.path, { schema: routes.status }, async request => wrap(await installations.status(request.sessionToken), request.id));
  app.post(routes.reset.path, { schema: routes.reset }, async request => wrap(await installations.reset(request.sessionToken), request.id));
  app.delete(routes.revoke.path, { schema: routes.revoke }, async (request, reply) => { await installations.revoke(request.sessionToken); return reply.code(204).send(); });
  app.get<{ Params: { id: string } }>(routes.adminStatus.path, { schema: routes.adminStatus }, async request => wrap(await installations.statusForUser(request.sessionToken, request.params.id), request.id));
  app.delete<{ Params: { id: string } }>(routes.adminRevoke.path, { schema: routes.adminRevoke }, async (request, reply) => { await installations.revokeForUser(request.sessionToken, request.params.id); return reply.code(204).send(); });
}
