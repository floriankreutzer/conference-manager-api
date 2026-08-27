import { ApiError } from '../../api-error.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

export const TENANT_COST_ALLOCATION_ROUTES = Object.freeze({
  current: '/api/v1/tenant/settings/cost-allocation',
  history: '/api/v1/tenant/settings/cost-allocation/history',
});

const REVISION_PATH =
  /^\/api\/v1\/tenant\/settings\/cost-allocation\/history\/(\d{1,15})$/;
const BULK_PATH = /^\/api\/v1\/tenant\/settings\/cost-allocation\/bulk\/(cost-centers)\/(template|export|validate|apply)$/;
const BULK_MAX_BYTES = 65_536;
const UPDATE_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: (value) => Number.isSafeInteger(value),
    expectedRevision: (value) => Number.isSafeInteger(value),
    configuration: (value) => (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
    ),
  }),
  optional: Object.freeze({}),
});
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
  if (Buffer.byteLength(body) > maxResponseBytes) {
    throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function assertNoUnexpectedQuery(parsedUrl, allowed = new Set()) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (
      !allowed.has(key)
      || parsedUrl.searchParams.getAll(key).length !== 1
    ) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
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

export function tenantCostAllocationRouteKey(path) {
  const bulk = path.match(BULK_PATH);
  if (bulk) return `tenant_settings_cost_allocation_bulk_${bulk[2]}`;
  if (path === TENANT_COST_ALLOCATION_ROUTES.current) {
    return 'tenant_settings_cost_allocation';
  }
  if (path === TENANT_COST_ALLOCATION_ROUTES.history) {
    return 'tenant_settings_cost_allocation_history';
  }
  if (REVISION_PATH.test(path)) {
    return 'tenant_settings_cost_allocation_revision';
  }
  return null;
}

export function createTenantCostAllocationHttpHandler({
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

  return async function handleTenantCostAllocation({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!tenantCostAllocationRouteKey(path)) return null;
    if (!service) {
      throw new ApiError(503, 'TENANT_COST_ALLOCATION_SERVICE_UNAVAILABLE');
    }
    const mutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    const common = { principal, tenantContext, correlationId: requestId };

    const bulkMatch = path.match(BULK_PATH);
    if (bulkMatch) {
      assertNoUnexpectedQuery(parsedUrl);
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
        await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, BULK_MAX_BYTES) }),
        operation === 'validate' ? BULK_VALIDATE_SCHEMA : BULK_APPLY_SCHEMA,
      );
      const result = operation === 'validate'
        ? await service.bulkValidate({ ...common, type, ...body })
        : await service.bulkApply({ ...common, type, ...body });
      sendJson(response, 200, result, maxResponseBytes);
      return 200;
    }

    if (path === TENANT_COST_ALLOCATION_ROUTES.current) {
      assertNoUnexpectedQuery(parsedUrl);
      if (request.method === 'GET') {
        await assertEmptyBody(request);
        sendJson(
          response,
          200,
          { costAllocation: await service.getCurrent(common) },
          maxResponseBytes,
        );
        return 200;
      }
      if (request.method === 'PUT') {
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          UPDATE_SCHEMA,
        );
        sendJson(
          response,
          200,
          { costAllocation: await service.update({ ...common, ...body }) },
          maxResponseBytes,
        );
        return 200;
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }

    if (path === TENANT_COST_ALLOCATION_ROUTES.history) {
      if (request.method !== 'GET') {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }
      assertNoUnexpectedQuery(parsedUrl, new Set(['limit']));
      await assertEmptyBody(request);
      const rawLimit = parsedUrl.searchParams.get('limit');
      if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) {
        throw new ApiError(400, 'VALIDATION_FAILED');
      }
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      sendJson(
        response,
        200,
        { history: await service.listHistory({ ...common, limit }) },
        maxResponseBytes,
      );
      return 200;
    }

    const match = path.match(REVISION_PATH);
    if (match) {
      assertNoUnexpectedQuery(parsedUrl);
      if (request.method !== 'GET') {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }
      await assertEmptyBody(request);
      const snapshot = await service.getRevision({
        ...common,
        revision: Number(match[1]),
      });
      if (!snapshot) throw new ApiError(404, 'NOT_FOUND');
      sendJson(response, 200, { revision: snapshot }, maxResponseBytes);
      return 200;
    }
    return null;
  };
}

export const tenantCostAllocationRoutes = defineRouteModule({
  id: 'tenant-cost-allocation',
  routeKey: tenantCostAllocationRouteKey,
  createHandler(runtime) {
    return createTenantCostAllocationHttpHandler({
      service: runtime.tenantCostAllocationService,
      principalGuard: runtime.principalGuard,
      tenantGuard: runtime.tenantGuard,
      maxBodyBytes: runtime.maxBodyBytes,
      maxResponseBytes: runtime.maxResponseBytes,
    });
  },
});
