import { AuthorizationInputError } from '../authorization/errors.js';
import { isRequestId } from '../domain/request.js';

const INTEGER = /^[1-9][0-9]?$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const REVISION_KEYS = Object.freeze([
  'organization',
  'locations',
  'catalogue',
  'bookingPolicies',
  'costAllocation',
]);

export const APPLICATION_CATALOG_SECTIONS = Object.freeze([
  'sites',
  'rooms',
  'services',
  'cateringPackages',
  'cateringItems',
  'costCenters',
]);
export const APPLICATION_CATALOG_DEFAULT_LIMIT = 10;
export const APPLICATION_CATALOG_MAX_LIMIT = 10;

function invalid(code = 'APPLICATION_CATALOG_QUERY_INVALID') {
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

function normalizeRevisions(value) {
  const revisions = exactObject(value, REVISION_KEYS, 'APPLICATION_CATALOG_CURSOR_INVALID');
  for (const key of REVISION_KEYS) {
    if (!Number.isSafeInteger(revisions[key]) || revisions[key] < 1) {
      invalid('APPLICATION_CATALOG_CURSOR_INVALID');
    }
  }
  return Object.freeze(Object.fromEntries(REVISION_KEYS.map((key) => [key, revisions[key]])));
}

function limit(value) {
  if (value === undefined) return APPLICATION_CATALOG_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !INTEGER.test(value)) invalid();
  const parsed = Number(value);
  if (parsed < 1 || parsed > APPLICATION_CATALOG_MAX_LIMIT) invalid();
  return parsed;
}

function decodeCursor(value, section) {
  if (value === undefined) return Object.freeze({
    afterId: null,
    expectedRevisions: null,
    expectedPolicyVersionId: null,
  });
  if (typeof value !== 'string' || !CURSOR.test(value)) {
    invalid('APPLICATION_CATALOG_CURSOR_INVALID');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalid('APPLICATION_CATALOG_CURSOR_INVALID');
  }
  const cursor = exactObject(
    decoded,
    ['version', 'section', 'revisions', 'policyVersionId', 'afterId'],
    'APPLICATION_CATALOG_CURSOR_INVALID',
  );
  if (
    cursor.version !== 1
    || cursor.section !== section
    || !isRequestId(cursor.policyVersionId)
    || !isRequestId(cursor.afterId)
  ) invalid('APPLICATION_CATALOG_CURSOR_INVALID');
  return Object.freeze({
    afterId: cursor.afterId,
    expectedRevisions: normalizeRevisions(cursor.revisions),
    expectedPolicyVersionId: cursor.policyVersionId,
  });
}

function decodeContext(value) {
  if (typeof value !== 'string' || !CURSOR.test(value)) {
    invalid('APPLICATION_CATALOG_CONTEXT_INVALID');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalid('APPLICATION_CATALOG_CONTEXT_INVALID');
  }
  const context = exactObject(
    decoded,
    ['version', 'revisions', 'policyVersionId'],
    'APPLICATION_CATALOG_CONTEXT_INVALID',
  );
  if (context.version !== 1 || !isRequestId(context.policyVersionId)) {
    invalid('APPLICATION_CATALOG_CONTEXT_INVALID');
  }
  return Object.freeze({
    afterId: null,
    expectedRevisions: normalizeRevisions(context.revisions),
    expectedPolicyVersionId: context.policyVersionId,
  });
}

export function normalizeApplicationCatalogQuery(value) {
  const query = exactObject(value, ['section', 'limit', 'cursor', 'context']);
  if (!APPLICATION_CATALOG_SECTIONS.includes(query.section)) invalid();
  if (query.cursor !== undefined && query.context !== undefined) invalid();
  if (query.cursor === undefined && query.context === undefined && query.section !== 'sites') {
    invalid('APPLICATION_CATALOG_CONTEXT_REQUIRED');
  }
  return Object.freeze({
    section: query.section,
    limit: limit(query.limit),
    ...(query.cursor !== undefined
      ? decodeCursor(query.cursor, query.section)
      : query.context !== undefined
        ? decodeContext(query.context)
        : { afterId: null, expectedRevisions: null, expectedPolicyVersionId: null }),
  });
}

export function createApplicationCatalogContext({ revisions, policyVersionId }) {
  if (!isRequestId(policyVersionId)) invalid('APPLICATION_CATALOG_CONTEXT_INVALID');
  return Buffer.from(JSON.stringify({
    version: 1,
    revisions: normalizeRevisions(revisions),
    policyVersionId,
  }), 'utf8').toString('base64url');
}

export function createApplicationCatalogCursor({
  section,
  revisions,
  policyVersionId,
  afterId,
}) {
  if (
    !APPLICATION_CATALOG_SECTIONS.includes(section)
    || !isRequestId(policyVersionId)
    || !isRequestId(afterId)
  ) invalid('APPLICATION_CATALOG_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({
    version: 1,
    section,
    revisions: normalizeRevisions(revisions),
    policyVersionId,
    afterId,
  }), 'utf8').toString('base64url');
}

export function applicationCatalogContextMatches(actual, expected) {
  if (expected.expectedRevisions === null) return true;
  return REVISION_KEYS.every((key) => (
    actual.configurationRevisions[key] === expected.expectedRevisions[key]
  )) && actual.bookingPolicy.policyVersionId === expected.expectedPolicyVersionId;
}
