import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { readJsonObjectBody,validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT = '/api/v1/tenant/catering/provider-catalogues/';
const revision = (minimum) => (value) => Number.isSafeInteger(value) && value>=minimum && value<=Number.MAX_SAFE_INTEGER-2;
const SCHEMA = Object.freeze({ required: Object.freeze({ schemaVersion: (value) => value === 1,commandId: isInternalUuid,
  expectedReviewRevision: revision(0),expectedSourceRevision: revision(1),expectedConfigurationRevision: revision(1),
  expectedCatalogueRevision: revision(1),expectedAssignmentRevision: revision(0),expectedPublicationRevision: revision(0),
  decision: (value) => ['published','rejected'].includes(value),
  justification: (value) => typeof value === 'string' && value.length>0 && value.length<=1000,
  items: (value) => Array.isArray(value) && value.length<=300,packages: (value) => Array.isArray(value) && value.length<=100,
}),optional: Object.freeze({}) });
function selectedRoute(path) {
  if (typeof path !== 'string' || !path.startsWith(ROOT)) return null;
  const match = path.slice(ROOT.length).match(/^([0-9a-fA-F-]{36})\/(review|reviews)$/);
  return match && isInternalUuid(match[1]) ? { integrationId: match[1].toLowerCase(),history: match[2] === 'reviews' } : null;
}
export function cateringCataloguePublicationRouteKey(path) {
  const selected = selectedRoute(path); return selected === null ? null
    : selected.history ? 'catering_catalogue_reviews' : 'catering_catalogue_review';
}
function queryCounter(value,minimum) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new ApiError(400,'VALIDATION_FAILED');
  const number = Number(value); if (!revision(minimum)(number)) throw new ApiError(400,'VALIDATION_FAILED'); return number;
}
function query(parsedUrl,history) {
  const pairs = [...parsedUrl.searchParams.entries()];
  const allowed = history ? ['beforeRevision'] : ['afterKind','afterEntryId','publicationRevision'];
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length || pairs.some(([key]) => !allowed.includes(key))) {
    throw new ApiError(400,'VALIDATION_FAILED');
  }
  if (history) return { beforeRevision: pairs.length === 0 ? null : queryCounter(pairs[0][1],1) };
  const kind = parsedUrl.searchParams.get('afterKind'); const entryId = parsedUrl.searchParams.get('afterEntryId');
  const publicationRevision = parsedUrl.searchParams.has('publicationRevision')
    ? queryCounter(parsedUrl.searchParams.get('publicationRevision'),0) : null;
  if (kind === null && entryId === null) return { afterBinding: null,publicationRevision };
  if (!['item','package'].includes(kind) || typeof entryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entryId)
    || publicationRevision === null) throw new ApiError(400,'VALIDATION_FAILED');
  return { afterBinding: { kind,entryId },publicationRevision };
}
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length>0) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
}
export function createCateringCataloguePublicationHttpHandler({ writeService = null,readService = null,principalGuard,tenantGuard,
  maxBodyBytes,maxResponseBytes } = {}) {
  if ((writeService !== null && typeof writeService?.review !== 'function')
    || (readService !== null && !['loadContext','listHistory'].every((name) => typeof readService?.[name] === 'function'))
    || typeof principalGuard?.require !== 'function' || typeof tenantGuard?.requireActive !== 'function'
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
    throw new TypeError('CATERING_CATALOGUE_REVIEW_HTTP_PORT_REQUIRED');
  }
  return async ({ request,response,path,parsedUrl,requestId }) => {
    const selected = selectedRoute(path); if (!selected) return null;
    if (writeService === null || readService === null) throw new ApiError(503,'CATERING_CATALOGUE_REVIEW_UNAVAILABLE');
    const principal = await principalGuard.require(request,{ csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal,tenantContext,correlationId: requestId,integrationId: selected.integrationId }; let value;
    if (request.method === 'GET') {
      await emptyBody(request); const options = query(parsedUrl,selected.history);
      value = selected.history ? await readService.listHistory({ ...context,...options })
        : await readService.loadContext({ ...context,...options });
    } else if (request.method === 'POST' && !selected.history) {
      if ([...parsedUrl.searchParams.keys()].length !== 0) throw new ApiError(400,'VALIDATION_FAILED');
      const command = validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,1048576) }),SCHEMA);
      value = await writeService.review({ ...context,command });
    } else {
      response.setHeader('Allow',selected.history ? 'GET' : 'GET, POST'); throw new ApiError(405,'METHOD_NOT_ALLOWED');
    }
    const body = JSON.stringify(value); const length = Buffer.byteLength(body);
    if (length>Math.min(maxResponseBytes,524288)) throw new ApiError(500,'RESPONSE_TOO_LARGE');
    response.statusCode=200; response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('Content-Length',length); response.end(body); return 200;
  };
}
export function createCateringCataloguePublicationRouteModule(writeService,readService) {
  return defineRouteModule({ id: 'catering-catalogue-publication',routeKey: cateringCataloguePublicationRouteKey,
    createHandler(runtime) {
      return createCateringCataloguePublicationHttpHandler({ writeService,readService,principalGuard: runtime?.principalGuard,
        tenantGuard: runtime?.tenantGuard,maxBodyBytes: runtime?.maxBodyBytes,maxResponseBytes: runtime?.maxResponseBytes });
    } });
}
