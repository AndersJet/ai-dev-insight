import { randomUUID } from 'node:crypto';

export interface DeliveryLimits {
  maxItems: number; maxBytes: number; maxInFlight: number; maxInFlightBytes: number; maxAgeMs: number;
}
const defaults: DeliveryLimits = { maxItems: 4096, maxBytes: 128 * 1024 * 1024, maxInFlight: 128, maxInFlightBytes: 8 * 1024 * 1024, maxAgeMs: 10_000 };
export interface AdmissionContext { admissionEpoch: number; receivedAt: string; tokenHash: string }
interface Item { body: string; context?: AdmissionContext; bytes: number; deadline: number; state: 'queued' | 'sent' | 'unknown' }
export interface DeliveryMessage { kind: 'deliver'; id: string; body: string; context?: AdmissionContext; deadline?: number }
export interface Consumer {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  send(message: DeliveryMessage, callback: (error: Error | null) => void): boolean;
}

// A successful IPC send is never a commit. Credits belong to items until the
// consumer reports an outcome or exits, including items with an expired ACK.
export class DeliveryQueue {
  private readonly items = new Map<string, Item>();
  private readonly limits: DeliveryLimits;
  private readonly timer: ReturnType<typeof setInterval>;
  private ready = false;
  private closed = false;
  private blocked = false;
  private pumping = false;
  private bytes = 0;
  private inFlightBytes = 0;
  private inFlight = 0;
  private counters = { admitted: 0, persisted: 0, duplicate: 0, dropped: 0, deliveryUnknown: 0, refused: 0 };

  constructor(private readonly child: Consumer, limits: Partial<DeliveryLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Delivery limits must be positive integers');
    child.on('message', (message: unknown) => this.receive(message));
    child.on('disconnect', () => this.disconnected());
    child.on('exit', () => this.disconnected());
    child.on('error', () => this.disconnected());
    this.timer = setInterval(() => this.expire(), Math.min(100, this.limits.maxAgeMs));
    this.timer.unref();
  }

  admit(body: string, context?: AdmissionContext): boolean {
    const bytes = Buffer.byteLength(body);
    if (this.closed || !this.child.connected || !this.ready || this.items.size >= this.limits.maxItems || this.bytes + bytes > this.limits.maxBytes || bytes > this.limits.maxInFlightBytes) {
      this.counters.refused++;
      return false;
    }
    this.items.set(randomUUID(), { body, ...(context ? { context } : {}), bytes, deadline: Date.now() + this.limits.maxAgeMs, state: 'queued' });
    this.bytes += bytes;
    this.counters.admitted++;
    this.pump();
    return true;
  }

  snapshot() {
    let pending = 0;
    for (const item of this.items.values()) if (item.state !== 'unknown') pending++;
    return { ...this.counters, pending, retainedItems: this.items.size, retainedBytes: this.bytes, inFlight: this.inFlight, inFlightBytes: this.inFlightBytes, ready: this.ready && !this.closed, backpressured: this.blocked };
  }

  isReady() { return this.ready&&!this.closed&&this.child.connected&&this.counters.deliveryUnknown===0; }

  close(terminate = true) {
    this.closed = true;
    clearInterval(this.timer);
    this.disconnected();
    if(terminate)this.child.kill('SIGTERM');
  }

  private finish(id: string, item: Item, result: 'persisted' | 'duplicate' | 'dropped') {
    if (item.state === 'unknown') this.counters.deliveryUnknown--;
    if (item.state !== 'queued') { this.inFlight--; this.inFlightBytes -= item.bytes; }
    this.items.delete(id);
    this.bytes -= item.bytes;
    this.counters[result]++;
  }

  private receive(message: unknown) {
    if (this.closed || !this.child.connected || typeof message !== 'object' || message === null) return;
    if (!('kind' in message)) return;
    if (message.kind === 'ready') { this.ready = true; this.pump(); return; }
    if (message.kind !== 'result' || !('id' in message) || typeof message.id !== 'string' || !('outcome' in message)) return;
    const item = this.items.get(message.id);
    if (!item || item.state === 'queued') return;
    if (message.outcome === 'committed') this.finish(message.id, item, 'persisted');
    else if (message.outcome === 'duplicate') this.finish(message.id, item, 'duplicate');
    else if (message.outcome === 'rejected') this.finish(message.id, item, 'dropped');
    else return; // Invalid or ambiguous results never free credits.
    this.pump();
  }

  private pump() {
    if (this.pumping || this.closed || !this.ready || this.blocked) return;
    // A timed-out consumer cannot gain more work by simply not acknowledging.
    if (this.counters.deliveryUnknown > 0) return;
    this.pumping = true;
    try {
      for (const [id, item] of this.items) {
        if (this.blocked || !this.ready || this.inFlight >= this.limits.maxInFlight) break;
        if (item.state !== 'queued') continue;
        if (item.deadline <= Date.now()) { this.finish(id, item, 'dropped'); continue; }
        if (this.inFlightBytes + item.bytes > this.limits.maxInFlightBytes) break;
        item.state = 'sent'; this.inFlight++; this.inFlightBytes += item.bytes;
        try {
          const writable = this.child.send({ kind: 'deliver', id, body: item.body, deadline: item.deadline, ...(item.context ? { context: item.context } : {}) }, (error: Error | null) => {
            if (error) { this.ready = false; if (this.items.get(id) === item) this.markUnknown(item); }
            else this.blocked = false;
            // send callbacks only release the transport pause, not delivery credit.
            queueMicrotask(() => this.pump());
          });
          if (!writable) this.blocked = true;
        } catch {
          this.ready = false; this.markUnknown(item); break;
        }
      }
    } finally { this.pumping = false; }
  }

  private markUnknown(item: Item) {
    if (item.state === 'sent') { item.state = 'unknown'; this.counters.deliveryUnknown++; }
  }

  private expire() {
    const now = Date.now();
    for (const [id, item] of this.items) {
      if (item.deadline > now) continue;
      if (item.state === 'queued') this.finish(id, item, 'dropped');
      else this.markUnknown(item); // Retain the slot until late result or disconnect.
    }
  }

  private disconnected() {
    this.ready = false;
    for (const [id, item] of this.items) {
      if (item.state === 'queued') this.finish(id, item, 'dropped');
      else this.markUnknown(item);
    }
    // Once IPC disconnects no late outcome can be trusted; unknown stays visible.
    this.items.clear(); this.bytes = 0; this.inFlight = 0; this.inFlightBytes = 0;
  }
}
