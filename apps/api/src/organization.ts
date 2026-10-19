import type { FastifyInstance } from 'fastify';
import { organizationRoutes as routes, type NewMember, type EditMember, type Paging, type TransferMember } from '@adi/contracts';
import type { OrganizationService } from '@adi/domain';
export function registerOrganization(app: FastifyInstance, organization: OrganizationService) {
  const wrap = (data: unknown, requestId: string) => ({ data, meta: { request_id: requestId } });
  app.get(routes.departments.path, { schema: routes.departments }, async request => wrap(await organization.listDepartments(request.sessionToken), request.id));
  app.post<{ Body: { name: string } }>(routes.create.path, { schema: routes.create }, async (request, reply) => reply.code(201).send(wrap(await organization.createDepartment(request.sessionToken, request.body.name), request.id)));
  app.patch<{ Params: { id: string }; Body: { name: string; version: number } }>(routes.rename.path, { schema: routes.rename }, async request => wrap(await organization.renameDepartment(request.sessionToken, request.params.id, request.body.name, request.body.version), request.id));
  app.delete<{ Params: { id: string }; Body: { version: number } }>(routes.remove.path, { schema: routes.remove }, async (request, reply) => { await organization.deleteDepartment(request.sessionToken, request.params.id, request.body.version); return reply.code(204).send(); });
  app.put<{ Params: { id: string }; Body: { user_ids: string[]; version: number } }>(routes.admins.path, { schema: routes.admins }, async request => wrap(await organization.setDepartmentAdmins(request.sessionToken, request.params.id, request.body.user_ids, request.body.version), request.id));
  app.get<{ Params: { id: string }; Querystring: Paging }>(routes.members.path, { schema: routes.members }, async request => wrap(await organization.listMembers(request.sessionToken, request.params.id, request.query), request.id));
  app.get<{ Querystring: Paging }>(routes.allMembers.path, { schema: routes.allMembers }, async request => wrap(await organization.listMembers(request.sessionToken, undefined, request.query), request.id));
  app.post<{ Params: { id: string }; Body: NewMember }>(routes.addMember.path, { schema: routes.addMember }, async (request, reply) => reply.code(201).send(wrap(await organization.addMember(request.sessionToken, request.params.id, request.body), request.id)));
  app.patch<{ Params: { id: string; userId: string }; Body: EditMember }>(routes.editMember.path, { schema: routes.editMember }, async request => wrap(await organization.updateMember(request.sessionToken, request.params.id, request.params.userId, request.body), request.id));
  app.delete<{ Params: { id: string; userId: string }; Body: { version: number } }>(routes.removeMember.path, { schema: routes.removeMember }, async (request, reply) => { await organization.removeMember(request.sessionToken, request.params.id, request.params.userId, request.body.version); return reply.code(204).send(); });
  app.post<{ Params: { id: string }; Body: TransferMember }>(routes.transfer.path, { schema: routes.transfer }, async request => wrap(await organization.transferMember(request.sessionToken, request.params.id, request.body), request.id));
  app.delete<{ Params: { id: string }; Body: { version: number } }>(routes.cancelTransfer.path, { schema: routes.cancelTransfer }, async request => wrap(await organization.cancelTransfer(request.sessionToken, request.params.id, request.body.version), request.id));
}
