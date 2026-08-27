import { ApiError } from '../../api-error.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';
import { TenantUserLifecycleConflictError } from '../../application/tenant-user-lifecycle-errors.js';
import { defineRouteModule } from '../route-module.js';

const USERS_PATH = '/api/v1/tenant/users';
const ACCESS_PATH = /^\/api\/v1\/tenant\/users\/([0-9a-f-]{36})\/access$/i;
const QUERY_KEYS = new Set(['limit', 'afterId', 'search', 'status', 'role', 'providerLink']);
const ACCESS_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    active: (value) => typeof value === 'boolean',
    expectedVersion: (value) => Number.isSafeInteger(value) && value >= 1,
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

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
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
  const afterId = parsedUrl.searchParams.get('afterId');
  if (limitValue !== null && !/^\d{1,3}$/.test(limitValue)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (limit < 1 || limit > 100)) throw new ApiError(400, 'VALIDATION_FAILED');
  if (afterId !== null && !isInternalUuid(afterId)) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({
    limit,
    afterUserId: afterId,
    search: parsedUrl.searchParams.get('search'),
    status: parsedUrl.searchParams.get('status') ?? undefined,
    role: parsedUrl.searchParams.get('role') ?? undefined,
    providerLink: parsedUrl.searchParams.get('providerLink') ?? undefined,
  });
}

export function tenantUserLifecycleRouteKey(path) {
  if (path === USERS_PATH) return 'tenant_user_lifecycle_list';
  if (ACCESS_PATH.test(path)) return 'tenant_user_lifecycle_access';
  return null;
}

export function createTenantUserLifecycleHttpHandler({
  tenantUserLifecycleService,
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

  return async function handleTenantUserLifecycle({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    const route = tenantUserLifecycleRouteKey(path);
    if (!route) return null;
    if (!tenantUserLifecycleService) throw new ApiError(503, 'TENANT_USER_LIFECYCLE_UNAVAILABLE');
    const mutation = route === 'tenant_user_lifecycle_access';
    if ((!mutation && request.method !== 'GET') || (mutation && request.method !== 'PUT')) {
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    if (!mutation) {
      await assertEmptyBody(request);
      const result = await tenantUserLifecycleService.listUsers({
        principal,
        tenantContext,
        correlationId: requestId,
        ...pageFromUrl(parsedUrl),
      });
      sendJson(response, 200, { ...result, requestId }, maxResponseBytes);
      return 200;
    }

    assertNoQuery(parsedUrl);
    const match = path.match(ACCESS_PATH);
    if (!match || !isInternalUuid(match[1])) throw new ApiError(404, 'NOT_FOUND');
    const body = validateExactObject(
      await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
      ACCESS_BODY_SCHEMA,
    );
    try {
      const user = await tenantUserLifecycleService.setAccess({
        principal,
        tenantContext,
        targetUserId: match[1].toLowerCase(),
        active: body.active,
        expectedVersion: body.expectedVersion,
        correlationId: requestId,
      });
      sendJson(response, 200, { user, requestId }, maxResponseBytes);
      return 200;
    } catch (error) {
      if (error instanceof TenantUserLifecycleConflictError) {
        throw new ApiError(409, error.code, { currentVersion: error.currentVersion });
      }
      throw error;
    }
  };
}

export const tenantUserLifecycleRouteModule = defineRouteModule({
  id: 'tenant-user-lifecycle',
  routeKey: tenantUserLifecycleRouteKey,
  createHandler: createTenantUserLifecycleHttpHandler,
});
