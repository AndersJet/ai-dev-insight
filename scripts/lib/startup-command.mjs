import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';
import { spawn } from 'node:child_process';

/** A cancelled build/init never advances to the next startup stage. */
export async function runStartup(command, args, env, shutdownMs = 8000, options = {}) {
  const child = spawn(command, args, { env, stdio: 'inherit', detached: options.detached ?? process.platform !== 'win32' });
  let cancelled = false, deadline;
  const signal = value => {
    try { if (child.pid && (options.detached ?? process.platform !== 'win32')) process.kill(-child.pid, value); else child.kill(value); } catch { /* Already exited. */ }
  };
  const stop = () => { if (cancelled) return; cancelled = true; signal('SIGTERM'); deadline = setTimeout(() => signal('SIGKILL'), shutdownMs); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', error => reject(Object.assign(new Error('startup_command_failed'),{systemCode:['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:undefined})));
      child.once('close', (code,signal) => code === 0 && !cancelled ? resolve() : reject(Object.assign(new Error('startup_command_failed'),{exitCode:code,signal,cancelled})));
    });
  } finally {
    clearTimeout(deadline); signal('SIGKILL');
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
