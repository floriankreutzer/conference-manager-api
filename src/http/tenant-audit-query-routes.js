import { ApiError } from '../api-error.js';
import { defineRouteModule } from './route-module.js';

const AUDIT_PATH = '/api/v1/audit';
const QUERY_KEYS = new Set([
  'limit',
  'beforeId',
  'category',
  'outcome',
  'actorUserId',
  'from',
  'to',
]);

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

async function assertEmptyBody(request) {
  const contentLength = request.headers['content-length'];
  if (
    contentLength !== undefined
    && (
      Array.isArray(contentLength)
      || !/^\d+$/.test(contentLength)
      || Number(contentLength) !== 0
    )
  ) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

function pageFromUrl(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  const limitValue = parsedUrl.searchParams.get('limit');
  if (limitValue !== null && !/^\d{1,3}$/.test(limitValue)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  return Object.freeze({
    limit: limitValue === null ? undefined : Number(limitValue),
    beforeId: parsedUrl.searchParams.get('beforeId'),
    category: parsedUrl.searchParams.get('category'),
    outcome: parsedUrl.searchParams.get('outcome'),
    actorUserId: parsedUrl.searchParams.get('actorUserId'),
    from: parsedUrl.searchParams.get('from'),
    to: parsedUrl.searchParams.get('to'),
  });
}

export function tenantAuditQueryRouteKey(path) {
  return path === AUDIT_PATH ? 'tenant_audit_query' : null;
}

export function createTenantAuditQueryHttpHandler({
  tenantAuditQueryService,
  principalGuard,
  tenantGuard,
  maxResponseBytes,
} = {}) {
  if (!principalGuard || typeof principalGuard.require !== 'function') {
    throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  }
  if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') {
    throw new TypeError('TENANT_GUARD_REQUIRED');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  }

  return async function handleTenantAuditQuery({ request, response, parsedUrl, path, requestId }) {
    if (!tenantAuditQueryRouteKey(path)) return null;
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    await assertEmptyBody(request);
    if (!tenantAuditQueryService) throw new ApiError(503, 'AUDIT_SERVICE_UNAVAILABLE');
    const principal = await principalGuard.require(request);
    const tenantContext = await tenantGuard.requireKnown(principal);
    const page = await tenantAuditQueryService.listEvents({
      principal,
      tenantContext,
      correlationId: requestId,
      ...pageFromUrl(parsedUrl),
    });
    sendJson(response, 200, { ...page, requestId }, maxResponseBytes);
    return 200;
  };
}

export const tenantAuditQueryRouteModule = defineRouteModule({
  id: 'tenant-audit-query',
  routeKey: tenantAuditQueryRouteKey,
  createHandler: createTenantAuditQueryHttpHandler,
});
