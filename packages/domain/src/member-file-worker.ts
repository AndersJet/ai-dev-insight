import { parentPort, workerData } from 'node:worker_threads';
import { parseMemberFile } from './member-file.js';
try {
  const parsed = await parseMemberFile(Buffer.from(workerData.data), workerData.filename);
  parentPort?.postMessage({ ok: true, parsed });
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_file';
  parentPort?.postMessage({ ok: false, code });
}
