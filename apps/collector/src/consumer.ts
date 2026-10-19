import { fork } from 'node:child_process';
import { DeliveryQueue, type DeliveryLimits } from './delivery.js';

// Trusted startup configuration only; never obtain an executable path from HTTP.
// stdio is detached from the collector so unconsumed worker output cannot block it.
export function startConsumer(modulePath: string | URL, limits: Partial<DeliveryLimits> = {}) {
  const child = fork(modulePath, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const queue = new DeliveryQueue(child, limits);
  return { queue, child };
}
