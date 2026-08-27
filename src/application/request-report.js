import { AuthorizationInputError } from '../authorization/errors.js';
import { isRequestId } from '../domain/request.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './opaque-cursor.js';

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTEGER = /^[1-9][0-9]?$/;
const MAX_RANGE_MILLISECONDS = 366 * 24 * 60 * 60 * 1_000;
const CURSOR_PURPOSE = 'request-report-v2';
const CURSOR_TTL_MILLISECONDS = 30 * 60 * 1_000;

export const REQUEST_REPORT_DEFAULT_LIMIT = 10;
export const REQUEST_REPORT_MAX_LIMIT = 10;

function invalid(code = 'REQUEST_REPORT_QUERY_INVALID') {
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

function utcInstant(value) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

function reportLimit(value) {
  if (value === undefined) return REQUEST_REPORT_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !INTEGER.test(value)) invalid();
  const limit = Number(value);
  if (limit < 1 || limit > REQUEST_REPORT_MAX_LIMIT) invalid();
  return limit;
}

function decodeCursor(value, from, to, tenantId, cursorSecret, evaluatedAt) {
  if (value === undefined) return Object.freeze({
    snapshot: null,
    startsAt: null,
    requestId: null,
  });
  let decoded;
  try {
    decoded = decodeOpaqueCursor(value, { secret: cursorSecret, purpose: CURSOR_PURPOSE });
  } catch {
    invalid('REQUEST_REPORT_CURSOR_INVALID');
  }
  const cursor = exactObject(
    decoded,
    [
      'version', 'tenantId', 'from', 'to', 'revisionWatermark', 'asOf', 'expiresAt',
      'startsAt', 'requestId',
    ],
  );
  if (
    cursor.version !== 4
    || cursor.tenantId !== tenantId
    || utcInstant(cursor.from) !== from
    || utcInstant(cursor.to) !== to
    || !Number.isSafeInteger(cursor.revisionWatermark)
    || cursor.revisionWatermark < 0
    || !isRequestId(cursor.requestId)
  ) invalid('REQUEST_REPORT_CURSOR_INVALID');
  const asOf = utcInstant(cursor.asOf);
  const expiresAt = utcInstant(cursor.expiresAt);
  if (Date.parse(expiresAt) < Date.parse(evaluatedAt)) invalid('REQUEST_REPORT_CURSOR_INVALID');
  const startsAt = utcInstant(cursor.startsAt);
  if (startsAt < from || startsAt >= to) invalid('REQUEST_REPORT_CURSOR_INVALID');
  return Object.freeze({
    snapshot: Object.freeze({ revisionWatermark: cursor.revisionWatermark, asOf }),
    startsAt,
    requestId: cursor.requestId,
  });
}

export function normalizeRequestReportQuery(value, { tenantId, cursorSecret, evaluatedAt } = {}) {
  if (!isInternalUuid(tenantId)) invalid();
  const normalizedEvaluatedAt = utcInstant(evaluatedAt);
  const query = exactObject(value, ['from', 'to', 'limit', 'cursor']);
  const from = utcInstant(query.from);
  const to = utcInstant(query.to);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > MAX_RANGE_MILLISECONDS) invalid('REQUEST_REPORT_RANGE_INVALID');
  const limit = reportLimit(query.limit);
  const after = decodeCursor(query.cursor, from, to, tenantId, cursorSecret, normalizedEvaluatedAt);
  return Object.freeze({ from, to, snapshot: after.snapshot, limit, after });
}

export function createRequestReportCursor({
  tenantId,
  from,
  to,
  snapshot,
  startsAt,
  requestId,
}, { cursorSecret } = {}) {
  if (!isInternalUuid(tenantId)) invalid('REQUEST_REPORT_CURSOR_INVALID');
  const normalizedFrom = utcInstant(from);
  const normalizedTo = utcInstant(to);
  if (
    !snapshot
    || !Number.isSafeInteger(snapshot.revisionWatermark)
    || snapshot.revisionWatermark < 0
  ) invalid('REQUEST_REPORT_CURSOR_INVALID');
  const normalizedAsOf = utcInstant(snapshot.asOf);
  const normalizedStartsAt = utcInstant(startsAt);
  if (
    Date.parse(normalizedTo) <= Date.parse(normalizedFrom)
    || normalizedStartsAt < normalizedFrom
    || normalizedStartsAt >= normalizedTo
    || !isRequestId(requestId)
  ) invalid('REQUEST_REPORT_CURSOR_INVALID');
  return encodeOpaqueCursor({
    version: 4,
    tenantId,
    from: normalizedFrom,
    to: normalizedTo,
    revisionWatermark: snapshot.revisionWatermark,
    asOf: normalizedAsOf,
    expiresAt: new Date(Date.parse(normalizedAsOf) + CURSOR_TTL_MILLISECONDS).toISOString(),
    startsAt: normalizedStartsAt,
    requestId,
  }, { secret: cursorSecret, purpose: CURSOR_PURPOSE });
}
