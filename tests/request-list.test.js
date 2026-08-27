import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationInputError } from '../src/authorization/errors.js';
import {
  createApplicationRequestListCursor,
  normalizeApplicationRequestListQuery,
} from '../src/application/request-list.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const SECRET = 'request-list-test-secret-that-is-at-least-32-bytes';
const SNAPSHOT = Object.freeze({
  revisionWatermark: 42,
  asOf: '2026-08-27T12:00:00.000Z',
});

test('application Request list cursor binds snapshot and Employee ownership scope', () => {
  const cursor = createApplicationRequestListCursor({
    requesterUserId: USER,
    tenantId: TENANT,
    snapshot: SNAPSHOT,
    startsAt: '2026-09-01T10:00:00.000Z',
    requestId: 'request-2',
  }, { cursorSecret: SECRET });
  assert.deepEqual(normalizeApplicationRequestListQuery({ limit: '5', cursor }, {
    requesterUserId: USER,
    tenantId: TENANT,
    cursorSecret: SECRET,
    evaluatedAt: SNAPSHOT.asOf,
  }), {
    limit: 5,
    snapshot: SNAPSHOT,
    afterStartsAt: '2026-09-01T10:00:00.000Z',
    afterRequestId: 'request-2',
  });
  assert.throws(() => normalizeApplicationRequestListQuery({ limit: '5', cursor }, {
    requesterUserId: null,
    tenantId: TENANT,
    cursorSecret: SECRET,
    evaluatedAt: SNAPSHOT.asOf,
  }), AuthorizationInputError);
});

test('application Request list rejects unknown, duplicate-shaped and excessive input', () => {
  for (const query of [
    { limit: undefined, cursor: undefined, tenantId: 'foreign' },
    { limit: '0', cursor: undefined },
    { limit: '11', cursor: undefined },
    { limit: undefined, cursor: 'not-json' },
  ]) {
    assert.throws(() => normalizeApplicationRequestListQuery(query, {
      requesterUserId: USER,
      tenantId: TENANT,
      cursorSecret: SECRET,
      evaluatedAt: SNAPSHOT.asOf,
    }), AuthorizationInputError);
  }
});
