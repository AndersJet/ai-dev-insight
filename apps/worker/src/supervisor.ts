import { spawn, type ChildProcess } from 'node:child_process';
import {randomUUID} from 'node:crypto';

export interface ManagedProcess { name: string; command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }
export interface ProcessEvent {event:string;name?:string;pid?:number;exit_code?:number|null;signal?:NodeJS.Signals|null;system_code?:string;duration_ms?:number;level?:'info'|'error'}
export function supervise(specs: ManagedProcess[], options: { restart?: boolean; shutdownMs?: number; detached?: boolean; onEvent?: (event: ProcessEvent) => void } = {}) {
  if (!specs.length || new Set(specs.map(spec => spec.name)).size !== specs.length) throw new Error('Distinct managed processes required');
  const children = new Set<ChildProcess>(), timers = new Set<ReturnType<typeof setTimeout>>();
  const shutdownMs = options.shutdownMs ?? 12000;
  let stopping = false, exitCode = 0, resolve!: (value: number) => void;
  const finished = new Promise<number>(done => { resolve = done; });
  const runId=/^[a-f0-9-]{36}$/.test(process.env.ADI_DEV_RUN_ID??'')?process.env.ADI_DEV_RUN_ID:randomUUID();
  const emit = options.onEvent ?? (event => { (event.level==='error'?process.stderr:process.stdout).write(JSON.stringify({at:new Date().toISOString(),level:'info',run_id:runId,component:'supervisor',stage:'applications',...event}) + '\n'); });
  const signal = (child: ChildProcess, value: NodeJS.Signals) => {
    try { if (child.pid && (options.detached ?? process.platform !== 'win32')) process.kill(-child.pid, value); else child.kill(value); } catch { /* Already exited. */ }
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function completed() {
    if (!stopping || children.size) return;
    clearTimeout(deadline); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); resolve(exitCode);
  }
  function close(code = 0) {
    if (stopping) return finished;
    stopping = true; exitCode = code;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    for (const child of children) signal(child, 'SIGTERM');
    deadline = setTimeout(() => { for (const child of children) signal(child, 'SIGKILL'); }, shutdownMs);
    completed(); return finished;
  }
  function interrupt() { void close(); }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  function launch(spec: ManagedProcess, failures = 0) {
    if (stopping) return;
    const started = Date.now();
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: options.detached ?? process.platform !== 'win32', stdio: 'inherit' });
    children.add(child);
    child.once('spawn', () => emit({ event: 'process_started', name: spec.name, ...(child.pid ? { pid: child.pid } : {}) }));
    child.once('error', error => {
      const code='code'in error&&typeof error.code==='string'&&['ENOENT','EACCES','EPERM','EMFILE','ENOMEM'].includes(error.code)?error.code:undefined;
      emit({ event: 'process_start_failed', name: spec.name,level:'error',...(code?{system_code:code}:{}) });void close(1);
    });
    child.once('close', (code,exitSignal) => {
      // The leader may exit while grandchildren remain (for example pnpm/vite).
      signal(child, 'SIGKILL'); children.delete(child);
      const details={name:spec.name,...(child.pid?{pid:child.pid}:{}),exit_code:code,signal:exitSignal,duration_ms:Date.now()-started};
      if (stopping) { emit({event:'process_stopped',...details});completed(); return; }
      const next = Date.now() - started >= 30000 ? 1 : failures + 1;
      if (!options.restart || next > 4) { emit({ event: 'process_failed',level:'error',...details }); void close(1); return; }
      emit({ event: 'process_restarting',...details });
      const timer = setTimeout(() => { timers.delete(timer); launch(spec, next); }, Math.min(4000, 250 * 2 ** (next - 1))); timers.add(timer);
    });
  }
  for (const spec of specs) launch(spec);
  return { close, finished };
}
