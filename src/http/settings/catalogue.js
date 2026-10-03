import { ApiError } from '../../api-error.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

export const TENANT_CATALOGUE_ROUTES = Object.freeze({
  current: '/api/v1/tenant/settings/catalogue',
  history: '/api/v1/tenant/settings/catalogue/history',
});
const BULK_PATH = new RegExp(
  '^/api/v1/tenant/settings/catalogue/bulk/(services|equipment|catering-items|catering-packages)/(template|export|validate|apply)$',
);
const BULK_MAX_BYTES = 65_536;

const MUTATION_BODY_MAX_BYTES = 262_144;
const MUTATION_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: (value) => Number.isSafeInteger(value),
    expectedRevision: (value) => Number.isSafeInteger(value),
    catalogue: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});
const HISTORY_QUERY_KEYS = new Set(['limit', 'beforeRevision']);
const BULK_VALIDATE_SCHEMA = Object.freeze({
  required: Object.freeze({ document: (value) => value && typeof value === 'object' && !Array.isArray(value) }),
  optional: Object.freeze({}),
});
const BULK_APPLY_SCHEMA = Object.freeze({
  required: Object.freeze({
    receiptId: (value) => typeof value === 'string',
    document: (value) => value && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});

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

export function tenantCatalogueRouteKey(path) {
  const bulk = path.match(BULK_PATH);
  if (bulk) return `tenant_settings_catalogue_bulk_${bulk[2]}`;
  if (path === TENANT_CATALOGUE_ROUTES.current) return 'tenant_settings_catalogue';
  if (path === TENANT_CATALOGUE_ROUTES.history) return 'tenant_settings_catalogue_history';
  return null;
}

export function createTenantCatalogueHttpHandler({
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

  return async function handleTenantCatalogue({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!tenantCatalogueRouteKey(path)) return null;
    if (!service) throw new ApiError(503, 'TENANT_CATALOGUE_SERVICE_UNAVAILABLE');

    const mutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    const common = { principal, tenantContext, correlationId: requestId };

    const bulkMatch = path.match(BULK_PATH);
    if (bulkMatch) {
      assertNoQuery(parsedUrl);
      const [, type, operation] = bulkMatch;
      if (operation === 'template' || operation === 'export') {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        await assertEmptyBody(request);
        const result = operation === 'template'
          ? await service.bulkTemplate({ ...common, type })
          : await service.bulkExport({ ...common, type });
        sendJson(response, 200, result, maxResponseBytes);
        return 200;
      }
      if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      const body = validateExactObject(
        await readJsonObjectBody(request, { maxBytes: Math.min(mutationMaxBytes, BULK_MAX_BYTES) }),
        operation === 'validate' ? BULK_VALIDATE_SCHEMA : BULK_APPLY_SCHEMA,
      );
      const result = operation === 'validate'
        ? await service.bulkValidate({ ...common, type, ...body })
        : await service.bulkApply({ ...common, type, ...body });
      sendJson(response, 200, result, maxResponseBytes);
      return 200;
    }

    if (path === TENANT_CATALOGUE_ROUTES.current) {
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

export const tenantCatalogueRouteModule = defineRouteModule({
  id: 'tenant-catalogue',
  routeKey: tenantCatalogueRouteKey,
  createHandler(runtime) {
    return createTenantCatalogueHttpHandler({
      service: runtime?.tenantCatalogueService,
      principalGuard: runtime?.principalGuard,
      tenantGuard: runtime?.tenantGuard,
      maxBodyBytes: runtime?.maxBodyBytes,
      maxResponseBytes: runtime?.maxResponseBytes,
    });
  },
});
