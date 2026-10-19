// Stateful Docker boundary double. Actual package/header/deployer/config helper run unchanged.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
let a = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(a) + '\n');
const file = process.env.FIXTURE_STATE, fail = process.env.FIXTURE_FAIL;
let state = { images: {}, containers: {} }; try { state = JSON.parse(fs.readFileSync(file)); } catch { /* New isolated Docker state. */ }
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const option = (key, fallback) => a.includes(key) ? a[a.indexOf(key) + 1] : fallback;
const metadata = ref => {
  if (state.images[ref]) return state.images[ref];
  if (ref.startsWith('sha256:')) return Object.values(state.images).find(i => i.id === ref);
  if (!ref.startsWith('candidate.local/')) return undefined;
  const role = /-(api|collector|worker|web):/.exec(ref)?.[1], revision = ref.split(':').at(-1);
  if (!role) return undefined;
  const result = { id: 'sha256:' + crypto.createHash('sha256').update(role + revision).digest('hex'), revision, platform: 'linux/amd64' };
  state.images[ref] = result; save(); return result;
};
const readEnv = root => Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').filter(s => /^[A-Z_]+[A-Z0-9_]*=/.test(s)).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
function template(root) {
  const e = readEnv(root), name = option('-p', e.COMPOSE_PROJECT_NAME || 'ai-dev-insight');
  for (const key of ['ADI_PG_ADMIN_PASSWORD','ADI_APP_DB_PASSWORD','ADI_ADMIN_EMAIL','ADI_ADMIN_PASSWORD','ADI_WEB_ORIGIN','ADI_PUBLIC_COLLECTOR_URL']) if (!e[key]) process.exit(7);
  const services = {};
  for (const service of ['postgres','api','collector','worker','web','initialize','prepare-storage']) {
    const role = ['initialize','prepare-storage'].includes(service) ? 'api' : service;
    services[service] = { image: 'ai-dev-insight-offline-' + role + ':' + (role === 'postgres' ? '18.6' : 'latest'), environment: role === 'web' || service === 'prepare-storage' ? {} : { ADI_DATABASE_URL: 'postgresql://synthetic@postgres/adi', ADI_WEB_ORIGIN: e.ADI_WEB_ORIGIN } };
    if (service === 'postgres') services[service].volumes = [{type:'volume',source:'postgres-data',target:'/var/lib/postgresql'}];
    if (['api','initialize','prepare-storage'].includes(service)) services[service].volumes = [{type:'volume',source:'collection-keys',target:'/var/lib/adi-credentials'}];
    if (['worker','api','prepare-storage'].includes(service)) (services[service].volumes ||= []).push({type:'volume',source:'cleanup-journal',target:'/var/lib/adi-cleanup'});
    if (service === 'web') services[service].ports = [{target:8080,published:e.ADI_WEB_HOST_PORT || '4181',protocol:'tcp'}];
    if (service === 'collector') services[service].ports = [{target:4186,published:e.ADI_COLLECTOR_HOST_PORT || '4186',protocol:'tcp',host_ip:'127.0.0.1'}];
  }
  return { name, services, volumes: Object.fromEntries(['postgres-data','collection-keys','cleanup-journal'].map(v=>[v,{name:name+'_'+v}])) };
}
if (a[0] === 'info') { if (a.includes('--format')) console.log('x86_64'); }
else if (a[0] === 'volume' && a[1] === 'ls') { /* No orphan volumes in this fixture. */ }
else if (a[0] === 'buildx') {
  process.exit(4); // CI packaging must not require a live index lookup.
} else if (a[0] === 'pull') {
  const ref = a.at(-1); state.images[ref] = {id:'sha256:'+'5'.repeat(64),platform:'linux/amd64'}; save();
} else if (a[0] === 'tag') { state.images[a[2]] = metadata(a[1]); save(); }
else if (a[0] === 'image' && a[1] === 'inspect') {
  const i = metadata(a[2]); if (!i) process.exit(1);
  const f = a.at(-1);
  console.log(f.includes('revision') ? i.revision : f.includes('Architecture') ? i.platform : i.id);
} else if (a[0] === 'image' && a[1] === 'save') {
  const index = a.indexOf('-o'); fs.writeFileSync(a[index+1], JSON.stringify(Object.fromEntries(a.slice(index+2).map(ref=>[ref,metadata(ref)]))));
} else if (a[0] === 'image' && a[1] === 'load') { Object.assign(state.images,JSON.parse(fs.readFileSync(option('-i')))); save(); }
else if (a[0] === 'ps') {
  const project = option('--filter','').split('=').at(-1);
  console.log(Object.keys(state.containers).filter(id=>state.containers[id].Config.Labels['com.docker.compose.project']===project).join('\n'));
} else if (a[0] === 'inspect') { console.log(JSON.stringify(a.slice(1).map(id=>state.containers[id]))); }
else if (a[0] === 'run') {
  if(a.includes('--input-type=module')) { if(fail==='upload')process.exit(7);process.exit(0); }
  const mounts = a.flatMap((v,i)=>v==='--mount'?[a[i+1]]:[]);
  const source = mount=>mount.split(',').find(v=>v.startsWith('src=')).slice(4);
  const tool = source(mounts.find(m=>m.includes('dst=/adi-tools'))), work = source(mounts.find(m=>m.includes('dst=/adi-work')));
  const index = a.indexOf('/adi-tools/site-config.mjs'), mode = a[index+1];
  if (mode === 'ports') { if (fail === 'ports') process.exit(7); process.exit(0); }
  const result=cp.spawnSync(process.execPath,[path.join(tool,'site-config.mjs'),...a.slice(index+1)], {env:{...process.env,ADI_DEPLOY_TOOL_WORK:work},encoding:'utf8'});
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
} else if (a[0] === 'compose') {
  a = a.slice(1);
  if (a[0] === 'version') { console.log(process.env.FIXTURE_COMPOSE_VERSION || '2.20.2'); process.exit(0); }
  const root = option('--project-directory',process.cwd()), configFile = option('-f',path.join(root,'docker-compose.yml'));
  const raw = fs.readFileSync(configFile,'utf8'), config = raw.startsWith('{') ? JSON.parse(raw) : template(root);
  const commands=['config','ps','stop','exec','run','up'], command=a.find(v=>commands.includes(v));
  const index=a.indexOf(command), args=a.slice(index+1), roles=args.filter(v=>Object.hasOwn(config.services,v));
  if (command==='config') {
    if (fail==='config' && configFile.includes('candidate')) process.exit(7);
    if (a.includes('--format')) console.log(JSON.stringify(config));
  } else if (command==='ps') {
    const requested=roles.length?roles:Object.keys(config.services);
    console.log(Object.keys(state.containers).filter(id=>{const c=state.containers[id];return c.Config.Labels['com.docker.compose.project']===config.name && requested.includes(c.Config.Labels['com.docker.compose.service']) && (!a.includes('--status') || c.State.Status==='running');}).join('\n'));
  } else if (command==='stop') {
    for(const c of Object.values(state.containers)) if(c.Config.Labels['com.docker.compose.project']===config.name && roles.includes(c.Config.Labels['com.docker.compose.service']))c.State.Status='exited'; save();
  } else if (command==='exec') { if(a.some(v=>v.includes('pg_database_size')))process.stdout.write('1024');else {if(fail==='backup')process.exit(7);process.stdout.write('synthetic-database-dump');} }
  else if (command==='run') {
    if(roles.includes('initialize') && fail==='migration')process.exit(7);
    if(a.includes('tar'))process.stdout.write('synthetic-private-volumes');
  } else if (command==='up') {
    for(const service of roles){
      const id=config.name+'-'+service+'-1',s=config.services[service],image=metadata(s.image);
      if(!image)process.exit(8);
      state.containers[id]={Image:image.id,Config:{Image:s.image,Labels:{'com.docker.compose.project':config.name,'com.docker.compose.service':service,'com.docker.compose.project.working_dir':root,'com.docker.compose.project.config_files':path.join(root,'docker-compose.yml'),'com.docker.compose.oneoff':'False'}},State:{Status:'running',Health:{Status:'healthy'}},Mounts:(s.volumes || []).filter(v=>v.type==='volume').map(v=>({Name:config.volumes[v.source].name,Destination:v.target}))};
    }save();
    if(fail==='startup' && roles.includes('api'))process.exit(7);
  } else process.exit(99);
} else process.exit(99);
