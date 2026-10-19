import { AUDIT_ACTION } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isCateringOrderStatus } from '../domain/catering-order-state.js';
import { normalizeCateringWithdrawalCommand, normalizeCateringWithdrawalFact } from '../domain/catering-order-withdrawal.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringWithdrawalInputError, CateringWithdrawalConflictError } from './catering-withdrawal-errors.js';

function invalid() { throw new TypeError('CATERING_WITHDRAWAL_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value) { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid(); return value; }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function input(work) { try { return work(); } catch { throw new CateringWithdrawalInputError(); } }
function state(value) {
  record(value, ['orderVersion','revision','status']); if (!isCateringOrderStatus(value.status)) invalid();
  return Object.freeze({ orderVersion: count(value.orderVersion), revision: count(value.revision), status: value.status });
}
function publicFact(fact) {
  return Object.freeze({ orderId: fact.orderId, orderVersion: fact.orderVersion, previousStatus: fact.previousStatus,
    justification: fact.justification, attestNotTransmitted: true, recordedAt: fact.recordedAt });
}

export function createCateringWithdrawalService({ repository, authorizationPolicy, auditService } = {}) {
  if (!repository || !['load','withdraw'].every((key) => typeof repository[key] === 'function')
    || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService?.[key] === 'function')) {
    throw new TypeError('CATERING_WITHDRAWAL_SERVICE_PORT_REQUIRED');
  }
  async function denied(context, operation) {
    if (isInternalUuid(context?.principal?.tenantId) && context.principal.tenantId === context?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({ ...context, targetType: 'catering_order', targetId: 'catering-withdrawal',
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
      const authorized = await authorize(context, 'catering_withdrawal_read');
      const parameters = input(() => ({ orderId: uuid(context.orderId),
        orderVersion: context.orderVersion === null || context.orderVersion === undefined ? null : count(context.orderVersion) }));
      const value = await repository.load({ tenantId: authorized.tenantId, ...parameters });
      if (!value) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','orderId','orderState','eligible','effective','withdrawal']);
      if (value.tenantId !== authorized.tenantId || value.orderId !== parameters.orderId || typeof value.eligible !== 'boolean') invalid();
      const current = state(value.orderState);
      if (parameters.orderVersion !== null && current.orderVersion !== parameters.orderVersion) invalid();
      let effective = null;
      if (value.effective !== null) {
        record(value.effective, ['orderVersion','status']); if (!['confirmed','cancelled'].includes(value.effective.status)) invalid();
        effective = Object.freeze({ orderVersion: count(value.effective.orderVersion), status: value.effective.status });
      }
      const fact = value.withdrawal === null ? null : normalizeCateringWithdrawalFact(value.withdrawal,
        { tenantId: authorized.tenantId, orderId: parameters.orderId });
      if ((current.status === 'withdrawn') !== (fact !== null)
        || (fact && (current.orderVersion !== fact.orderVersion || current.revision !== fact.originStateRevision + 1))
        || (value.eligible && (fact !== null
          || !['pending_quote','pending_manager_review','released','queued','rejected'].includes(current.status)
          || (effective && (effective.orderVersion >= current.orderVersion || effective.status === 'cancelled'))))) invalid();
      return Object.freeze({ schemaVersion: 1, orderId: parameters.orderId, orderState: current,
        eligible: value.eligible, effective, withdrawal: fact === null ? null : publicFact(fact) });
    },
    async withdraw(context) {
      const authorized = await authorize(context, 'catering_order_withdraw'); const session = authorized.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      const command = input(() => normalizeCateringWithdrawalCommand({ schemaVersion: context.schemaVersion,
        commandId: context.commandId, expectedOrderVersion: context.expectedOrderVersion,
        expectedStateRevision: context.expectedStateRevision,
        justification: context.justification, attestNotTransmitted: context.attestNotTransmitted }, { orderId: context.orderId }));
      const saved = await repository.withdraw({ ...authorized, ...command, sessionId: uuid(session.id),
        expectedSecurityVersion: session.securityVersion, auditEventFor(values) {
          if (values.orderId !== command.orderId || values.orderVersion !== command.expectedOrderVersion
            || values.previousRevision !== command.expectedStateRevision || values.revision !== command.expectedStateRevision + 1
            || !['pending_quote','pending_manager_review','released','rejected','queued'].includes(values.previousStatus)) invalid();
          return auditService.createEvent({ ...authorized, action: AUDIT_ACTION.CATERING_ORDER_WITHDRAWN,
            targetType: 'catering_order', targetId: command.orderId, outcome: 'success', retentionClass: 'business',
            previousState: { version: command.expectedOrderVersion, revision: command.expectedStateRevision,
              status: values.previousStatus },
            newState: { version: command.expectedOrderVersion, revision: values.revision, status: 'withdrawn' },
            metadata: { operation: 'catering_order_withdraw', attestNotTransmitted: true } });
        } });
      if (saved?.status === 'not_authorized') {
        await denied(authorized, 'catering_order_withdraw'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const conflicts = { state_conflict: 'CATERING_WITHDRAWAL_REVISION_CONFLICT', command_conflict: 'CATERING_WITHDRAWAL_COMMAND_CONFLICT',
        source_unavailable: 'CATERING_WITHDRAWAL_SOURCE_UNAVAILABLE' };
      if (Object.hasOwn(conflicts, saved?.status)) throw new CateringWithdrawalConflictError(conflicts[saved.status]);
      record(saved, ['status','replayed','withdrawal','orderState']);
      if (saved.status !== 'withdrawn' || typeof saved.replayed !== 'boolean') invalid();
      const fact = normalizeCateringWithdrawalFact(saved.withdrawal, { tenantId: authorized.tenantId, orderId: command.orderId });
      const current = state(saved.orderState);
      if (fact.orderVersion !== command.expectedOrderVersion || fact.originStateRevision !== command.expectedStateRevision
        || fact.commandId !== command.commandId || fact.justification !== command.justification
        || fact.actorUserId !== authorized.actorUserId || fact.actorSecurityVersion !== session.securityVersion
        || current.orderVersion !== command.expectedOrderVersion || current.revision !== command.expectedStateRevision + 1
        || current.status !== 'withdrawn') invalid();
      return Object.freeze({ schemaVersion: 1, replayed: saved.replayed, withdrawal: publicFact(fact), orderState: current });
    },
  });
}
