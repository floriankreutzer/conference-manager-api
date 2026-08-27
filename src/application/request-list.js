import { AuthorizationInputError } from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './opaque-cursor.js';

const INTEGER = /^[1-9][0-9]?$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_PURPOSE = 'application-request-list-v2';
const CURSOR_TTL_MILLISECONDS = 30 * 60 * 1_000;

export const APPLICATION_REQUEST_LIST_DEFAULT_LIMIT = 10;
export const APPLICATION_REQUEST_LIST_MAX_LIMIT = 10;

function invalid(code = 'APPLICATION_REQUEST_LIST_QUERY_INVALID') {
  throw new AuthorizationInputError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) invalid(code);
  return value;
}

function utcInstant(value) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

function pageLimit(value) {
  if (value === undefined) return APPLICATION_REQUEST_LIST_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !INTEGER.test(value)) invalid();
  const result = Number(value);
  if (result < 1 || result > APPLICATION_REQUEST_LIST_MAX_LIMIT) invalid();
  return result;
}

function validScope(value) {
  return value === null || isInternalUuid(value);
}

function decodeCursor(value, tenantId, requesterUserId, cursorSecret, evaluatedAt) {
  if (value === undefined) return Object.freeze({
    snapshot: null,
    afterStartsAt: null,
    afterRequestId: null,
  });
  let decoded;
  try {
    decoded = decodeOpaqueCursor(value, {
      secret: cursorSecret,
      purpose: CURSOR_PURPOSE,
    });
  } catch {
    invalid('APPLICATION_REQUEST_LIST_CURSOR_INVALID');
  }
  const cursor = exactObject(
    decoded,
    [
      'version', 'tenantId', 'requesterUserId', 'revisionWatermark', 'asOf', 'expiresAt', 'startsAt',
      'requestId',
    ],
    'APPLICATION_REQUEST_LIST_CURSOR_INVALID',
  );
  if (
    cursor.version !== 2
    || cursor.tenantId !== tenantId
    || !validScope(cursor.requesterUserId)
    || cursor.requesterUserId !== requesterUserId
    || !Number.isSafeInteger(cursor.revisionWatermark)
    || cursor.revisionWatermark < 0
    || !isRequestId(cursor.requestId)
  ) invalid('APPLICATION_REQUEST_LIST_CURSOR_INVALID');
  const expiresAt = utcInstant(cursor.expiresAt);
  if (Date.parse(expiresAt) < Date.parse(evaluatedAt)) {
    invalid('APPLICATION_REQUEST_LIST_CURSOR_INVALID');
  }
  return Object.freeze({
    snapshot: Object.freeze({
      revisionWatermark: cursor.revisionWatermark,
      asOf: utcInstant(cursor.asOf),
    }),
    afterStartsAt: utcInstant(cursor.startsAt),
    afterRequestId: cursor.requestId,
  });
}

export function normalizeApplicationRequestListQuery(value, {
  requesterUserId,
  tenantId,
  cursorSecret,
  evaluatedAt,
} = {}) {
  if (!isInternalUuid(tenantId) || !validScope(requesterUserId)) invalid();
  const normalizedEvaluatedAt = utcInstant(evaluatedAt);
  const query = exactObject(value, ['limit', 'cursor']);
  return Object.freeze({
    limit: pageLimit(query.limit),
    ...decodeCursor(query.cursor, tenantId, requesterUserId, cursorSecret, normalizedEvaluatedAt),
  });
}

export function createApplicationRequestListCursor({
  requesterUserId,
  tenantId,
  snapshot,
  startsAt,
  requestId,
}, { cursorSecret } = {}) {
  if (
    !validScope(requesterUserId)
    || !isInternalUuid(tenantId)
    || !snapshot
    || !Number.isSafeInteger(snapshot.revisionWatermark)
    || snapshot.revisionWatermark < 0
    || !isRequestId(requestId)
  ) invalid('APPLICATION_REQUEST_LIST_CURSOR_INVALID');
  const asOf = utcInstant(snapshot.asOf);
  return encodeOpaqueCursor({
    version: 2,
    tenantId,
    requesterUserId,
    revisionWatermark: snapshot.revisionWatermark,
    asOf,
    expiresAt: new Date(Date.parse(asOf) + CURSOR_TTL_MILLISECONDS).toISOString(),
    startsAt: utcInstant(startsAt),
    requestId,
  }, { secret: cursorSecret, purpose: CURSOR_PURPOSE });
}
