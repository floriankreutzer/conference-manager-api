import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_OPERATION } from '../application/platform-operation-contract.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { platformMutationAuthority } from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
  readPlatformJsonObject,
  requirePlatformExactObject,
} from './security.js';

export const PLATFORM_TENANTS_PATH = '/api/v1/platform/tenants';
const TENANT_INVITATIONS_PATH=/^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/invitations$/i;
const TENANT_INVITATION_PATH = new RegExp(
  '^/api/v1/platform/tenants/([0-9a-f-]{36})/invitations/([0-9a-f-]{36})$',
  'i',
);
const TENANT_INVITATION_REISSUE_PATH = new RegExp(
  '^/api/v1/platform/tenants/([0-9a-f-]{36})/invitations/([0-9a-f-]{36})/reissue$',
  'i',
);
const TENANT_LIFECYCLE_PATH = new RegExp(
  '^/api/v1/platform/tenants/([0-9a-f-]{36})/lifecycle/transitions$',
  'i',
);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CURSOR_PATTERN = /^[A-Za-z0-9_.-]{1,4096}$/;
const LIFECYCLE_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const LIFECYCLE_TARGETS = new Set(['ready', 'active', 'suspended', 'archived']);

function boundedText(value, maximum) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximum
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value);
}

function positiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function internalId(value) {
  return isInternalUuid(value);
}

function confirmationForTenant(value, action, tenantId) {
  requirePlatformExactObject(value, {
    required: {
      action: (candidate) => candidate === action,
      tenantId: (candidate) => internalId(candidate) && candidate.toLowerCase() === tenantId,
    },
  });
  return value;
}

function createTenantBody(value,multipleRecipients=false) {
  const body = requirePlatformExactObject(value, {
    required: {
      displayName: (candidate) => boundedText(candidate, 160),
      reason: (candidate) => boundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
      ...(multipleRecipients ? { invitations: candidate=>Array.isArray(candidate) && candidate.length<=19 } : {}),
    },
  });
  requirePlatformExactObject(body.confirmation, {
    required: {
      action: (candidate) => candidate === PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
      displayName: (candidate) => candidate === body.displayName,
    },
  });
  return body;
}

function invitationMutationBody(value, action, tenantId) {
  const body = requirePlatformExactObject(value, {
    required: {
      expectedRevision: positiveRevision,
      reason: (candidate) => boundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    },
  });
  confirmationForTenant(body.confirmation, action, tenantId);
  return body;
}

function lifecycleMutationBody(value, tenantId) {
  const body = requirePlatformExactObject(value, {
    required: {
      targetStatus: (candidate) => typeof candidate === 'string' && LIFECYCLE_TARGETS.has(candidate),
      expectedRevision: positiveRevision,
      reason: (candidate) => boundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    },
  });
  confirmationForTenant(body.confirmation, PLATFORM_OPERATION.LIFECYCLE_TRANSITION, tenantId);
  return body;
}

function directoryQuery(parsedUrl) {
  const allowed = new Set(['limit', 'cursor', 'lifecycleStatus', 'search']);
  for (const key of parsedUrl.searchParams.keys()) {
    if (!allowed.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
  }
  const query = {};
  const limit = parsedUrl.searchParams.get('limit');
  if (limit !== null) {
    if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
    query.limit = Number(limit);
  }
  const cursor = parsedUrl.searchParams.get('cursor');
  if (cursor !== null) {
    if (!CURSOR_PATTERN.test(cursor)) throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    query.cursor = cursor;
  }
  const lifecycleStatus = parsedUrl.searchParams.get('lifecycleStatus');
  if (lifecycleStatus !== null) {
    if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
    query.lifecycleStatus = lifecycleStatus;
  }
  const search = parsedUrl.searchParams.get('search');
  if (search !== null) {
    if (!boundedText(search, 160)) throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    query.search = search;
  }
  return Object.freeze(query);
}

function tenantMatches(path) {
  const reissue = path.match(TENANT_INVITATION_REISSUE_PATH);
  if (reissue && internalId(reissue[1]) && internalId(reissue[2])) {
    return Object.freeze({ type: 'reissue', tenantId: reissue[1].toLowerCase(), invitationId: reissue[2].toLowerCase() });
  }
  const invitation = path.match(TENANT_INVITATION_PATH);
  if (invitation && internalId(invitation[1]) && internalId(invitation[2])) {
    return Object.freeze({
      type: 'revoke',
      tenantId: invitation[1].toLowerCase(),
      invitationId: invitation[2].toLowerCase(),
    });
  }
  const lifecycle = path.match(TENANT_LIFECYCLE_PATH);
  if (lifecycle && internalId(lifecycle[1])) {
    return Object.freeze({ type: 'lifecycle', tenantId: lifecycle[1].toLowerCase() });
  }
  return null;
}

function tenantRoute(context) {
  if (context.path === PLATFORM_TENANTS_PATH) {
    return context.method === 'POST'
      ? PLATFORM_HTTP_ROUTE.TENANT_CREATE
      : PLATFORM_HTTP_ROUTE.TENANT_DIRECTORY;
  }
  const match = tenantMatches(context.path);
  if (match?.type === 'revoke') return PLATFORM_HTTP_ROUTE.INVITATION_REVOKE;
  if (match?.type === 'reissue') return PLATFORM_HTTP_ROUTE.INVITATION_REISSUE;
  if (match?.type === 'lifecycle') return PLATFORM_HTTP_ROUTE.LIFECYCLE_TRANSITION;
  return null;
}

function invitationCollection(path) {
  const match=path.match(TENANT_INVITATIONS_PATH);
  return match && internalId(match[1]) ? match[1].toLowerCase() : null;
}
function invitationListQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['limit','afterId'].includes(key) || parsedUrl.searchParams.getAll(key).length!==1) {
      throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
    }
  }
  const limit=parsedUrl.searchParams.get('limit'),after=parsedUrl.searchParams.get('afterId');
  if ((limit!==null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit)>100))
    || (after!==null && !internalId(after))) throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
  return { limit: limit===null ? 50 : Number(limit),afterInvitationId: after===null ? null : after.toLowerCase() };
}
export function createPlatformTenantRoutes({ invitationAdministration=false } = {}) {
  if (typeof invitationAdministration!=='boolean') throw new TypeError('PLATFORM_TENANT_ROUTE_CONFIGURATION_INVALID');
  return definePlatformRouteModule({
  id: 'platform-tenants',
  claim(context) {
    if (invitationAdministration && invitationCollection(context.path)!==null) {
      return context.method==='GET' ? PLATFORM_HTTP_ROUTE.INVITATION_LIST : PLATFORM_HTTP_ROUTE.INVITATION_ISSUE;
    }
    return tenantRoute(context);
  },
  createHandler({
    platformTenantOperationsService,
    platformCustomerOnboardingService=null,
    platformCustomerInvitationAdministrationService=null,
    platformPrincipalGuard,
    maxBodyBytes,
    maxResponseBytes,
  }) {
    if (
      !platformTenantOperationsService
      || typeof platformTenantOperationsService.listDirectory !== 'function'
      || typeof platformTenantOperationsService.createTenantInvitation !== 'function'
      || typeof platformTenantOperationsService.revokeInvitation !== 'function'
      || typeof platformTenantOperationsService.reissueInvitation !== 'function'
      || typeof platformTenantOperationsService.transitionLifecycle !== 'function'
    ) {
      throw new TypeError('PLATFORM_TENANT_OPERATIONS_SERVICE_REQUIRED');
    }
    if (platformCustomerOnboardingService!==null && typeof platformCustomerOnboardingService?.createTenant!=='function') {
      throw new TypeError('PLATFORM_CUSTOMER_ONBOARDING_SERVICE_REQUIRED');
    }
    if (invitationAdministration && (platformCustomerOnboardingService===null
      || !platformCustomerInvitationAdministrationService
      || ['list','issueBatch','reissue','revoke'].some(name=>typeof platformCustomerInvitationAdministrationService[name]!=='function'))) {
      throw new TypeError('PLATFORM_CUSTOMER_INVITATION_ADMINISTRATION_REQUIRED');
    }
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }

    return async function handle(context) {
      const { path, parsedUrl, request, response, requestId } = context;
      const collection=invitationAdministration ? invitationCollection(path) : null;
      if (collection!==null) {
        if (!['GET','POST'].includes(request.method)) throw new PlatformHttpError(405,'PLATFORM_METHOD_NOT_ALLOWED');
        const trusted=await platformMutationAuthority({ platformPrincipalGuard,request,correlationId: requestId,
          idempotent: request.method==='POST' });
        let result;
        if (request.method==='GET') {
          await assertNoPlatformRequestBody(request);
          result=await platformCustomerInvitationAdministrationService.list({ ...trusted,tenantId: collection,
            correlationId: requestId,...invitationListQuery(parsedUrl) });
        } else {
          assertPlatformNoQuery(parsedUrl);
          const body=requirePlatformExactObject(await readPlatformJsonObject(request,{ maxBytes: maxBodyBytes }),{ required: {
            invitations: value=>Array.isArray(value) && value.length>=1 && value.length<=20,
            reason: value=>boundedText(value,500),confirmation: value=>value && typeof value==='object' && !Array.isArray(value),
          } });
          confirmationForTenant(body.confirmation,PLATFORM_OPERATION.TENANT_INVITATION_CREATE,collection);
          result=await platformCustomerInvitationAdministrationService.issueBatch({ ...trusted,...body,
            tenantId: collection,correlationId: requestId });
        }
        const status=request.method==='POST' && result?.outcome==='updated' ? 201 : 200;
        sendPlatformJson(response,status,result,maxResponseBytes);return status;
      }
      const match = tenantMatches(path);
      if (path !== PLATFORM_TENANTS_PATH && match === null) return null;

      if (path === PLATFORM_TENANTS_PATH && request.method === 'GET') {
        const principal = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const result = await platformTenantOperationsService.listDirectory({
          operatorContext: principal,
          query: directoryQuery(parsedUrl),
        });
        sendPlatformJson(response, 200, result, maxResponseBytes);
        return 200;
      }

      if (path === PLATFORM_TENANTS_PATH && request.method === 'POST') {
        assertPlatformNoQuery(parsedUrl);
        const trusted = await platformMutationAuthority({
          platformPrincipalGuard,
          request,
          correlationId: requestId,
        });
        const body = createTenantBody(await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
          platformCustomerOnboardingService!==null);
        const command={ ...trusted,...body,correlationId: requestId };
        const result = platformCustomerOnboardingService===null
          ? await platformTenantOperationsService.createTenantInvitation(command)
          : await platformCustomerOnboardingService.createTenant(command);
        const statusCode = result?.outcome === 'updated' ? 201 : 200;
        sendPlatformJson(response, statusCode, result, maxResponseBytes);
        return statusCode;
      }

      if (path === PLATFORM_TENANTS_PATH) {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }

      assertPlatformNoQuery(parsedUrl);
      const expectedMethod = match.type === 'revoke' ? 'DELETE' : 'POST';
      if (request.method !== expectedMethod) {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }
      const trusted = await platformMutationAuthority({
        platformPrincipalGuard,
        request,
        correlationId: requestId,
      });

      if (match.type === 'lifecycle') {
        const body = lifecycleMutationBody(
          await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
          match.tenantId,
        );
        const result = await platformTenantOperationsService.transitionLifecycle({
          ...trusted,
          ...body,
          tenantId: match.tenantId,
          correlationId: requestId,
        });
        sendPlatformJson(response, 200, result, maxResponseBytes);
        return 200;
      }

      const operation = match.type === 'revoke'
        ? PLATFORM_OPERATION.INVITATION_REVOKE
        : PLATFORM_OPERATION.INVITATION_REISSUE;
      const body = invitationMutationBody(
        await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
        operation,
        match.tenantId,
      );
      const input = {
        ...trusted,
        ...body,
        tenantId: match.tenantId,
        invitationId: match.invitationId,
        correlationId: requestId,
      };
      const result = invitationAdministration
        ? await platformCustomerInvitationAdministrationService[match.type](input)
        : match.type === 'revoke'
          ? await platformTenantOperationsService.revokeInvitation(input)
          : await platformTenantOperationsService.reissueInvitation(input);
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
}

export const platformTenantRoutes=createPlatformTenantRoutes();
