import { AUDIT_ACTION } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { isCateringOrderStatus } from '../domain/catering-order-state.js';
import { normalizeCateringOrderTotal } from '../domain/catering-order-money.js';
import { normalizeCateringVersionCommand, normalizeCateringVersionProposal } from '../domain/catering-version-proposal.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringVersionInputError, CateringVersionConflictError } from './catering-version-errors.js';

function invalid() { throw new TypeError('CATERING_VERSION_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
function input(work) { try { return work(); } catch { throw new CateringVersionInputError(); } }
function publicProposal(value, scope) {
  const { tenantId: _tenant, commandId: _command, priorStateRevision: _revision,
    proposedByUserId: _actor, proposerSecurityVersion: _security, ...proposal } = normalizeCateringVersionProposal(value, scope);
  return Object.freeze(proposal);
}
function orderState(value) {
  record(value, ['orderVersion','revision','status']);
  if (!isCateringOrderStatus(value.status)) invalid();
  return Object.freeze({ orderVersion: count(value.orderVersion), revision: count(value.revision), status: value.status });
}

export function createCateringVersionService({ repository, authorizationPolicy, auditService } = {}) {
  if (!repository || !['load','propose'].every((key) => typeof repository[key] === 'function')) {
    throw new TypeError('CATERING_VERSION_REPOSITORY_REQUIRED');
  }
  if (typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService?.[key] === 'function')) {
    throw new TypeError('CATERING_VERSION_AUTHORITY_REQUIRED');
  }
  async function denied(context, operation) {
    if (isInternalUuid(context?.principal?.tenantId) && context.principal.tenantId === context?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({ ...context, targetType: 'catering_order', targetId: 'catering-order-versions',
        metadata: { operation } });
    }
  }
  async function authorize(context, operation) {
    uuid(context?.correlationId);
    try { authorizationPolicy.requireTenantPermission(context?.principal, context?.tenantContext, PERMISSION.REQUEST_MANAGE); }
    catch (error) { if (error instanceof AuthorizationDeniedError) await denied(context, operation); throw error; }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    return { principal: context.principal, tenantContext: context.tenantContext, tenantId: uuid(context.tenantContext.tenantId),
      actorUserId: uuid(context.principal.userId), correlationId: uuid(context.correlationId) };
  }
  return Object.freeze({
    async load(context) {
      const authorized = await authorize(context, 'catering_version_read');
      const parameters = input(() => ({ orderId: uuid(context.orderId), afterOrderVersion: count(context.afterOrderVersion ?? 1) }));
      const value = await repository.load({ tenantId: authorized.tenantId, ...parameters });
      if (!value) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','orderId','requestId','orderState','currentRequest','currentAssignmentRevision',
        'basis','allowedOperations','proposals','nextAfterOrderVersion']);
      if (value.tenantId !== authorized.tenantId || value.orderId !== parameters.orderId || !isRequestId(value.requestId)) invalid();
      const current = orderState(value.orderState); const assignment = count(value.currentAssignmentRevision, 0);
      let request = null;
      if (value.currentRequest !== null) {
        record(value.currentRequest, ['version','status']);
        if (!['Confirmed','Cancelled'].includes(value.currentRequest.status)) invalid();
        request = Object.freeze({ version: count(value.currentRequest.version), status: value.currentRequest.status });
      }
      let basis = null;
      if (value.basis !== null) {
        record(value.basis, ['orderVersion','status','requestVersion','assignmentRevision','providerCost']);
        if (!['confirmed','cancelled'].includes(value.basis.status) || count(value.basis.orderVersion) > current.orderVersion
          || (request && count(value.basis.requestVersion) > request.version)) invalid();
        basis = Object.freeze({ orderVersion: value.basis.orderVersion, status: value.basis.status,
          requestVersion: count(value.basis.requestVersion), assignmentRevision: count(value.basis.assignmentRevision),
          providerCost: normalizeCateringOrderTotal(value.basis.providerCost) });
      }
      const allowed = array(value.allowedOperations, 3).map((operation) => {
        if (!['change','cancel','exception'].includes(operation) || !request) invalid();
        if (basis === null) {
          if (operation !== 'change' || current.status !== 'withdrawn' || request.status !== 'Confirmed' || assignment === 0) invalid();
          return operation;
        }
        if (basis.status !== 'confirmed' || !['confirmed','rejected','failed','withdrawn'].includes(current.status)
          || (current.status === 'confirmed' && basis.orderVersion !== current.orderVersion)
          || (operation !== 'cancel' && request.status !== 'Confirmed')
          || (operation === 'change' && (request.version === basis.requestVersion || assignment === 0))
          || (operation === 'exception' && request.version !== basis.requestVersion)) invalid();
        return operation;
      });
      if (new Set(allowed).size !== allowed.length) invalid();
      let previous = parameters.afterOrderVersion;
      const proposals = array(value.proposals, 20).map((entry) => {
        const proposal = publicProposal(entry, { tenantId: authorized.tenantId, orderId: parameters.orderId });
        if (proposal.orderVersion !== previous + 1 || proposal.orderVersion > current.orderVersion
          || proposal.requestId !== value.requestId) invalid();
        previous = proposal.orderVersion; return proposal;
      });
      if (proposals.length !== Math.min(20, Math.max(0, current.orderVersion - parameters.afterOrderVersion))) invalid();
      const next = current.orderVersion > previous ? previous : null;
      if (value.nextAfterOrderVersion !== next) invalid();
      return Object.freeze({ schemaVersion: 1, orderId: parameters.orderId, requestId: value.requestId, orderState: current,
        currentRequest: request, currentAssignmentRevision: assignment, basis, allowedOperations: Object.freeze(allowed),
        proposals: Object.freeze(proposals), nextAfterOrderVersion: next });
    },
    async propose(context) {
      const authorized = await authorize(context, 'catering_version_propose');
      const session = authorized.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      const command = input(() => normalizeCateringVersionCommand({ schemaVersion: context.schemaVersion, commandId: context.commandId,
        expectedOrderVersion: context.expectedOrderVersion, expectedStateRevision: context.expectedStateRevision,
        expectedRequestVersion: context.expectedRequestVersion, expectedAssignmentRevision: context.expectedAssignmentRevision,
        operation: context.operation, justification: context.justification }, { orderId: context.orderId }));
      const saved = await repository.propose({ ...authorized, ...command, sessionId: uuid(session.id),
        expectedSecurityVersion: session.securityVersion,
        auditEventFor(values) {
          const firstDelivery = values.deliveryOperation !== undefined;
          if (values.orderId !== command.orderId || values.orderVersion !== command.expectedOrderVersion + 1
            || values.priorOrderVersion !== command.expectedOrderVersion || values.priorStateRevision !== command.expectedStateRevision
            || values.requestVersion !== command.expectedRequestVersion || values.operation !== command.operation) invalid();
          if (count(values.basisOrderVersion) > command.expectedOrderVersion
            || count(values.sourceRequestVersion) > command.expectedRequestVersion
            || (command.operation !== 'cancel' && values.sourceRequestVersion !== command.expectedRequestVersion)) invalid();
          if (firstDelivery && (values.deliveryOperation !== 'initial' || command.operation !== 'change'
            || values.basisOrderVersion !== command.expectedOrderVersion)) invalid();
          return auditService.createEvent({ ...authorized, action: firstDelivery
            ? AUDIT_ACTION.CATERING_ORDER_UNSENT_REPLACED : AUDIT_ACTION.CATERING_ORDER_VERSION_PROPOSED,
            targetType: 'catering_order', targetId: command.orderId, outcome: 'success', retentionClass: 'business',
            previousState: { version: command.expectedOrderVersion, revision: command.expectedStateRevision },
            newState: { version: values.orderVersion, revision: 1, status: 'pending_quote' },
            metadata: { operation: 'catering_version_propose', versionOperation: values.operation,
              ...(firstDelivery ? { deliveryOperation: 'initial' } : {}),
              requestVersion: values.requestVersion, basisOrderVersion: values.basisOrderVersion,
              sourceRequestVersion: values.sourceRequestVersion } });
        } });
      if (saved?.status === 'not_authorized') {
        await denied(authorized, 'catering_version_propose'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const conflicts = { state_conflict: 'CATERING_VERSION_REVISION_CONFLICT', command_conflict: 'CATERING_VERSION_COMMAND_CONFLICT',
        request_conflict: 'CATERING_VERSION_REQUEST_CHANGED', assignment_conflict: 'CATERING_VERSION_ASSIGNMENT_CHANGED',
        source_unavailable: 'CATERING_VERSION_SOURCE_UNAVAILABLE' };
      if (Object.hasOwn(conflicts, saved?.status)) throw new CateringVersionConflictError(conflicts[saved.status]);
      record(saved, ['status','replayed','proposal','orderState']);
      if (saved.status !== 'proposed' || typeof saved.replayed !== 'boolean') invalid();
      const proposal = normalizeCateringVersionProposal(saved.proposal, { tenantId: authorized.tenantId, orderId: command.orderId });
      if (proposal.commandId !== command.commandId || proposal.priorOrderVersion !== command.expectedOrderVersion
        || proposal.priorStateRevision !== command.expectedStateRevision
        || proposal.requestEvidenceVersion !== command.expectedRequestVersion
        || proposal.assignmentRevision !== command.expectedAssignmentRevision || proposal.operation !== command.operation
        || proposal.justification !== command.justification || proposal.proposedByUserId !== authorized.actorUserId
        || proposal.proposerSecurityVersion !== session.securityVersion) invalid();
      const current = orderState(saved.orderState);
      if (current.orderVersion !== proposal.orderVersion || (!saved.replayed && (current.revision !== 1
        || current.status !== 'pending_quote'))) invalid();
      return Object.freeze({ schemaVersion: 1, replayed: saved.replayed,
        proposal: publicProposal(proposal, { tenantId: authorized.tenantId, orderId: command.orderId }), orderState: current });
    },
  });
}
