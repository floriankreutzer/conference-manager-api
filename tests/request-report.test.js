import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationInputError } from '../src/authorization/errors.js';
import {
  createRequestReportCursor,
  normalizeRequestReportQuery,
} from '../src/application/request-report.js';
import { fitPublicPage } from '../src/application/public-page.js';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2027-01-01T00:00:00.000Z';
const AS_OF = '2026-08-27T12:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'request-report-test-secret-that-is-at-least-32-bytes';
const OPTIONS = Object.freeze({ tenantId: TENANT, cursorSecret: SECRET, evaluatedAt: AS_OF });

function query(overrides = {}) {
  return {
    from: FROM,
    to: TO,
    limit: undefined,
    cursor: undefined,
    ...overrides,
  };
}

test('Request report query freezes a revision-watermark snapshot and range-bound keyset cursor', () => {
  const first = normalizeRequestReportQuery(query(), OPTIONS);
  assert.deepEqual(first, {
    from: FROM,
    to: TO,
    snapshot: null,
    limit: 10,
    after: { snapshot: null, startsAt: null, requestId: null },
  });
  const cursor = createRequestReportCursor({
    from: FROM,
    to: TO,
    tenantId: TENANT,
    snapshot: { revisionWatermark: 42, asOf: AS_OF },
    startsAt: '2026-06-01T10:00:00.000Z',
    requestId: 'request-2',
  }, { cursorSecret: SECRET });
  const next = normalizeRequestReportQuery(query({ limit: '4', cursor }), OPTIONS);
  assert.deepEqual(next.after, {
    snapshot: { revisionWatermark: 42, asOf: AS_OF },
    startsAt: '2026-06-01T10:00:00.000Z',
    requestId: 'request-2',
  });
  assert.equal(next.limit, 4);
});

test('Request report query rejects non-canonical, excessive, foreign and future cursors', () => {
  const cursor = createRequestReportCursor({
    from: FROM,
    to: TO,
    tenantId: TENANT,
    snapshot: { revisionWatermark: 42, asOf: AS_OF },
    startsAt: '2026-06-01T10:00:00.000Z',
    requestId: 'request-2',
  }, { cursorSecret: SECRET });
  for (const candidate of [
    { value: { ...query(), tenantId: 'foreign' } },
    { value: query({ from: '2026-01-01T01:00:00+01:00' }) },
    { value: query({ to: '2027-01-03T00:00:00.000Z' }) },
    { value: query({ limit: '11' }) },
    { value: query({ cursor: 'not-json' }) },
    { value: query({ from: '2026-02-01T00:00:00.000Z', cursor }) },
  ]) {
    assert.throws(
      () => normalizeRequestReportQuery(candidate.value, OPTIONS),
      AuthorizationInputError,
    );
  }
});

test('public page fitting stops before the byte cap and exposes a continuation', () => {
  const records = [
    { id: 'one', value: 'x'.repeat(600) },
    { id: 'two', value: 'x'.repeat(600) },
    { id: 'three', value: 'x'.repeat(600) },
  ];
  const result = fitPublicPage({
    items: records,
    limit: 2,
    maxResponseBytes: 1_024,
    cursorFor: (record) => record.id,
    resultFor: (items, page) => ({ schemaVersion: 2, items, page }),
    envelopeFor: (page) => page,
  });
  assert.deepEqual(result.items.map((item) => item.id), ['one']);
  assert.deepEqual(result.page, { limit: 2, complete: false, nextCursor: 'one' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_024);
});
