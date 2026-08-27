import { ApiError } from '../../api-error.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

export const TENANT_ORGANIZATION_ROUTES = Object.freeze({
  current: '/api/v1/tenant/settings/organization',
  history: '/api/v1/tenant/settings/organization/history',
});

const MUTATION_BODY_MAX_BYTES = 32_768;
const MUTATION_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: (value) => Number.isSafeInteger(value),
    expectedRevision: (value) => Number.isSafeInteger(value),
    organization: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});
const HISTORY_QUERY_KEYS = new Set(['limit', 'beforeRevision']);

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
  if (contentLength !== undefined) {
    if (Array.isArray(contentLength) || !/^\d+$/.test(contentLength) || Number(contentLength) !== 0) {
      throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
    }
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
}

function positiveInteger(value, { min, max }) {
  if (value === null || !/^[1-9]\d*$/.test(value)) throw new ApiError(400, 'VALIDATION_FAILED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  return parsed;
}

function historyPage(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!HISTORY_QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  return Object.freeze({
    limit: parsedUrl.searchParams.has('limit')
      ? positiveInteger(parsedUrl.searchParams.get('limit'), { min: 1, max: 100 })
      : 25,
    beforeRevision: parsedUrl.searchParams.has('beforeRevision')
      ? positiveInteger(parsedUrl.searchParams.get('beforeRevision'), {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      })
      : null,
  });
}

export function tenantOrganizationRouteKey(path) {
  if (path === TENANT_ORGANIZATION_ROUTES.current) return 'tenant_settings_organization';
  if (path === TENANT_ORGANIZATION_ROUTES.history) return 'tenant_settings_organization_history';
  return null;
}

export function createTenantOrganizationHttpHandler({
  service,
  principalGuard,
  tenantGuard,
  maxBodyBytes,
  maxResponseBytes,
} = {}) {
  if (!principalGuard || typeof principalGuard.require !== 'function') {
    throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  }
  if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') {
    throw new TypeError('TENANT_GUARD_REQUIRED');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024) {
    throw new TypeError('MAX_BODY_BYTES_INVALID');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  }
  const mutationMaxBytes = Math.min(maxBodyBytes, MUTATION_BODY_MAX_BYTES);

  return async function handleTenantOrganization({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!tenantOrganizationRouteKey(path)) return null;
    if (!service) throw new ApiError(503, 'TENANT_ORGANIZATION_SERVICE_UNAVAILABLE');

    const mutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    const common = { principal, tenantContext, correlationId: requestId };

    if (path === TENANT_ORGANIZATION_ROUTES.current) {
      assertNoQuery(parsedUrl);
      if (request.method === 'GET') {
        await assertEmptyBody(request);
        sendJson(response, 200, await service.current(common), maxResponseBytes);
        return 200;
      }
      if (request.method === 'PUT') {
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: mutationMaxBytes }),
          MUTATION_SCHEMA,
        );
        sendJson(response, 200, await service.update({ ...common, ...body }), maxResponseBytes);
        return 200;
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }

    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    await assertEmptyBody(request);
    sendJson(response, 200, await service.history({
      ...common,
      ...historyPage(parsedUrl),
    }), maxResponseBytes);
    return 200;
  };
}

export const tenantOrganizationRouteModule = defineRouteModule({
  id: 'tenant-organization',
  routeKey: tenantOrganizationRouteKey,
  createHandler(runtime) {
    return createTenantOrganizationHttpHandler({
      service: runtime?.tenantOrganizationService,
      principalGuard: runtime?.principalGuard,
      tenantGuard: runtime?.tenantGuard,
      maxBodyBytes: runtime?.maxBodyBytes,
      maxResponseBytes: runtime?.maxResponseBytes,
    });
  },
});
