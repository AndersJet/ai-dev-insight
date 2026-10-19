// Test-only consumer. Its ACK simulates a commit; it does not persist any data.
const seen = new Set();
process.on('message', message => {
  if (message.kind !== 'deliver') return;
  const envelope = JSON.parse(message.body);
  if (envelope.payload.mode === 'block') {
    process.send({ kind: 'blocked' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  if (envelope.payload.mode === 'exit') process.exit(1);
  const key = `${envelope.installation_id}:${envelope.client_event_id}`;
  const outcome = seen.has(key) ? 'duplicate' : 'committed';
  seen.add(key);
  process.send({ kind: 'result', id: message.id, outcome });
});
process.send({ kind: 'ready' });
