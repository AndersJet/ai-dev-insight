import {randomUUID} from 'node:crypto';
import type {RuntimeHeartbeat} from '@adi/storage';
import { createCollector } from './http.js';
import { startDatabaseConsumer,type DatabaseConsumerOptions } from './database-consumer.js';

const connectionString = process.env.ADI_DATABASE_URL;
const schema = process.env.ADI_DATABASE_SCHEMA ?? 'adi';
const port = Number(process.env.ADI_COLLECTOR_PORT ?? '4186');
const validStorage=!!connectionString&&/^[a-z][a-z0-9_]{0,62}$/.test(schema)&&!['public','pg_catalog','information_schema'].includes(schema)&&!schema.startsWith('pg_');
if (!validStorage || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('{"error":"collector_configuration_required"}\n'); process.exit(1);
}
const configuration:DatabaseConsumerOptions={connectionString:connectionString!,schema};
// Leave a small part of the process stop budget for socket and log teardown.
const consumer = startDatabaseConsumer(configuration,{}, {drainMs:5000,maxStopMs:9000});
const intake = createCollector(consumer.queue, consumer.policy);
let stopping = false;const bootId=randomUUID();let runtimeSequence=0;
function heartbeat(stopped=false,delivery=consumer.queue.snapshot()):RuntimeHeartbeat{
 const metrics:Record<string,number|boolean>={};
 for(const [key,value] of Object.entries(intake.snapshot()))metrics[`intake_${key}`]=value;
 for(const [key,value] of Object.entries(delivery))if(value!==null)metrics[`delivery_${key}`]=value;
 return {component:'collector',boot_id:bootId,sequence:++runtimeSequence,state:stopped?'stopped':delivery.ready&&(consumer.policy()?.expiresAt??0)>Date.now()?'running':'degraded',metrics};
}
function reportRuntime(){consumer.reportRuntime(heartbeat());}
const runtimeReporting=setInterval(reportRuntime,10000);runtimeReporting.unref();
// Log only counters, never tokens, database URLs or event content. If the log
// reader blocks, skip samples instead of allocating an unbounded stdout queue.
let logWritable = true;
process.stdout.on('drain', () => { logWritable = true; });
const report = () => {
  if (logWritable) logWritable = process.stdout.write(JSON.stringify({ event: 'collector_counters', at: new Date().toISOString(), intake: intake.snapshot(), delivery: consumer.queue.snapshot() }) + '\n');
};
const reporting = setInterval(report, 30_000); reporting.unref();
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(reporting);clearInterval(runtimeReporting);
  const hardStop=setTimeout(()=>{consumer.child.kill('SIGKILL');process.exit(process.exitCode??0);},10000);hardStop.unref();
  const closed=new Promise<void>(resolve=>intake.server.close(()=>resolve()));intake.server.closeAllConnections();await closed;
  await consumer.close(delivery=>heartbeat(true,delivery));report();
  if(logWritable)await new Promise<void>(resolve=>{const budget=setTimeout(resolve,250);process.stdout.write(JSON.stringify({event:'collector_stopped',boot_id:bootId,intake:intake.snapshot(),stop:consumer.stopReport()})+'\n',()=>{clearTimeout(budget);resolve();});});
  clearTimeout(hardStop);process.exit(process.exitCode??0);
}
intake.server.on('error', () => { process.stderr.write('{"error":"collector_listen_failed"}\n'); process.exitCode = 1; void stop(); });
intake.server.listen(port, process.env.ADI_COLLECTOR_HOST ?? '127.0.0.1', () => {
  reportRuntime();process.stdout.write(JSON.stringify({ event: 'collector_listening', port, boot_id:bootId }) + '\n');
});
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
