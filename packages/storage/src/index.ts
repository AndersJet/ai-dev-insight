import { Pool, DatabaseError as PostgresError, type QueryResult, type QueryResultRow } from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';
import { migrateDatabase } from './migrate.js';
import { persistEnvelope, type IngestOptions, type IngestResult } from './ingest.js';
import { jsonBudgetFailure, type HookEnvelope } from '@adi/contracts';

export interface DatabaseOptions { connectionString: string; schema: string; maxConnections?: number }
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}
export type Transaction = Queryable;
export class DatabaseIoTimeout extends Error {
  readonly code = 'database_io_timeout';
  constructor(cause?: Error) { super('Database I/O deadline exceeded', cause ? { cause } : undefined); this.name = 'DatabaseIoTimeout'; }
}
export class DatabaseUnavailable extends Error {
  readonly code = 'database_unavailable';
  constructor() { super('Database connection unavailable'); this.name = 'DatabaseUnavailable'; }
}

// Only errors issued by the private ingest transaction may carry this proof.
// Neither SQLSTATE-shaped input nor a public callback can manufacture it.
const ingestFailureProofs = new WeakMap<Error, 'server_abort' | 'deadline_rollback'>();
export function ingestFailureProof(error: unknown): 'server_abort' | 'deadline_rollback' | null {
  return error instanceof Error ? ingestFailureProofs.get(error) ?? null : null;
}

export function openDatabase(options: DatabaseOptions) {
  // Only trusted startup configuration selects the schema, never HTTP input.
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema) || ['public', 'pg_catalog', 'information_schema'].includes(options.schema) || options.schema.startsWith('pg_')) throw new Error('A dedicated, valid application schema is required');
  const schema = options.schema;
  // pg reparses connectionString after explicit options and lets URL parameters
  // override them. Parse once, remove nested strings, then pin application limits.
  let connection: ReturnType<typeof parseIntoClientConfig>;
  try { connection = parseIntoClientConfig(options.connectionString); }
  catch { throw Object.assign(new Error('Invalid database URL'), { code: 'invalid_database_url' }); }
  delete connection.connectionString;
  const pool = new Pool({ ...connection, max: options.maxConnections ?? 6, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000, statement_timeout: 5000, query_timeout: 6000, idle_in_transaction_session_timeout: 15_000, options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c datestyle=ISO,MDY` });
  let connectionFaults = 0; let readTimeouts = 0;
  pool.on('error', () => { connectionFaults++; });
  function failure(error: unknown) {
    if (error instanceof Error && (error.message === 'Query read timeout' || ('code' in error && error.code === '57014'))) { readTimeouts++; return new DatabaseIoTimeout(error); }
    if (error instanceof Error && ((('code' in error) && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(String(error.code))) || ['Connection terminated unexpectedly', 'Connection terminated', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect', 'Client has encountered a connection error and is not queryable'].includes(error.message))) return new DatabaseUnavailable();
    return error instanceof Error ? error : new Error('Database query failed');
  }
  async function query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    // pg-pool releases an errored query with release(error), which discards the
    // connection. An uncertain reply must not be consumed by the next caller.
    try { return await pool.query<Row>(text, values); } catch (error) { throw failure(error); }
  }

  async function executeTransaction<T>(action: (client: Transaction) => Promise<T>, ingestProof = false, retryDeadlineAt?: number): Promise<T> {
    const client = await pool.connect().catch(error => { throw failure(error); });
    let broken: Error | undefined; let released = false; let closed = false; let poisoned: Error | undefined;
    let commitSent = false, transportFailed = false; let confirmedAbort: Error | undefined, deadlineAbort: Error | undefined;
    const discard = (error: Error) => { poisoned ??= error; if (!released) { released = true; client.release(error); } };
    // Checked-out clients have no pg-pool idle error handler. Retain our handler
    // throughout the callback so an idle network disconnect cannot crash Node.
    const onError = () => { connectionFaults++; transportFailed = true; discard(new DatabaseUnavailable()); };
    client.on('error', onError);
    const scoped: Transaction = {
      async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        if (poisoned) throw poisoned;
        if (closed || released) throw Object.assign(new Error('Transaction is closed'), { code: 'transaction_closed' });
        try { return await client.query<Row>(text, values); }
        catch (error) {
          const provesAbort = ingestProof && !commitSent && !poisoned && !transportFailed && error instanceof PostgresError && ['55P03', '57014', '40001', '40P01'].includes(error.code ?? '');
          const normalized = poisoned ?? failure(error); poisoned = normalized;
          if (provesAbort) confirmedAbort = normalized;
          if (normalized instanceof DatabaseIoTimeout || normalized instanceof DatabaseUnavailable) {
            // The protocol stream may still contain a late reply. Destroy it
            // immediately, and forbid COMMIT even if application code catches.
            discard(normalized);
          }
          throw normalized;
        }
      },
    };
    try {
      await scoped.query('BEGIN');
      await scoped.query("SET LOCAL lock_timeout = '1s'");
      if (retryDeadlineAt !== undefined) {
        // Checkout time consumes the original delivery budget. SET LOCAL only
        // tightens the server's existing five-second limit for this retry.
        const remaining = Math.floor(retryDeadlineAt - Date.now() - 50);
        if (remaining < 1) { deadlineAbort = new DatabaseIoTimeout(); throw deadlineAbort; }
        await scoped.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.min(5000, remaining))]);
      }
      const result = await action(scoped);
      if (poisoned) throw poisoned;
      if (retryDeadlineAt !== undefined && Date.now() >= retryDeadlineAt) { deadlineAbort = new DatabaseIoTimeout(); throw deadlineAbort; }
      // Public callbacks may send their own COMMIT; they never receive proof.
      // The private persistEnvelope callback cannot, so this is its commit boundary.
      commitSent = true;
      await scoped.query('COMMIT');
      return result;
    } catch (error) {
      let rolledBack = false;
      if (!released) { try { await client.query('ROLLBACK'); rolledBack = true; } catch { broken = new Error('Rollback failed; discard connection'); transportFailed = true; } }
      if (ingestProof && !commitSent && !transportFailed && error instanceof Error) {
        if (confirmedAbort === error) ingestFailureProofs.set(error, 'server_abort');
        // Budget cancellation is reject-only, and requires the private error
        // identity plus a confirmed rollback. It can never authorize replay.
        else if (deadlineAbort === error && rolledBack) ingestFailureProofs.set(error, 'deadline_rollback');
      }
      throw error;
    } finally { closed = true; client.removeListener('error', onError); if (!released) client.release(broken); }
  }

  function transaction<T>(action: (client: Transaction) => Promise<T>): Promise<T> { return executeTransaction(action); }

  const migrate = () => migrateDatabase(connection, schema);
  async function ensurePartitions(from: Date, to: Date) {
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Valid partition range required');
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const count = (to.getUTCFullYear() - start.getUTCFullYear()) * 12 + to.getUTCMonth() - start.getUTCMonth() + (to.getUTCDate() > 1 || to.getUTCHours() > 0 || to.getUTCMinutes() > 0 || to.getUTCSeconds() > 0 || to.getUTCMilliseconds() > 0 ? 1 : 0);
    if (count > 24) throw new Error('Partition creation range exceeds 24 months');
    await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`adi:partitions:${schema}`]);
      for (let month = 0; month < count; month++) {
        const begin = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month, 1));
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month + 1, 1));
        const suffix = begin.toISOString().slice(0, 7).replace('-', '');
        await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"."hook_events_${suffix}" PARTITION OF hook_events FOR VALUES FROM ('${begin.toISOString()}') TO ('${end.toISOString()}')`);
        await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"."session_fragments_${suffix}" PARTITION OF session_fragments FOR VALUES FROM ('${begin.toISOString()}') TO ('${end.toISOString()}')`);
      }
    });
  }
  async function ingestJson(encodedEnvelope: string, options: IngestOptions, retryDeadlineAt?: number): Promise<IngestResult> {
    if (retryDeadlineAt !== undefined && !Number.isSafeInteger(retryDeadlineAt)) throw new Error('Invalid ingest retry deadline');
    if (jsonBudgetFailure(encodedEnvelope)) return { outcome: 'rejected', reason: 'json_budget_exceeded' };
    let envelope: unknown;
    try { envelope = JSON.parse(encodedEnvelope); } catch { return { outcome: 'rejected', reason: 'invalid_json' }; }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { outcome: 'rejected', reason: 'invalid_json' };
    return executeTransaction(client => persistEnvelope(client, envelope as HookEnvelope, options, encodedEnvelope), true, retryDeadlineAt);
  }
  return {
    schema, migrate, transaction, ensurePartitions,
    assertNotRecovering: async () => {
      const row = (await query<{ recovery_id: string | null }>('SELECT recovery_id FROM data_identity')).rows[0];
      if (!row || row.recovery_id) throw Object.assign(new Error('Database is quarantined for recovery'), { code: 'recovery_quarantined' });
    },
    ingest: (envelope: HookEnvelope, options: IngestOptions) => ingestJson(JSON.stringify(envelope), options),
    ingestJson,
    query,
    health: () => ({ connectionFaults, readTimeouts, waiting: pool.waitingCount, total: pool.totalCount, idle: pool.idleCount }),
    close: () => pool.end(),
  };
}
export type Database = ReturnType<typeof openDatabase>;
export type { IngestOptions, IngestResult } from './ingest.js';

export {createRuntimeReporter,recordRuntimeHeartbeat,type RuntimeHeartbeat,type RuntimeComponent} from './runtime-heartbeat.js';

export {createCleanupJournal,type CleanupJournal,type CleanupRecord,type CleanupCheckpointRef} from './cleanup-journal.js';
export type {ProjectBarrier,ProjectBarrierManifest} from './cleanup-journal.js';

export {prepareRecoveryArtifact,readRecoveryArtifact,writeRecoveryArtifact} from './recovery-artifact.js';
export {createPluginObservationStore} from './plugin-observations.js';
export {writePostgresDump,verifyPostgresBackup,type DumpCommand} from './postgres-dump.js';

export type {ProjectDeletedKey} from './cleanup-journal.js';
