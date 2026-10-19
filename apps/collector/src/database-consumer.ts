import type {RuntimeHeartbeat} from '@adi/storage';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DeliveryQueue, type AdmissionContext, type DeliveryLimits } from './delivery.js';
import type { IntakePolicy } from './http.js';

export type DatabaseConsumerOptions={connectionString:string;schema:string};
export type ConsumerSnapshot=ReturnType<DeliveryQueue['snapshot']>&{restarts:number;policyExpiresAt:number|null};
type TelemetryOutcome='not_requested'|'acknowledged'|'unconfirmed'|'unsupported';
export interface ConsumerStopReport{started_at:string;finished_at:string;elapsed_ms:number;max_stop_ms:number;forced:boolean;telemetry:TelemetryOutcome;before:ConsumerSnapshot;after:ConsumerSnapshot;accounted:boolean;all_admitted_confirmed:boolean;worker_exit_code:number|null;worker_signal:NodeJS.Signals|null}

// The HTTP event loop only keeps an expiring policy snapshot. SQL and transaction
// work, including refreshing that snapshot, run in this separate OS process.
export function startDatabaseConsumer(config: DatabaseConsumerOptions, limits: Partial<DeliveryLimits> = {},shutdown:{drainMs?:number;maxStopMs?:number}={}) {
  const drainMs=shutdown.drainMs??5000,maxStopMs=shutdown.maxStopMs??10000;
  if(!Number.isSafeInteger(drainMs)||drainMs<1||!Number.isSafeInteger(maxStopMs)||maxStopMs<50||maxStopMs>10000||drainMs>=maxStopMs)throw new Error('Shutdown requires a drain interval inside a total budget of at most 10000ms');
  let child: ChildProcess; let delivery: DeliveryQueue;
  let current: IntakePolicy | null = null;
  let reporting=false;
  let stopping = false; let restarts = 0; let failures = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let finalReport:ConsumerStopReport|null=null,pendingFinal:{id:string;resolve:(result:TelemetryOutcome)=>void}|undefined;
  const counters = { admitted: 0, persisted: 0, duplicate: 0, dropped: 0, deliveryUnknown: 0, refused: 0 };
  const counterKeys = Object.keys(counters) as (keyof typeof counters)[];
  let priorCounters = { ...counters };
  // Terminated processes' unknown outcomes stay visible; memory admission is
  // not durable delivery, so uncertain messages are never silently replayed.
  function launch() {
    reporting=false;
    priorCounters = { ...counters };
    child = fork(new URL('../dist/postgres-worker.js', import.meta.url), [], {
      execArgv: ['--max-old-space-size=256'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
    });
    delivery = new DeliveryQueue(child, limits);
    const launched = Date.now(); const instance = child; const queue = delivery;
    child.on('message', (message: unknown) => {
      if(child===instance&&message&&typeof message==='object'&&'kind'in message&&message.kind==='runtime-final-result'&&'request_id'in message&&message.request_id===pendingFinal?.id&&'outcome'in message&&['acknowledged','unconfirmed','unsupported'].includes(String(message.outcome))){pendingFinal?.resolve(message.outcome as TelemetryOutcome);return;}
      if (stopping || !instance.connected || !message || typeof message !== 'object' || !('kind' in message) || message.kind !== 'policy' || !('expiresAt' in message) || !('installations' in message)) return;
      if (typeof message.expiresAt !== 'number' || !Array.isArray(message.installations)) return;
      current = { expiresAt: message.expiresAt, installations: new Map(message.installations),writable:'writable'in message&&message.writable===true };
    });
    const terminate = () => {
      if(stopping)return;
      current = null; instance.kill('SIGTERM');
      if (!forceStop) { forceStop = setTimeout(() => instance.kill('SIGKILL'), 6000); forceStop.unref(); }
    };
    child.on('disconnect', terminate); child.on('error', terminate);
    watchdog = setInterval(() => { if (queue.snapshot().deliveryUnknown > 0) terminate(); }, 250); watchdog.unref();
    child.on('exit', () => {
      current = null; clearInterval(watchdog); clearTimeout(forceStop); forceStop = undefined;
      if (stopping) return;
      queue.close();
      const final = queue.snapshot(); for (const key of counterKeys) counters[key] += final[key];
      if (Date.now() - launched >= 30_000) failures = 0;
      const backoff = Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
      restartTimer = setTimeout(() => { restarts++; launch(); }, backoff); restartTimer.unref();
    });
    child.send({ kind: 'configure', ...config }, error => { if (error) terminate(); });
  }
  launch();
  let closing: Promise<void> | undefined;
  function snapshot() {
    const result = delivery.snapshot();
    for (const key of counterKeys) result[key] += priorCounters[key];
    return { ...result, ready: result.ready && !stopping, restarts, policyExpiresAt: current?.expiresAt ?? null };
  }
  return {
    reportRuntime: (value:RuntimeHeartbeat) => {
      const instance=child;if(stopping||reporting||!instance.connected)return false;reporting=true;
      try{return instance.send({kind:'runtime-heartbeat',value},()=>{if(child===instance)reporting=false;});}catch{reporting=false;return false;}
    },
    get child() { return child; },
    queue: { admit: (body: string, context?: AdmissionContext) => !stopping && delivery.admit(body, context), snapshot,isReady:()=>!stopping&&delivery.isReady() },
    policy: () => current,
    stopReport:()=>finalReport?structuredClone(finalReport):null,
    close: (heartbeat?: (value:ConsumerSnapshot)=>RuntimeHeartbeat) => closing ??= (async () => {
      const started=performance.now(),startedAt=new Date().toISOString(),before=snapshot();let forced=false,telemetry:TelemetryOutcome=heartbeat?'unconfirmed':'not_requested';
      stopping = true; current = null; clearTimeout(restartTimer); clearInterval(watchdog);clearTimeout(forceStop);
      const killTimer=setTimeout(()=>{forced=true;child.kill('SIGKILL');},maxStopMs);killTimer.unref();
      try{
        while(delivery.snapshot().retainedItems>0&&child.connected&&performance.now()-started<drainMs)await delay(Math.min(20,Math.max(1,drainMs-(performance.now()-started))));
        // Freeze the accounting before the final observation. Late outcomes
        // remain unknown once the parent relinquishes their confirmation path.
        delivery.close(false);
        if(heartbeat&&child.connected){let ackTimer:ReturnType<typeof setTimeout>|undefined;try{const requestId=randomUUID(),value=heartbeat(snapshot()),remaining=Math.max(0,maxStopMs-(performance.now()-started)-50),ack=new Promise<TelemetryOutcome>(resolve=>{pendingFinal={id:requestId,resolve};ackTimer=setTimeout(()=>resolve('unconfirmed'),Math.min(1000,remaining));});child.send({kind:'runtime-final',request_id:requestId,value},error=>{if(error)pendingFinal?.resolve('unconfirmed');});telemetry=await ack;}catch{telemetry='unconfirmed';}finally{clearTimeout(ackTimer);pendingFinal=undefined;}}
        if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
      }finally{clearTimeout(killTimer);clearTimeout(forceStop);pendingFinal=undefined;delivery.close(false);const after=snapshot();finalReport={started_at:startedAt,finished_at:new Date().toISOString(),elapsed_ms:Math.ceil(performance.now()-started),max_stop_ms:maxStopMs,forced,telemetry,before,after,accounted:after.admitted===after.persisted+after.duplicate+after.dropped+after.deliveryUnknown+after.pending,all_admitted_confirmed:after.admitted===after.persisted+after.duplicate&&after.dropped===0&&after.deliveryUnknown===0,worker_exit_code:child.exitCode,worker_signal:child.signalCode};}
    })(),
  };
}
