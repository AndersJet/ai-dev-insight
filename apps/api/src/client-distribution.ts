import { unzipSync, zipSync } from 'fflate';
import { DomainError, type InstallationService,type PluginCredentialService } from '@adi/domain';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { clientDistributionRoutes as routes,pluginAccessRoutes, type ClientReleaseDto } from '@adi/contracts';

export interface ClientDistribution { collectorUrl: string | null; release: { metadata: ClientReleaseDto; archive: Buffer; files: Record<string, Uint8Array> } | null }
async function boundedFile(path: string, maximum: number) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > maximum) throw new Error('Invalid release file');
    const data = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > maximum) throw new Error('Release too large'); return data.subarray(0, offset);
  } finally { await file.close(); }
}
function collectorUrl(input?: string) {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/hooks') return null;
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.href;
  } catch { return null; }
}
// Release files are bounded and verified once at startup. Requests never select
// filesystem paths. Only this verified small template is used for personal ZIPs.
export async function loadClientDistribution(options: { directory?: string; collectorUrl?: string } = {}): Promise<ClientDistribution> {
  const endpoint = collectorUrl(options.collectorUrl);
  const directory = options.directory ?? fileURLToPath(new URL('../../hook-client/dist/release/', import.meta.url));
  try {
    const parsed = JSON.parse((await boundedFile(join(directory, 'manifest.json'), 16_384)).toString('utf8'));
    if (parsed.schema_version !== 2 || typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version) || parsed.runtime !== 'system' || !Array.isArray(parsed.platforms) || parsed.platforms.length !== 2 || !parsed.platforms.includes('windows') || !parsed.platforms.includes('macos') || !['preview', 'stable'].includes(parsed.channel) || typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.sha256) || parsed.file_name !== `adi-hook-client-${parsed.version}-${parsed.sha256.slice(0, 12)}.zip` || !Number.isSafeInteger(parsed.bytes) || parsed.bytes <= 0 || parsed.bytes > 4 * 1024 * 1024) throw new Error('Invalid release manifest');
    const archive = await boundedFile(join(directory, 'client.zip'), 4 * 1024 * 1024);
    if (archive.length !== parsed.bytes || createHash('sha256').update(archive).digest('hex') !== parsed.sha256) throw new Error('Release integrity mismatch');
    const metadata: ClientReleaseDto = { version: parsed.version, runtime: 'system', platforms: ['windows', 'macos'], channel: parsed.channel, file_name: parsed.file_name, sha256: parsed.sha256, bytes: parsed.bytes };
    const names = ['INSTALL.md', 'LICENSE', 'NOTICE', 'install-hook.ps1', 'install-hook.sh', 'native-macos.js', 'native-windows.ps1', 'send-hook.ps1', 'send-hook.sh', 'send-worker.ps1'];
    const files = unzipSync(archive, { filter: file => names.includes(file.name) && file.originalSize <= 512 * 1024 });
    if (Object.keys(files).sort().join(',') !== names.sort().join(',')) throw new Error('Invalid release contents');
    return { collectorUrl: endpoint, release: { metadata, archive, files } };
  } catch { return { collectorUrl: endpoint, release: null }; }
}
export function registerClientDistribution(app: FastifyInstance, distribution: ClientDistribution = { collectorUrl: null, release: null }, installations?: InstallationService,access?:PluginCredentialService,webOrigin?:string) {
  app.get(routes.setup.path, { schema: routes.setup }, async request => ({ data: { collector_url: distribution.collectorUrl, client: distribution.release?.metadata ?? null }, meta: { request_id: request.id } }));
  function ready() {
    if (!distribution.release) throw new DomainError('client_package_unavailable', 503);
    if (!distribution.collectorUrl) throw new DomainError('collector_endpoint_unavailable', 503);
    if (!installations) throw new DomainError('auth_unavailable', 503);
    if(webOrigin){const origin=new URL(webOrigin);if(origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||new URL(distribution.collectorUrl).origin!==origin.origin)throw new DomainError('collector_endpoint_unavailable',503);}
    return { release: distribution.release, endpoint: distribution.collectorUrl, service: installations };
  }
  function personalArchive(issued: { installation: { id: string }; token: string }) {
    const { release, endpoint } = ready();
    const credentials = JSON.stringify({ installation_id: issued.installation.id, token: issued.token, endpoint }, null, 2) + '\n';
    return Buffer.from(zipSync({ ...release.files, 'adi-installation.json': Buffer.from(credentials) }, { level: 6, mtime: new Date(1980, 0, 1) }));
  }
  const retired=async()=>{throw new DomainError('plugin_entry_retired',410);};
  app.post(routes.authorize.path,retired);app.get(routes.online.path,retired);app.post(routes.download.path,retired);
  function bearer(request:import('fastify').FastifyRequest){const header=request.headers.authorization;if(typeof header!=='string'||!header.startsWith('Bearer '))throw new DomainError('plugin_unauthorized',401);return header.slice(7);}
  app.get(pluginAccessRoutes.setup.path,{schema:pluginAccessRoutes.setup},async request=>{if(!access)throw new DomainError('plugin_unavailable',503);await access.authorize(bearer(request));const {release,endpoint}=ready();return {data:{collector_url:endpoint,client:release.metadata},meta:{request_id:request.id}};});
  app.post(pluginAccessRoutes.grant.path,{schema:pluginAccessRoutes.grant},async request=>{
    if(!access)throw new DomainError('plugin_unavailable',503);const {service,release,endpoint}=ready();
    const material=await access.mutate(bearer(request),(sql,owner)=>service.issuePluginDownloadGrant(sql,owner.id));
    const archive=personalArchive(material.issued),sha256=createHash('sha256').update(archive).digest('hex');
    return {data:{authorization:material.authorization,expires_at:material.expires_at,installation_id:material.installation_id,download_path:'/api/v1/plugin/collection-client',sha256,bytes:archive.length,version:release.metadata.version,endpoint},meta:{request_id:request.id}};
  });
  app.get(pluginAccessRoutes.download.path,{schema:pluginAccessRoutes.download}, async (request, reply) => {
    const { service, release } = ready();
    const issued = await service.redeemPluginDownloadGrant(bearer(request));
    const archive = personalArchive(issued);
    const digest = createHash('sha256').update(archive).digest('hex');
    const filename = `adi-hook-client-${release.metadata.version}-personal.zip`;
    return reply.type('application/zip').header('Cache-Control', 'no-store, private').header('Content-Disposition', `attachment; filename="${filename}"`).header('X-Content-Type-Options', 'nosniff').header('X-Archive-Sha256', digest).header('Content-Length', archive.length).send(archive);
  });
}
