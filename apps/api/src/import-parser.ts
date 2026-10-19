import { Worker } from 'node:worker_threads';
import type { ParsedMembers } from '@adi/domain/member-file';
import { DomainError } from '@adi/domain';
let active = 0;
export async function parseUpload(data: Buffer, filename: string): Promise<ParsedMembers> {
  if (active >= 2) throw new DomainError('import_busy', 429);
  if (data.length > 5 * 1024 * 1024) throw new DomainError('file_too_large', 413);
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const bytes = Uint8Array.from(data);
      const worker = new Worker(new URL(import.meta.resolve('@adi/domain/member-file-worker')), { workerData: { data: bytes, filename }, transferList: [bytes.buffer], env: { NODE_ENV: 'production' }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      let finished = false;
      const fail = () => { if (finished) return; finished = true; clearTimeout(timer); reject(new DomainError('file_too_complex', 413)); void worker.terminate(); };
      const timer = setTimeout(fail, 10_000);
      worker.once('message', (result: { ok: boolean; parsed?: ParsedMembers; code?: string }) => { if (finished) return; finished = true; clearTimeout(timer); if (result.ok && result.parsed) resolve(result.parsed); else reject(new DomainError(result.code ?? 'invalid_file', 422)); void worker.terminate(); });
      worker.once('error', fail);
      worker.once('exit', fail);
    });
  } finally { active--; }
}
