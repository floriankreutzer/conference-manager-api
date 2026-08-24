import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from '../authorization/errors.js';
import { isRequestId } from '../domain/request.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function assertRequestId(requestId) {
  if (!isRequestId(requestId)) throw new AuthorizationInputError('REQUEST_ID_INVALID');
}

export function createRequestService({
  repository,
  authorizationPolicy,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.findByTenantIdAndId !== 'function'
    || typeof repository.transitionByTenantIdAndId !== 'function'
  ) {
    throw new TypeError('REQUEST_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeRequestRead !== 'function'
    || typeof authorizationPolicy.authorizeRequestTransition !== 'function'
  ) {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  async function loadRequest(tenantContext, requestId) {
    assertRequestId(requestId);
    const request = await repository.findByTenantIdAndId(tenantContext.tenantId, requestId);
    if (!request) throw concealedNotFound();
    return request;
  }

  return Object.freeze({
    async getRequest({ principal, tenantContext, requestId }) {
      const request = await loadRequest(tenantContext, requestId);
      authorizationPolicy.authorizeRequestRead(principal, tenantContext, request);
      return request;
    },

    async transitionRequest({ principal, tenantContext, requestId, transition, reason }) {
      const request = await loadRequest(tenantContext, requestId);
      const decision = authorizationPolicy.authorizeRequestTransition(
        principal,
        tenantContext,
        request,
        transition,
        reason,
      );
      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) throw new TypeError('REQUEST_CLOCK_INVALID');
      const updated = await repository.transitionByTenantIdAndId({
        tenantId: tenantContext.tenantId,
        requestId,
        expectedStatus: decision.expectedStatus,
        nextStatus: decision.nextStatus,
        reason: decision.reason,
        changedAt: new Date(changedMs),
      });
      if (!updated) throw new RequestStateConflictError();
      return updated;
    },
  });
}
