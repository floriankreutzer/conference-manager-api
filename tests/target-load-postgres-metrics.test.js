import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { instrumentLoadPool } from '../scripts/support/target-load-postgres-metrics.mjs';

function client() {
  const value = new EventEmitter(); value.connection = { stream: { bytesRead: 10, bytesWritten: 20 } };
  value.query = function (...args) { assert.equal(this, value); return args; }; return value;
}

test('PostgreSQL load meter preserves actual driver calls and retains only aggregate bytes after client retirement', () => {
  const pool = new EventEmitter(); const read = instrumentLoadPool(pool); const first = client(); const second = client();
  pool.emit('connect', first); pool.emit('connect', second);
  const parameters = ['private-token']; const query = { text: 'SELECT private', values: parameters };
  assert.deepEqual(first.query(query), [query]); assert.deepEqual(second.query('SELECT 1', parameters), ['SELECT 1', parameters]);
  assert.deepEqual(read(), { queries: 2, bytesRead: 20, bytesWritten: 40 });
  first.connection.stream.bytesRead += 5; first.emit('end');
  assert.deepEqual(read(), { queries: 2, bytesRead: 25, bytesWritten: 40 });
  first.connection.stream.bytesRead = 1_000_000;
  assert.deepEqual(read(), { queries: 2, bytesRead: 25, bytesWritten: 40 });
  assert.equal(JSON.stringify(read()).includes('private'), false);
});

test('invalid and unbounded PostgreSQL counters cannot become successful observation evidence', () => {
  assert.throws(() => instrumentLoadPool({}), /^Error: LOAD_POSTGRES_METRICS_FAILED$/);
  const pool = new EventEmitter(); const read = instrumentLoadPool(pool); const broken = client();
  pool.emit('connect', broken); broken.connection.stream.bytesRead = -1;
  assert.throws(read, /^Error: LOAD_POSTGRES_METRICS_FAILED$/); broken.emit('end');
  assert.throws(read, /^Error: LOAD_POSTGRES_METRICS_FAILED$/);
  const many = new EventEmitter(); const bounded = instrumentLoadPool(many);
  for (let index = 0; index < 65; index += 1) many.emit('connect', client());
  assert.throws(bounded, /^Error: LOAD_POSTGRES_METRICS_FAILED$/);
});
