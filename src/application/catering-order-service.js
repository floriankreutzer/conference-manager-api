import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { normalizeCateringOrderTotal } from '../domain/catering-order-money.js';
import { normalizeCateringOrderSnapshot } from '../domain/catering-order-snapshot-value.js';
import { isCateringOrderStatus, capabilityForCateringOrderOperation } from '../domain/catering-order-state.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringOrderConflictError, CateringOrderInputError } from './catering-order-errors.js';

function invalid() { throw new TypeError('CATERING_ORDER_RESULT_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function counter(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function input(work) { try { return work(); } catch { throw new CateringOrderInputError(); } }
function schema(value) { if (value !== 1) invalid(); }
function reference(value) {
  record(value, ['orderId','integrationId','version','stateRevision','status']);
  if (!isCateringOrderStatus(value.status)) invalid();
  return Object.freeze({ orderId: uuid(value.orderId), integrationId: uuid(value.integrationId),
    orderVersion: counter(value.version), stateRevision: counter(value.stateRevision), status: value.status });
}
function references(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  const normalized = value.map(reference);
  if (new Set(normalized.map((entry) => entry.orderId)).size !== normalized.length) invalid();
  return Object.freeze(normalized);
}

export function createCateringOrderService({ repository, registry, authorizationPolicy, auditService, clock = Date.now } = {}) {
  if (!repository || !['load','list','prepare','recordQuote','decide'].every((name) => typeof repository[name] === 'function')) {
    throw new TypeError('CATERING_ORDER_REPOSITORY_REQUIRED');
  }
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || !['createEvent','recordAuthorizationDenied'].every((name) => typeof auditService[name] === 'function')) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');
  async function deny(context, operation) {
    if (!isInternalUuid(context?.principal?.tenantId) || context.principal.tenantId !== context?.tenantContext?.tenantId) return;
    await auditService.recordAuthorizationDenied({ ...context, targetType: 'catering_order', targetId: 'catering-orders',
      metadata: { operation } });
  }
  async function authorize(context, operation) {
    uuid(context?.correlationId);
    try { authorizationPolicy.requireTenantPermission(context?.principal, context?.tenantContext, PERMISSION.REQUEST_MANAGE); }
    catch (error) { if (error instanceof AuthorizationDeniedError) await deny(context, operation); throw error; }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    const tenantId = uuid(context.tenantContext.tenantId);
    return { principal: { ...context.principal, tenantId, userId: uuid(context.principal.userId) },
      tenantContext: { ...context.tenantContext, tenantId }, correlationId: uuid(context.correlationId) };
  }
  async function writeContext(context, operation, action) {
    const authorized = await authorize(context, operation);
    const session = authorized.principal.session;
    if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session?.securityVersion) || session.securityVersion < 1
      || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TypeError('CLOCK_INVALID');
    return { ...authorized, tenantId: authorized.tenantContext.tenantId, actorUserId: authorized.principal.userId,
      sessionId: uuid(session.id), expectedSecurityVersion: session.securityVersion, changedAt: new Date(now),
      auditEventFor(values) {
        return auditService.createEvent({ ...authorized, action, targetType: 'catering_order', targetId: uuid(values.orderId),
          previousState: { revision: values.previousRevision }, newState: {
            version: values.version, revision: values.revision, status: values.status,
            ...(values.quoteRevision === undefined ? {} : { quoteRevision: values.quoteRevision,
              amountMinor: values.amountMinor, currency: values.currency }),
          }, outcome: AUDIT_OUTCOME.SUCCESS, retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
          metadata: { operation, ...(values.requestVersion === undefined ? {} : {
            requestVersion: values.requestVersion, assignmentRevision: values.assignmentRevision,
            catalogueRevision: values.catalogueRevision, configurationRevision: values.configurationRevision,
            positionCount: values.positionCount,
          }), ...(values.decision === undefined ? {} : { decision: values.decision }) } });
      } };
  }
  async function outcome(value, authorized, operation, success) {
    if (value?.status === success) return value;
    if (value?.status === 'not_authorized') {
      await deny(authorized, operation);
      throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
    }
    if (value?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
    const codes = { state_conflict: 'CATERING_ORDER_REVISION_CONFLICT', request_conflict: 'CATERING_ORDER_REQUEST_CHANGED',
      assignment_conflict: 'CATERING_ORDER_ASSIGNMENT_CHANGED', already_prepared: 'CATERING_ORDER_ALREADY_PREPARED',
      connection_unavailable: 'CATERING_ORDER_CONNECTION_UNAVAILABLE', no_catering: 'CATERING_ORDER_EMPTY',
      quote_conflict: 'CATERING_ORDER_QUOTE_UNAVAILABLE', quote_expired: 'CATERING_ORDER_QUOTE_EXPIRED',
      conference_started: 'CATERING_ORDER_SCHEDULE_PASSED',
      approval_unavailable: 'CATERING_ORDER_QUOTE_UNAVAILABLE', manual_quote_not_supported: 'CATERING_ORDER_MANUAL_QUOTE_UNSUPPORTED',
      delivery_in_progress: 'CATERING_ORDER_DELIVERY_IN_PROGRESS', revision_exhausted: 'CATERING_ORDER_REVISION_EXHAUSTED' };
    if (!Object.hasOwn(codes, value?.status)) invalid();
    throw new CateringOrderConflictError(codes[value.status], value.currentRevision ?? null);
  }
  function publicView(value, tenantId, orderId) {
    const extended = value !== null && typeof value === 'object' && Object.hasOwn(value, 'deliveryOperation');
    record(value, ['tenantId','snapshot','providerId','configurationRevision','operation','state','quote','decision',
      ...(extended ? ['deliveryOperation'] : [])]);
    if (value.tenantId !== tenantId || registry.get(value.providerId).id !== value.providerId) invalid();
    const normalized = normalizeCateringOrderSnapshot(value.snapshot, { tenantId, orderId });
    const { tenantId: _tenantId, ...snapshot } = normalized;
    capabilityForCateringOrderOperation(value.operation);
    if (extended && (value.deliveryOperation !== 'initial' || value.operation !== 'change' || snapshot.orderVersion < 2)) invalid();
    record(value.state, ['revision','status','updatedAt']);
    if (!isCateringOrderStatus(value.state.status)) invalid();
    let quote = null;
    if (value.quote !== null) {
      record(value.quote, ['revision','cost','expiresAt','expired']);
      if (typeof value.quote.expired !== 'boolean') invalid();
      quote = Object.freeze({ revision: counter(value.quote.revision), cost: normalizeCateringOrderTotal(value.quote.cost),
        expiresAt: instant(value.quote.expiresAt), expired: value.quote.expired });
    }
    let decision = null;
    if (value.decision !== null) {
      record(value.decision, ['sequence','decision','quoteRevision','cost','deciderUserId','securityVersion']);
      if (!['approved','rejected'].includes(value.decision.decision)) invalid();
      uuid(value.decision.deciderUserId); counter(value.decision.securityVersion);
      const cost = normalizeCateringOrderTotal(value.decision.cost);
      if (!quote || value.decision.quoteRevision !== quote.revision || cost.amountMinor !== quote.cost.amountMinor
        || cost.currency !== quote.cost.currency) invalid();
      decision = Object.freeze({ sequence: counter(value.decision.sequence), decision: value.decision.decision,
        quoteRevision: quote.revision, cost });
    }
    return Object.freeze({ schemaVersion: extended ? 2 : 1, order: Object.freeze(snapshot), providerId: value.providerId,
      ...(extended ? { deliveryOperation: value.deliveryOperation } : {}),
      configurationRevision: counter(value.configurationRevision), operation: value.operation,
      state: Object.freeze({ revision: counter(value.state.revision), status: value.state.status,
        updatedAt: instant(value.state.updatedAt) }),
      quote, decision });
  }
  return Object.freeze({
    async load(context) {
      const authorized = await authorize(context, 'catering_order_read');
      const orderId = input(() => uuid(context.orderId));
      const orderVersion = input(() => context.orderVersion == null ? null : counter(context.orderVersion));
      const view = await repository.load({ tenantId: authorized.tenantContext.tenantId, orderId, orderVersion });
      if (!view) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const current = publicView(view, authorized.tenantContext.tenantId, orderId);
      if (orderVersion !== null && current.order.orderVersion !== orderVersion) invalid();
      return current;
    },
    async list(context) {
      const authorized = await authorize(context, 'catering_order_list');
      const after = input(() => context.afterOrderId == null ? null : uuid(context.afterOrderId));
      const requestId = input(() => {
        if (context.requestId == null) return null;
        if (!isRequestId(context.requestId)) invalid();
        return context.requestId;
      });
      const page = await repository.list({ tenantId: authorized.tenantContext.tenantId, afterOrderId: after, requestId });
      record(page, ['tenantId','items','nextAfterOrderId']);
      if (page.tenantId !== authorized.tenantContext.tenantId) invalid();
      const items = references(page.items, 20);
      let previous = after;
      for (const item of items) { if (previous !== null && item.orderId <= previous) invalid(); previous = item.orderId; }
      const next = page.nextAfterOrderId === null ? null : uuid(page.nextAfterOrderId);
      if (next !== null && (items.length !== 20 || next !== previous)) invalid();
      return Object.freeze({ schemaVersion: 1, orders: items, nextAfterOrderId: next });
    },
    async prepare(context) {
      const authorized = await writeContext(context, 'catering_order_prepare', AUDIT_ACTION.CATERING_ORDER_PREPARED);
      const command = input(() => {
        schema(context.schemaVersion);
        if (!isRequestId(context.requestId)) invalid();
        return { requestId: context.requestId, commandId: uuid(context.commandId),
          expectedRequestVersion: counter(context.expectedRequestVersion),
          expectedAssignmentRevision: counter(context.expectedAssignmentRevision) };
      });
      const saved = await outcome(await repository.prepare({ ...authorized, ...command }), authorized,
        'catering_order_prepare', 'prepared');
      record(saved, ['status','tenantId','replayed','orders']);
      if (saved.tenantId !== authorized.tenantId || typeof saved.replayed !== 'boolean') invalid();
      const orders = references(saved.orders, 101);
      if (orders.length === 0 || new Set(orders.map((entry) => entry.integrationId)).size !== orders.length) invalid();
      if (!saved.replayed && orders.some((entry) => entry.orderVersion !== 1 || entry.stateRevision !== 1
        || entry.status !== 'pending_quote')) invalid();
      return Object.freeze({ schemaVersion: 1, requestId: command.requestId, requestVersion: command.expectedRequestVersion,
        assignmentRevision: command.expectedAssignmentRevision, replayed: saved.replayed, orders });
    },
    async recordQuote(context) {
      const authorized = await writeContext(context, 'catering_order_quote', AUDIT_ACTION.CATERING_ORDER_QUOTED);
      const command = input(() => {
        schema(context.schemaVersion);
        return { orderId: uuid(context.orderId), expectedOrderVersion: counter(context.expectedOrderVersion ?? 1),
          expectedStateRevision: counter(context.expectedStateRevision, 1, Number.MAX_SAFE_INTEGER - 2),
          expectedQuoteRevision: counter(context.expectedQuoteRevision, 0, Number.MAX_SAFE_INTEGER - 2),
          cost: normalizeCateringOrderTotal(context.cost), expiresAt: instant(context.expiresAt) };
      });
      const saved = await outcome(await repository.recordQuote({ ...authorized, ...command }), authorized,
        'catering_order_quote', 'quoted');
      const current = publicView(saved.current, authorized.tenantId, command.orderId);
      if (current.order.orderVersion !== command.expectedOrderVersion
        || current.state.revision !== command.expectedStateRevision + 1 || current.state.status !== 'pending_manager_review'
        || current.quote?.revision !== command.expectedQuoteRevision + 1 || current.decision !== null
        || current.quote.cost.amountMinor !== command.cost.amountMinor || current.quote.cost.currency !== command.cost.currency
        || current.quote.expiresAt !== command.expiresAt) invalid();
      return current;
    },
    async decide(context) {
      const authorized = await writeContext(context, 'catering_order_decide', AUDIT_ACTION.CATERING_ORDER_DECIDED);
      const command = input(() => {
        schema(context.schemaVersion);
        if (!['approved','rejected'].includes(context.decision)) invalid();
        return { orderId: uuid(context.orderId), expectedOrderVersion: counter(context.expectedOrderVersion ?? 1),
          expectedStateRevision: counter(context.expectedStateRevision, 1, Number.MAX_SAFE_INTEGER - 2),
          expectedQuoteRevision: counter(context.expectedQuoteRevision), decision: context.decision };
      });
      const saved = await outcome(await repository.decide({ ...authorized, ...command }), authorized, 'catering_order_decide', 'decided');
      if (saved.current?.decision?.deciderUserId !== authorized.actorUserId
        || saved.current?.decision?.securityVersion !== authorized.expectedSecurityVersion) invalid();
      const current = publicView(saved.current, authorized.tenantId, command.orderId);
      if (current.order.orderVersion !== command.expectedOrderVersion
        || current.state.revision !== command.expectedStateRevision + 1
        || current.state.status !== (command.decision === 'approved' ? 'released' : 'rejected')
        || current.quote?.revision !== command.expectedQuoteRevision || current.decision?.decision !== command.decision
        || current.decision.quoteRevision !== command.expectedQuoteRevision) invalid();
      return current;
    },
  });
}
