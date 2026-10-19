import type { HookEnvelope } from '@adi/contracts';
import { openDatabase } from '../../src/index.js';
import { connectionString } from '../helpers.js';
const input: { schema: string; envelope: HookEnvelope; receivedAt: string } = JSON.parse(process.argv[2] ?? 'null');
if (!input || !/^test_[a-f0-9]{32}$/.test(input.schema)) throw new Error('Only a generated test schema is allowed');
const db = openDatabase({ connectionString, schema: input.schema });
try { process.stdout.write(JSON.stringify(await db.ingest(input.envelope, { admissionEpoch: 1, receivedAt: new Date(input.receivedAt) }))); }
finally { await db.close(); }
