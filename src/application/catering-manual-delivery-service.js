import { AUDIT_ACTION } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isCateringOrderStatus } from '../domain/catering-order-state.js';
import { normalizeCateringManualCommand, normalizeCateringManualFact } from '../domain/catering-manual-contract.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringManualInputError, CateringManualConflictError } from './catering-manual-errors.js';

function invalid() { throw new TypeError('CATERING_MANUAL_RESULT_INVALID'); }
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
function input(work) { try { return work(); } catch { throw new CateringManualInputError(); } }
function publicFact(value, scope) {
  const { tenantId: _tenant, commandId: _command, originStateRevision: _origin, actorUserId: _actor,
    actorSecurityVersion: _security, ...fact } = normalizeCateringManualFact(value, scope);
  return Object.freeze(fact);
}
function orderState(value, version) {
  record(value, ['orderVersion','revision','status']);
  if (value.orderVersion !== version || !isCateringOrderStatus(value.status)) invalid();
  return Object.freeze({ orderVersion: version, revision: count(value.revision), status: value.status });
}

export function createCateringManualDeliveryService({ repository, authorizationPolicy, auditService } = {}) {
  if (!repository || !['load','record'].every((key) => typeof repository[key] === 'function')) {
    throw new TypeError('CATERING_MANUAL_REPOSITORY_REQUIRED');
  }
  if (typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService?.[key] === 'function')) {
    throw new TypeError('CATERING_MANUAL_AUTHORITY_REQUIRED');
  }
  async function denied(context, operation) {
    if (isInternalUuid(context?.principal?.tenantId) && context.principal.tenantId === context?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({ ...context, targetType: 'catering_order', targetId: 'catering-manual-delivery',
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
      const authorized = await authorize(context, 'catering_manual_read');
      const parameters = input(() => ({ orderId: uuid(context.orderId),
        orderVersion: context.orderVersion == null ? null : count(context.orderVersion),
        afterSequence: count(context.afterSequence ?? 0, 0) }));
      const value = await repository.load({ tenantId: authorized.tenantId, ...parameters });
      if (!value) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','orderId','orderVersion','orderState','manualSequence','events','nextAfterSequence','effective']);
      if (value.tenantId !== authorized.tenantId || value.orderId !== parameters.orderId
        || (parameters.orderVersion !== null && value.orderVersion !== parameters.orderVersion)) invalid();
      const version = count(value.orderVersion); const sequence = count(value.manualSequence, 0);
      if (!Array.isArray(value.events) || Object.getPrototypeOf(value.events) !== Array.prototype || value.events.length > 20
        || Reflect.ownKeys(value.events).length !== value.events.length + 1
        || value.events.length !== Math.min(20, Math.max(0, sequence - parameters.afterSequence))) invalid();
      let previous = parameters.afterSequence;
      const events = [];
      for (let index = 0; index < value.events.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value.events, String(index));
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
        const fact = publicFact(property.value, { tenantId: authorized.tenantId, orderId: parameters.orderId, orderVersion: version });
        if (fact.sequence !== previous + 1 || fact.sequence > sequence) invalid();
        previous = fact.sequence; events.push(fact);
      }
      const next = sequence > previous ? previous : null;
      if (value.nextAfterSequence !== next) invalid();
      let effective = null;
      if (value.effective !== null) {
        record(value.effective, ['orderVersion','status']);
        if (!['confirmed','cancelled'].includes(value.effective.status)) invalid();
        effective = Object.freeze({ orderVersion: count(value.effective.orderVersion), status: value.effective.status });
      }
      return Object.freeze({ schemaVersion: 1, orderId: parameters.orderId, orderVersion: version,
        orderState: orderState(value.orderState, version), manualSequence: sequence,
        events: Object.freeze(events), nextAfterSequence: next, effective });
    },
    async record(context) {
      const authorized = await authorize(context, 'catering_manual_record');
      const session = authorized.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      const command = input(() => normalizeCateringManualCommand({ schemaVersion: context.schemaVersion, commandId: context.commandId,
        expectedOrderVersion: context.expectedOrderVersion, expectedStateRevision: context.expectedStateRevision,
        kind: context.kind, channel: context.channel, reference: context.reference, occurredAt: context.occurredAt,
        receipt: context.receipt },
      { orderId: context.orderId }));
      const saved = await repository.record({ ...authorized, ...command, sessionId: uuid(session.id),
        expectedSecurityVersion: session.securityVersion,
        auditEventFor(values) {
          if (values.orderId !== command.orderId || values.orderVersion !== command.expectedOrderVersion
            || values.kind !== command.kind || values.previousRevision !== command.expectedStateRevision
            || values.revision !== command.expectedStateRevision + 1 || !isCateringOrderStatus(values.status)
            || !isCateringOrderStatus(values.previousStatus)) invalid();
          return auditService.createEvent({ ...authorized, action: command.kind === 'transmitted'
            ? AUDIT_ACTION.CATERING_MANUAL_TRANSMITTED : AUDIT_ACTION.CATERING_MANUAL_RECEIPT,
          targetType: 'catering_order', targetId: command.orderId, outcome: 'success', retentionClass: 'business',
          previousState: { revision: values.previousRevision, status: values.previousStatus },
          newState: { revision: values.revision, status: values.status, version: command.expectedOrderVersion },
          metadata: { operation: `catering_manual_${command.kind}` } });
        } });
      if (saved?.status === 'not_authorized') {
        await denied(authorized, 'catering_manual_record'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const conflicts = { state_conflict: 'CATERING_MANUAL_REVISION_CONFLICT', command_conflict: 'CATERING_MANUAL_COMMAND_CONFLICT',
        approval_unavailable: 'CATERING_MANUAL_APPROVAL_UNAVAILABLE', manual_source_unavailable: 'CATERING_MANUAL_SOURCE_UNAVAILABLE',
        already_transmitted: 'CATERING_MANUAL_ALREADY_TRANSMITTED', transmission_required: 'CATERING_MANUAL_TRANSMISSION_REQUIRED',
        terminal_conflict: 'CATERING_MANUAL_TERMINAL_CONFLICT', time_conflict: 'CATERING_MANUAL_TIME_CONFLICT',
        receipt_conflict: 'CATERING_MANUAL_RECEIPT_CONFLICT' };
      if (Object.hasOwn(conflicts, saved?.status)) throw new CateringManualConflictError(conflicts[saved.status]);
      record(saved, ['status','replayed','fact','orderState']);
      if (saved.status !== 'recorded' || typeof saved.replayed !== 'boolean') invalid();
      const normalized = normalizeCateringManualFact(saved.fact,
        { tenantId: authorized.tenantId, orderId: command.orderId, orderVersion: command.expectedOrderVersion });
      if (normalized.commandId !== command.commandId || normalized.originStateRevision !== command.expectedStateRevision
        || normalized.actorUserId !== authorized.actorUserId || normalized.actorSecurityVersion !== session.securityVersion
        || normalized.kind !== command.kind || normalized.channel !== command.channel || normalized.reference !== command.reference
        || normalized.occurredAt !== command.occurredAt
        || JSON.stringify(normalized.receipt) !== JSON.stringify(command.receipt)) invalid();
      const current = orderState(saved.orderState, command.expectedOrderVersion);
      if ((!saved.replayed && (current.revision !== command.expectedStateRevision + 1 || current.status !== normalized.status))
        || current.revision < command.expectedStateRevision + 1) invalid();
      return Object.freeze({ schemaVersion: 1, replayed: saved.replayed,
        fact: publicFact(normalized, { tenantId: authorized.tenantId, orderId: command.orderId,
          orderVersion: command.expectedOrderVersion }),
        orderState: current });
    },
  });
}
