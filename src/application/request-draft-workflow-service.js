import { randomUUID } from 'node:crypto';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import {
  AuthorizationDeniedError, AuthorizationInputError, RequestStateConflictError,
} from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';

export function createRequestDraftWorkflowService({
  repository, authorizationPolicy, auditService, clock = () => Date.now(), idFactory = randomUUID,
} = {}) {
  if (!repository?.startForOwner || !repository?.abandonForOwner) {
    throw new TypeError('REQUEST_WORKFLOW_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy?.authorizeRequestCreate || !auditService?.createEvent
    || typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('REQUEST_WORKFLOW_DEPENDENCY_INVALID');
  }

  function context({ principal, tenantContext, correlationId }, action, targetId) {
    authorizationPolicy.authorizeRequestCreate(principal, tenantContext);
    if (!isInternalUuid(correlationId) || !isInternalUuid(targetId)) {
      throw new AuthorizationInputError('REQUEST_WORKFLOW_INPUT_INVALID');
    }
    const securityVersion = principal.session?.securityVersion;
    if (!Number.isSafeInteger(securityVersion) || securityVersion < 1) {
      throw new AuthorizationDeniedError();
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('APPLICATION_CLOCK_INVALID');
    const changedAt = new Date(now);
    const starting = action === AUDIT_ACTION.REQUEST_STARTED;
    const auditEvent = auditService.createEvent({
      principal, tenantContext, correlationId, action, targetType: 'request', targetId,
      previousState: starting ? null : { status: 'started' },
      newState: { status: starting ? 'started' : 'abandoned' },
      outcome: AUDIT_OUTCOME.SUCCESS,
      metadata: { operation: starting ? 'request_start' : 'request_abandon' },
      retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
      occurredAt: changedAt.toISOString(),
    });
    return { tenantId: tenantContext.tenantId, ownerUserId: principal.userId,
      securityVersion, workflowId: targetId, changedAt, auditEvent };
  }

  function resultWorkflow(result) {
    if (result?.status === 'conflict') throw new RequestStateConflictError();
    if (!result?.workflow) {
      throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
    }
    return result.workflow;
  }

  return Object.freeze({
    async startRequestWorkflow({ idempotencyKey, ...values }) {
      if (!isInternalUuid(idempotencyKey)) {
        throw new AuthorizationInputError('REQUEST_WORKFLOW_INPUT_INVALID');
      }
      const workflowId = idFactory();
      if (!isInternalUuid(workflowId)) throw new TypeError('REQUEST_ID_FACTORY_INVALID');
      return resultWorkflow(await repository.startForOwner({
        ...context(values, AUDIT_ACTION.REQUEST_STARTED, workflowId.toLowerCase()),
        idempotencyKey: idempotencyKey.toLowerCase(),
      }));
    },

    async abandonRequestWorkflow({ workflowId, ...values }) {
      if (!isInternalUuid(workflowId)) {
        throw new AuthorizationInputError('REQUEST_WORKFLOW_INPUT_INVALID');
      }
      return resultWorkflow(await repository.abandonForOwner(
        context(values, AUDIT_ACTION.REQUEST_ABANDONED, workflowId.toLowerCase()),
      ));
    },
  });
}
