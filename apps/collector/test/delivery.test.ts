import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryQueue } from '../src/delivery.js';
import { FakeConsumer, until } from './helpers.js';

test('transport callback does not commit or free the consumer slot', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child, { maxInFlight: 1 }); t.after(() => queue.close());
  assert.equal(queue.admit('before ready'), false); child.emit('message', { kind: 'ready' });
  queue.admit('one'); queue.admit('two'); child.callbacks[0]?.(null);
  assert.equal(queue.snapshot().persisted, 0); assert.equal(child.messages.length, 1);
  child.ack(0); assert.equal(queue.snapshot().persisted, 1); assert.equal(child.messages.length, 2);
  child.ack(0); assert.equal(queue.snapshot().persisted, 1); // Repeated ACK is harmless.
  child.ack(1, 'duplicate'); assert.equal(queue.snapshot().duplicate, 1);
});
test('send false pauses transport without blindly resending', async t => {
  const child = new FakeConsumer(); child.writable = false;
  const queue = new DeliveryQueue(child); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('one'); queue.admit('two'); assert.equal(child.messages.length, 1);
  child.writable = true; child.callbacks[0]?.(null); await until(() => child.messages.length === 2);
  assert.equal(queue.snapshot().persisted, 0); assert.notEqual(child.messages[0]?.id, child.messages[1]?.id);
});
test('total bytes and records include in-flight messages', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child, { maxItems: 2, maxBytes: 6, maxInFlight: 1, maxInFlightBytes: 4 }); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  assert.equal(queue.admit('1234'), true); assert.equal(queue.admit('567'), false); assert.equal(queue.admit('56'), true); assert.equal(queue.admit(''), false);
  assert.equal(queue.snapshot().retainedBytes, 6); child.ack(0); assert.equal(queue.snapshot().retainedBytes, 2);
});
test('expired sent item stays unknown with retained credit; late ACK reconciles', async t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child, { maxAgeMs: 20, maxInFlight: 1 }); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('sent'); queue.admit('waiting');
  await until(() => queue.snapshot().deliveryUnknown === 1 && queue.snapshot().dropped === 1);
  assert.equal(queue.snapshot().inFlight, 1); assert.equal(queue.snapshot().retainedItems, 1);
  child.ack(0); assert.equal(queue.snapshot().deliveryUnknown, 0); assert.equal(queue.snapshot().persisted, 1);
});
test('disconnect separates unsent drops from uncertain sent messages', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child, { maxInFlight: 1 }); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('sent'); queue.admit('waiting'); child.kill(); child.emit('exit', 1);
  assert.equal(queue.snapshot().deliveryUnknown, 1); assert.equal(queue.snapshot().dropped, 1); assert.equal(queue.snapshot().retainedBytes, 0);
  assert.equal(queue.admit('new'), false);
  child.callbacks[0]?.(new Error('late IPC error')); assert.equal(queue.snapshot().deliveryUnknown, 1);
});
test('late IPC error after a committed result cannot undo commit', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('sent'); child.ack(0); child.callbacks[0]?.(new Error('late callback'));
  assert.equal(queue.snapshot().persisted, 1); assert.equal(queue.snapshot().deliveryUnknown, 0);
});
test('invalid acknowledgments and confirmed rejection have distinct outcomes', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('body'); child.ack(0, 'received'); child.emit('message', { kind: 'result', id: 'wrong', outcome: 'committed' });
  assert.equal(queue.snapshot().inFlight, 1); assert.equal(queue.snapshot().persisted, 0);
  child.ack(0, 'rejected'); assert.equal(queue.snapshot().dropped, 1); assert.equal(queue.snapshot().retainedItems, 0);
});
test('IPC throw stops further dispatch and does not claim a definite drop', t => {
  const child = new FakeConsumer(); child.send = () => { throw new Error('channel failure'); };
  const queue = new DeliveryQueue(child); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  queue.admit('body'); assert.equal(queue.snapshot().deliveryUnknown, 1); assert.equal(queue.snapshot().dropped, 0); assert.equal(queue.admit('next'), false);
});

test('IPC carries the original queue deadline without accepting a payload budget or replacing admission identity', t => {
  const child = new FakeConsumer(); const queue = new DeliveryQueue(child, { maxAgeMs: 10000 }); t.after(() => queue.close()); child.emit('message', { kind: 'ready' });
  const context = { admissionEpoch: 1, receivedAt: '2026-10-10T00:00:00Z', tokenHash: 'a'.repeat(64) }, body = JSON.stringify({ deadline: Date.now() + 60000, admissionEpoch: 9 });
  const before = Date.now(); assert.equal(queue.admit(body, context), true); const after = Date.now(), message = child.messages[0]!;
  assert.equal(message.body, body); assert.equal(message.context, context); assert.ok(message.deadline! >= before + 10000 && message.deadline! <= after + 10000); assert.equal(queue.snapshot().admitted, 1);
});
