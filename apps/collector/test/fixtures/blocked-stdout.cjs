// Synthetic sink-pressure fixture. It never prints requests or credentials.
process.on('message', message => {
  if (message?.kind !== 'fill-output') return;
  const chunk = new Uint8Array(8192).fill(120);
  function fill() { while (process.stdout.write(chunk)) { /* fill bounded OS pipe */ } process.stdout.once('drain', fill); }
  fill(); process.send?.({ kind: 'filled' });
});
void import('../../dist/main.js');
