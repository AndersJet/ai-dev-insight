import { EventEmitter } from 'node:events';
import type { Consumer, DeliveryMessage } from '../src/delivery.js';
export class FakeConsumer extends EventEmitter implements Consumer {
  connected = true;
  writable = true;
  messages: DeliveryMessage[] = [];
  callbacks: ((error: Error | null) => void)[] = [];
  send(message: DeliveryMessage, callback: (error: Error | null) => void) { this.messages.push(message); this.callbacks.push(callback); return this.writable; }
  kill() { this.connected = false; this.emit('disconnect'); return true; }
  ack(index: number, outcome = 'committed') { this.emit('message', { kind: 'result', id: this.messages[index]?.id, outcome }); }
}
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('condition timed out'); await delay(10); }
}
export const envelope = (id = 'event-1', payload: Record<string, unknown> = {}) => ({ schema_version: 2, installation_id: 'fixture', client_event_id: id, occurred_at: '2026-09-23T00:00:00Z', event_type: 'UserPromptSubmit', source_session_id: 'session-fixture', payload });
