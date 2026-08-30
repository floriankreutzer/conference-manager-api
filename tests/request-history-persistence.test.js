import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

function repository(queries) {
  const pool = {
    async query(query) {
      queries.push(query);
      return { rows: [] };
    },
    async connect() { throw new Error('UNUSED'); },
  };
  return createPostgresRequestRepository(pool, {
    auditRepository: { async appendWithClient() { throw new Error('UNUSED'); } },
    calendarAuthorityGuard: { async lockCurrent() { throw new Error('UNUSED'); } },
  });
}

test('request history persistence enforces the immutable version window and page bound', async () => {
  const queries = [];
  const result = await repository(queries).listHistoryPageByTenantIdAndId(
    TENANT_ID,
    REQUEST_ID,
    { asOfVersion: 7, beforeVersion: 5, limit: 11 },
  );
  assert.deepEqual(result, []);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, 'request-history-page-by-tenant-and-id');
  assert.deepEqual(queries[0].values, [TENANT_ID, REQUEST_ID, 7, 5, 11]);
  assert.match(queries[0].text, /revision\.request_version <= \$3/);
  assert.match(queries[0].text, /revision\.request_version < \$4::bigint/);
  assert.match(queries[0].text, /ORDER BY revision\.request_version DESC/);
});

test('request history persistence rejects malformed or expanded page authority', async () => {
  const value = repository([]);
  for (const options of [
    { asOfVersion: 0, beforeVersion: null, limit: 1 },
    { asOfVersion: 2, beforeVersion: 3, limit: 1 },
    { asOfVersion: 2, beforeVersion: null, limit: 12 },
  ]) {
    await assert.rejects(
      value.listHistoryPageByTenantIdAndId(TENANT_ID, REQUEST_ID, options),
      /REQUEST_HISTORY_PAGE_INVALID/,
    );
  }
});
