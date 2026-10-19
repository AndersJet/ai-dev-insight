import type { FastifyInstance } from 'fastify';
import { importRoutes as routes, type ImportQueryDto } from '@adi/contracts';
import { DomainError, type MemberImportService } from '@adi/domain';
import { parseUpload } from './import-parser.js';
export function registerMemberImports(app: FastifyInstance, imports: MemberImportService) {
  let uploads = 0;
  const wrap = (data: unknown, id: string) => ({ data, meta: { request_id: id } });
  app.get<{ Querystring: { department_id: string } }>(routes.recent.path, { schema: routes.recent }, async request => wrap((await imports.recent(request.sessionToken, request.query.department_id)).map(row => ({ ...row, created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString() })), request.id));
  app.get<{ Querystring: { department_id: string } }>(routes.template.path, { schema: routes.template }, async (request, reply) => {
    const department = await imports.authorizeDepartment(request.sessionToken, request.query.department_id);
    const { createMemberTemplate } = await import('@adi/domain/member-file');
    reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="members.xlsx"; filename*=UTF-8''${encodeURIComponent(`${department.name}-成员模板.xlsx`)}`);
    return createMemberTemplate(department.id, department.name);
  });
  app.post<{ Querystring: ImportQueryDto }>(routes.preview.path, { schema: routes.preview, bodyLimit: 6 * 1024 * 1024 }, async request => {
    await imports.authorizeDepartment(request.sessionToken, request.query.department_id);
    if (uploads >= 2) throw new DomainError('import_busy', 429);
    uploads++;
    try {
      let file: { data: Buffer; name: string } | undefined;
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || file) throw new DomainError('invalid_file', 422);
        file = { data: await part.toBuffer(), name: part.filename };
      }
      if (!file) throw new DomainError('invalid_file', 422);
      const parsed = await parseUpload(file.data, file.name);
      const preview = await imports.preview(request.sessionToken, request.query.department_id, request.query.mode ?? 'insert_only', parsed, file.name);
      return wrap({ ...preview, expires_at: preview.expires_at.toISOString() }, request.id);
    } finally { uploads--; }
  });
  app.get<{ Params: { id: string } }>(routes.batch.path, { schema: routes.batch }, async request => { const value = await imports.get(request.sessionToken, request.params.id); return wrap({ ...value, expires_at: value.expires_at.toISOString() }, request.id); });
  app.post<{ Params: { id: string }; Body: { preview_hash: string }; Headers: { 'idempotency-key': string } }>(routes.commit.path, { schema: routes.commit }, async (request, reply) => reply.code(202).send(wrap(await imports.submit(request.sessionToken, request.params.id, request.body.preview_hash, request.headers['idempotency-key']), request.id)));
}
