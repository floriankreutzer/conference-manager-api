import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT = '/api/v1/tenant/catering/provider-catalogues/';
const SCHEMA = Object.freeze({ required: Object.freeze({ schemaVersion: (value) => value === 1,
  commandId: isInternalUuid, expectedRevision: (value) => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 2,
  expectedConfigurationRevision: (value) => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER,
  reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 160,
  attestReceivedFromSupplier: (value) => value === true,
  source: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
}), optional: Object.freeze({}) });
function counter(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const number = Number(value); return Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER ? number : null;
}
function route(path) {
  if (path === ROOT.slice(0,-1)) return { integrationId: null,revision: null };
  if (typeof path !== 'string' || !path.startsWith(ROOT)) return null;
  const match = path.slice(ROOT.length).match(/^([0-9a-fA-F-]{36})(?:\/revisions\/([1-9][0-9]{0,15}))?$/);
  if (!match || !isInternalUuid(match[1])) return null;
  const revision = match[2] === undefined ? null : counter(match[2]);
  return match[2] !== undefined && revision === null ? null : { integrationId: match[1].toLowerCase(), revision };
}
export function cateringProviderCatalogueRouteKey(path) {
  const selected = route(path); return selected === null ? null
    : selected.integrationId === null ? 'catering_provider_catalogue_connections'
      : selected.revision === null ? 'catering_provider_catalogues' : 'catering_provider_catalogue_details';
}
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
function queryValues(parsedUrl, detail) {
  const pairs = [...parsedUrl.searchParams.entries()];
  if (!detail) {
    if (pairs.length === 0) return { beforeRevision: null };
    if (pairs.length !== 1 || pairs[0][0] !== 'beforeRevision' || counter(pairs[0][1]) === null) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
    return { beforeRevision: counter(pairs[0][1]) };
  }
  if (pairs.length > 2 || new Set(pairs.map(([key]) => key)).size !== pairs.length
    || pairs.some(([key]) => !['section','afterEntryId'].includes(key))) throw new ApiError(400, 'VALIDATION_FAILED');
  const section = parsedUrl.searchParams.get('section') ?? 'items';
  const afterEntryId = parsedUrl.searchParams.get('afterEntryId');
  if (!['items','packages'].includes(section) || (afterEntryId !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(afterEntryId))) throw new ApiError(400, 'VALIDATION_FAILED');
  return { section, afterEntryId };
}
export function createCateringProviderCatalogueHttpHandler({ service = null, principalGuard, tenantGuard,
  maxBodyBytes, maxResponseBytes } = {}) {
  if (service !== null && !['listConnections','load','loadRevision','receive'].every((name) => typeof service?.[name] === 'function')) {
    throw new TypeError('CATERING_PROVIDER_CATALOGUE_HTTP_SERVICE_REQUIRED');
  }
  if (typeof principalGuard?.require !== 'function' || typeof tenantGuard?.requireActive !== 'function'
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) {
    throw new TypeError('CATERING_PROVIDER_CATALOGUE_HTTP_PORT_REQUIRED');
  }
  return async ({ request, response, path, parsedUrl, requestId }) => {
    const selected = route(path); if (selected === null) return null;
    if (service === null) throw new ApiError(503, 'CATERING_PROVIDER_CATALOGUE_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal, tenantContext, correlationId: requestId, integrationId: selected.integrationId };
    let value;
    if (request.method === 'GET') {
      await emptyBody(request);
      if (selected.integrationId === null) {
        const pairs = [...parsedUrl.searchParams.entries()];
        if (pairs.length > 1 || (pairs.length === 1 && (pairs[0][0] !== 'afterIntegrationId' || !isInternalUuid(pairs[0][1])))) {
          throw new ApiError(400,'VALIDATION_FAILED');
        }
        value = await service.listConnections({ principal,tenantContext,correlationId: requestId,
          afterIntegrationId: pairs.length === 0 ? null : pairs[0][1].toLowerCase() });
      } else {
      const query = queryValues(parsedUrl,selected.revision !== null);
      value = selected.revision === null ? await service.load({ ...context, ...query })
        : await service.loadRevision({ ...context, revision: selected.revision, ...query });
      }
    } else if (request.method === 'POST' && selected.revision === null && selected.integrationId !== null) {
      if ([...parsedUrl.searchParams.keys()].length !== 0) throw new ApiError(400, 'VALIDATION_FAILED');
      const command = validateExactObject(await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes,1048576) }), SCHEMA);
      value = await service.receive({ ...context, command });
    } else {
      response.setHeader('Allow', selected.revision === null && selected.integrationId !== null ? 'GET, POST' : 'GET');
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    const body = JSON.stringify(value); const length = Buffer.byteLength(body);
    if (length > Math.min(maxResponseBytes,524288)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200; response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', length); response.end(body); return 200;
  };
}
export function createCateringProviderCatalogueRouteModule(service) {
  return defineRouteModule({ id: 'catering-provider-catalogues', routeKey: cateringProviderCatalogueRouteKey,
    createHandler(runtime) {
      return createCateringProviderCatalogueHttpHandler({ service, principalGuard: runtime?.principalGuard,
        tenantGuard: runtime?.tenantGuard, maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes });
    } });
}
