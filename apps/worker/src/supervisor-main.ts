import { fileURLToPath } from 'node:url';
import { supervise, type ManagedProcess } from './supervisor.js';

const environment = { ...process.env };
delete environment.ADI_ADMIN_EMAIL; delete environment.ADI_ADMIN_PASSWORD;
const entries = ['main.js', 'cleanup-main.js', 'maintenance-main.js'];
if (environment.ADI_USAGE_ENABLED === 'true') entries.push('usage-main.js');
if (!environment.ADI_DATABASE_URL || !environment.ADI_CLEANUP_JOURNAL_DIR || !['true', 'false', undefined].includes(environment.ADI_USAGE_ENABLED)) {
  process.stderr.write('{"error":"worker_configuration_required"}\n'); process.exitCode = 1;
} else {
  environment.ADI_MAINTENANCE_ENABLED = 'true';
  const specs: ManagedProcess[] = entries.map(entry => ({ name: entry.replace('-main.js', '').replace('.js', ''), command: process.execPath,
    args: ['--max-old-space-size=256', fileURLToPath(new URL(entry, import.meta.url))], env: environment }));
  const supervisor = supervise(specs, { restart: true, shutdownMs: 8000, ...(environment.ADI_DEV_INHERIT_GROUP === 'true' ? {detached:false} : {}) });
  process.stdout.write('{"event":"worker_supervisor_started"}\n');
  process.exitCode = await supervisor.finished;
}
