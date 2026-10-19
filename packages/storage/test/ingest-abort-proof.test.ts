import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseError as PostgresError } from 'pg';
import { DatabaseIoTimeout, ingestFailureProof } from '../src/index.js';

const abortCodes = ['55P03', '57014', '40001', '40P01'];

test('ingest failure proof cannot be forged by public values or error fields', () => {
  for (const value of [undefined, null, false, 0, 'server_abort', 'deadline_rollback', {}, new Error('unmarked')]) {
    assert.equal(ingestFailureProof(value), null);
  }
  for (const code of abortCodes) {
    const fields = { code, safe: true, retryable: true, rollbackConfirmed: true, phase: 'before_commit', proof: 'server_abort', ingestFailureProof: 'server_abort' };
    const forged = Object.assign(new Error('forged private proof'), fields);
    for (const value of [fields, forged, { ...forged }, JSON.parse(JSON.stringify(forged))]) {
      assert.equal(ingestFailureProof(value), null);
    }
  }
});

test('new PostgreSQL errors and public timeout causes do not inherit private ingest proof', () => {
  assert.equal(ingestFailureProof(new DatabaseIoTimeout()), null);
  for (const code of abortCodes) {
    const postgres = Object.assign(new PostgresError('synthetic native-shaped error', 0, 'error'), { code });
    const wrapped = new DatabaseIoTimeout(postgres);
    assert.equal(ingestFailureProof(postgres), null);
    assert.equal(ingestFailureProof(wrapped), null);
    assert.equal(ingestFailureProof(new Error('outer error', { cause: wrapped })), null);
    assert.equal(ingestFailureProof({ cause: postgres, proof: 'server_abort' }), null);
    assert.equal(ingestFailureProof(Object.assign(Object.create(PostgresError.prototype), { code })), null);
  }
});
