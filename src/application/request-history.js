import { AuthorizationInputError } from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './opaque-cursor.js';

const INTEGER = /^[1-9][0-9]?$/;
const CURSOR_PURPOSE = 'request-history-v3';
const CURSOR_TTL_MILLISECONDS = 30 * 60 * 1_000;

export const REQUEST_HISTORY_DEFAULT_LIMIT = 10;
export const REQUEST_HISTORY_MAX_LIMIT = 10;

function invalid(code = 'REQUEST_HISTORY_QUERY_INVALID') {
  throw new AuthorizationInputError(code);
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) invalid();
  return value;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
}

function pageLimit(value) {
  if (value === undefined) return REQUEST_HISTORY_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !INTEGER.test(value)) invalid();
  const parsed = Number(value);
  if (parsed < 1 || parsed > REQUEST_HISTORY_MAX_LIMIT) invalid();
  return parsed;
}

function utcInstant(value) {
  if (typeof value !== 'string') invalid('REQUEST_HISTORY_CURSOR_INVALID');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid('REQUEST_HISTORY_CURSOR_INVALID');
  }
  return value;
}

function decodeCursor(value, { requestId, tenantId, cursorSecret, evaluatedAt }) {
  if (value === undefined) return Object.freeze({ asOfVersion: null, beforeVersion: null });
  let decoded;
  try {
    decoded = decodeOpaqueCursor(value, { secret: cursorSecret, purpose: CURSOR_PURPOSE });
  } catch {
    invalid('REQUEST_HISTORY_CURSOR_INVALID');
  }
  const cursor = exactObject(decoded, [
    'version', 'tenantId', 'requestId', 'asOfVersion', 'beforeVersion', 'expiresAt',
  ]);
  if (
    cursor.version !== 3
    || cursor.tenantId !== tenantId
    || cursor.requestId !== requestId
    || !positiveVersion(cursor.asOfVersion)
    || !positiveVersion(cursor.beforeVersion)
    || cursor.beforeVersion > cursor.asOfVersion
  ) invalid('REQUEST_HISTORY_CURSOR_INVALID');
  if (Date.parse(utcInstant(cursor.expiresAt)) < Date.parse(evaluatedAt)) {
    invalid('REQUEST_HISTORY_CURSOR_INVALID');
  }
  return Object.freeze({
    asOfVersion: cursor.asOfVersion,
    beforeVersion: cursor.beforeVersion,
  });
}

export function normalizeRequestHistoryQuery(value, {
  requestId,
  tenantId,
  cursorSecret,
  evaluatedAt,
} = {}) {
  if (!isRequestId(requestId) || !isInternalUuid(tenantId)) invalid();
  const normalizedEvaluatedAt = utcInstant(evaluatedAt);
  const query = exactObject(value, ['limit', 'cursor']);
  return Object.freeze({
    limit: pageLimit(query.limit),
    ...decodeCursor(query.cursor, {
      requestId, tenantId, cursorSecret, evaluatedAt: normalizedEvaluatedAt,
    }),
  });
}

export function createRequestHistoryCursor({
  requestId,
  tenantId,
  asOfVersion,
  beforeVersion,
  evaluatedAt,
}, { cursorSecret } = {}) {
  if (
    !isRequestId(requestId)
    || !isInternalUuid(tenantId)
    || !positiveVersion(asOfVersion)
    || !positiveVersion(beforeVersion)
    || beforeVersion > asOfVersion
  ) invalid('REQUEST_HISTORY_CURSOR_INVALID');
  const issuedAt = utcInstant(evaluatedAt);
  return encodeOpaqueCursor({
    version: 3,
    tenantId,
    requestId,
    asOfVersion,
    beforeVersion,
    expiresAt: new Date(Date.parse(issuedAt) + CURSOR_TTL_MILLISECONDS).toISOString(),
  }, { secret: cursorSecret, purpose: CURSOR_PURPOSE });
}
