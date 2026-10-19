// Runs with Node from the API image: no Node/Python installation on the host.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';

const residents = ['postgres', 'api', 'collector', 'worker', 'web'];
const tasks = ['prepare-storage', 'initialize'];
class ConfigError extends Error {}
const fail = code => { throw new ConfigError(code); };
const workRoot = process.env.ADI_DEPLOY_TOOL_WORK || '/adi-work';
const siteRoot = process.env.ADI_DEPLOY_TOOL_SITE || '/adi-site';
const read = name => {
  let raw;
  try { raw = fs.readFileSync(workRoot + '/' + name); }
  catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? error.code : 'UNKNOWN';
    fail('无法读取配置输入：' + name + '（' + code + '）');
  }
  try { return JSON.parse(raw.toString('utf8')); }
  catch { fail('配置输入不是完整 JSON：' + name + '（' + raw.length + ' bytes，SHA256 ' + createHash('sha256').update(raw).digest('hex') + '）'); }
};
const output = value => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');

export function verifySite(config, containers, root, partial = false) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.name)) fail('项目名不合法');
  for (const c of containers) {
    const labels = c.Config?.Labels || {};
    if (labels['com.docker.compose.project'] !== config.name ||
        labels['com.docker.compose.project.working_dir'] !== root ||
        labels['com.docker.compose.oneoff'] === 'True') fail('容器不属于本目录，请先核对项目名和目录');
    if (![...residents, ...tasks].includes(labels['com.docker.compose.service'])) fail('检测到未知容器服务，不自动接管');
    const files = labels['com.docker.compose.project.config_files'];
    if (files !== root + '/docker-compose.yml') fail('检测到额外 Compose 配置文件，需先合并现场配置');
  }
  for (const service of residents) {
    const found = containers.filter(c => c.Config?.Labels?.['com.docker.compose.service'] === service);
    if (found.length !== 1) {
      if (partial && found.length === 0) continue;
      fail('常驻容器缺失或重复：' + service);
    }
    const c = found[0];
    if (!config.services[service] || (!partial && c.Config.Image !== config.services[service].image)) fail('配置与实际容器镜像不一致：' + service);
    for (const mount of config.services[service].volumes || []) {
      if (mount.type !== 'volume') continue;
      const expected = config.volumes?.[mount.source]?.name;
      if (!expected || !c.Mounts?.some(m => m.Name === expected && m.Destination === mount.target)) fail('持久卷归属不一致：' + service);
    }
  }
  const keys = Object.keys(config.services);
  if (keys.some(key => ![...residents, ...tasks].includes(key))) fail('存在未知服务，不自动接管');
  return config.name;
}

export function mergeSite(template, current, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('版本号不合法');
  const result = JSON.parse(JSON.stringify(template));
  if (current) {
    result.name = current.name;
    result.volumes = current.volumes;
    result.networks = current.networks;
    // The database and its bootstrap mount are not application upgrade targets.
    result.services.postgres = current.services.postgres;
    const siteKeys = ['volumes', 'ports', 'networks', 'security_opt', 'mem_limit', 'cpus', 'shm_size', 'pids_limit', 'logging', 'extra_hosts', 'dns', 'ulimits'];
    for (const service of [...residents, ...tasks].filter(s => s !== 'postgres')) {
      const old = current.services[service];
      if (!old) fail('部署配置缺少服务：' + service);
      // Preserve site-level resource, port, network, mount and EL7 compatibility
      // settings; new commands/environment/health checks come from this release.
      for (const key of siteKeys) {
        if (old[key] !== undefined) result.services[service][key] = old[key];
      }
      const known = new Set([...Object.keys(template.services[service]), ...siteKeys, 'image', 'container_name']);
      if (Object.keys(old).some(key => !known.has(key))) fail('未识别的现场设置：' + service);
      if (old.container_name) result.services[service].container_name = old.container_name;
      if (old.environment?.ADI_DATABASE_URL !== template.services[service].environment?.ADI_DATABASE_URL && old.environment?.ADI_DATABASE_URL !== undefined) fail('数据库连接与环境配置不一致：' + service);
    }
  }
  for (const service of [...residents, ...tasks].filter(s => s !== 'postgres')) {
    const role = tasks.includes(service) ? 'api' : service;
    result.services[service].image = 'ai-dev-insight-offline-' + role + ':' + revision;
  }
  return result;
}

export function verifyHealth(config, containers, identities = {}) {
  for (const service of residents) {
    const c = containers.find(c => c.Config?.Labels?.['com.docker.compose.service'] === service);
    if (!c || c.State?.Status !== 'running') fail('服务尚未运行：' + service);
    if (service !== 'worker' && c.State.Health?.Status !== 'healthy') fail('服务尚未就绪：' + service);
    if (c.Config.Image !== config.services[service].image) fail('服务版本不符合部署配置：' + service);
    if (identities[service] && c.Image !== identities[service]) fail('服务镜像内容与交付包不一致：' + service);
  }
  return '技术检查通过';
}

export function cleanupCandidates(root, entries, references) {
  const protectedPath = name => references.some(ref => ref === root + '/' + name || ref.startsWith(root + '/' + name + '/'));
  return entries.filter(({name, type}) => /^[a-zA-Z0-9_.-]+$/.test(name) && !protectedPath(name) && (
    (type === 'file' && (['images.tar', 'export-images.sh', 'load-images.sh', 'import-test-images.sh'].includes(name) || /^ai-dev-insight-[a-f0-9]{12}-(amd64|arm64)-[0-9]{8}T[0-9]{6}Z\.tar\.gz(\.sha256)?$/.test(name))) ||
    (type === 'bundle' && /^ai-dev-insight-[a-f0-9]{12}-/.test(name))
  )).map(entry => entry.name);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'project') {
    const config = read(args[0] || 'current.json');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.name)) fail('项目名不合法');
    output(config.name);
  } else if (mode === 'current-version') {
    const apps = read('containers.json').filter(c => ['api','collector','worker','web'].includes(c.Config?.Labels?.['com.docker.compose.service']));
    const versions = apps.map(c => c.Config.Image.match(/:([a-f0-9]{40})$/)?.[1] || c.Config.Labels['org.opencontainers.image.revision']);
    output(versions.length === 4 && versions.every(v => /^[a-f0-9]{40}$/.test(v || '')) && new Set(versions).size === 1 ? versions[0] : '未登记或混合版本（原镜像身份将单独保留）');
  } else if (mode === 'verify') output(verifySite(read('current.json'), read('containers.json'), args[0], args[1] === 'partial'));
  else if (mode === 'merge') {
    const config = mergeSite(read('template.json'), fs.existsSync(workRoot + '/current.json') ? read('current.json') : null, args[0]);
    if (args[1] === 'web-el7-compat') config.services.web.security_opt = ['no-new-privileges:true', 'seccomp=unconfined'];
    output(config);
  }
  else if (mode === 'snapshot') {
    const config = read('current.json'), containers = read('containers.json');
    for (const service of Object.keys(config.services)) {
      const role = tasks.includes(service) ? 'api' : service;
      const c = containers.find(c => c.Config?.Labels?.['com.docker.compose.service'] === role);
      if (!c?.Image?.match(/^sha256:[a-f0-9]{64}$/)) fail('无法固定备份镜像身份：' + service);
      config.services[service].image = c.Image;
    }
    output(config);
  } else if (mode === 'health') {
    const rows = fs.readFileSync(new URL('./images.manifest', import.meta.url), 'utf8').split('\n').filter(row => row && !row.startsWith('#')).map(row => row.split('\t'));
    output(verifyHealth(read('current.json'), read('containers.json'), Object.fromEntries(rows.map(row => [row[0], row[3]]))));
  }
  else if (mode === 'cleanup') {
    const root = args[0], references = fs.readFileSync(workRoot + '/protected-paths', 'utf8').split('\n').filter(ref => ref.startsWith('/'));
    const allowed = new Set(['images.tar','images.manifest','docker-compose.yml','postgres-init.sql','.env','.env.example','lib.sh','export-images.sh','load-images.sh','backup.sh','README.md','SHA256SUMS']);
    const entries = fs.readdirSync(siteRoot, {withFileTypes:true}).map(entry => {
      let type = entry.isFile() ? 'file' : '';
      if (entry.isDirectory() && /^ai-dev-insight-[a-f0-9]{12}-/.test(entry.name)) {
        const dir = siteRoot + '/' + entry.name, files = fs.readdirSync(dir, {withFileTypes:true});
        const env = fs.existsSync(dir + '/.env') ? fs.readFileSync(dir + '/.env', 'utf8') : '';
        const blankTemplate = !env || (fs.existsSync(dir + '/.env.example') && env === fs.readFileSync(dir + '/.env.example', 'utf8'));
        if (files.every(file => file.isFile() && allowed.has(file.name)) && fs.existsSync(dir + '/images.manifest') &&
            blankTemplate && !/^\s*(ADI_PG_ADMIN_PASSWORD|ADI_APP_DB_PASSWORD|ADI_ADMIN_PASSWORD|TRAE_OPENAPI_APP_SECRET)\s*=\s*\S/m.test(env)) type = 'bundle';
      }
      return {name:entry.name,type};
    });
    for (const name of cleanupCandidates(root, entries, references)) output('archive\t' + name);
    if (fs.existsSync(siteRoot + '/archive') && !fs.lstatSync(siteRoot + '/archive').isSymbolicLink()) {
      for (const entry of fs.readdirSync(siteRoot + '/archive', {withFileTypes:true})) {
        if (!entry.isDirectory() || !/^[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(entry.name)) continue;
        const relative = 'archive/' + entry.name, dir = siteRoot + '/' + relative;
        if (references.some(ref => ref === root + '/' + relative || ref.startsWith(root + '/' + relative + '/'))) continue;
        if (!fs.existsSync(dir + '/.adi-managed-archive') || !fs.existsSync(dir + '/contents.txt')) continue;
        const created = Number(fs.readFileSync(dir + '/.adi-managed-archive','utf8').trim());
        const names = new Set(fs.readFileSync(dir + '/contents.txt','utf8').trim().split('\n'));
        if (created > 0 && Date.now()/1000-created >= 14*86400 && fs.readdirSync(dir).every(name => names.has(name) || ['.adi-managed-archive','contents.txt'].includes(name))) output('purge\t' + relative);
      }
    }
  }
  else if (mode === 'ports') {
    for (const service of residents) for (const port of read('template.json').services[service]?.ports || []) {
      if (port.protocol && port.protocol !== 'tcp') fail('不支持的端口协议');
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => reject(new ConfigError('端口不可绑定：' + port.published)));
        server.listen(Number(port.published), port.host_ip || '0.0.0.0', () => server.close(resolve));
      });
    }
  } else fail('未知配置检查操作');
}
if (process.argv[1]?.endsWith('/site-config.mjs')) {
  main().catch(error => { process.stderr.write('配置检查失败：' + (error instanceof ConfigError ? error.message.replace(/[\r\n]/g, ' ') : '未预期的配置处理错误（' + (['TypeError','RangeError','SyntaxError'].includes(error?.name) ? error.name : 'Error') + '）') + '\n'); process.exitCode = 1; });
}
