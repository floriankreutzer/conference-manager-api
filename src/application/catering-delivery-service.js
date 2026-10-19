import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringDeliveryJob } from '../domain/catering-delivery-job.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringDeliveryInputError, CateringDeliveryConflictError } from './catering-delivery-errors.js';

function invalid() { throw new TypeError('CATERING_DELIVERY_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function counter(value, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function input(work) { try { return work(); } catch { throw new CateringDeliveryInputError(); } }
function publicJob(value, tenantId, jobId = null) {
  const { tenantId: _tenantId, originStateRevision: _origin, ...job } = normalizeCateringDeliveryJob(value, { tenantId, jobId });
  return Object.freeze(job);
}

export function createCateringDeliveryService({ repository, authorizationPolicy, auditService } = {}) {
  if (!repository || !['load','list','enqueue'].every((key) => typeof repository[key] === 'function')) {
    throw new TypeError('CATERING_DELIVERY_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService[key] === 'function')) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  async function denied(context, operation) {
    if (isInternalUuid(context?.principal?.tenantId) && context.principal.tenantId === context?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({ ...context, targetType: 'catering_order', targetId: 'catering-delivery-jobs',
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
      const authorized = await authorize(context, 'catering_delivery_read');
      const jobId = input(() => uuid(context.jobId));
      const value = await repository.load({ tenantId: authorized.tenantId, jobId });
      if (!value) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return Object.freeze({ schemaVersion: 1, job: publicJob(value, authorized.tenantId, jobId) });
    },
    async list(context) {
      const authorized = await authorize(context, 'catering_delivery_list');
      const afterJobId = input(() => context.afterJobId == null ? null : uuid(context.afterJobId));
      const orderId = input(() => context.orderId == null ? null : uuid(context.orderId));
      const page = await repository.list({ tenantId: authorized.tenantId, afterJobId, orderId });
      record(page, ['tenantId','jobs','nextAfterJobId']);
      if (page.tenantId !== authorized.tenantId || !Array.isArray(page.jobs)
        || Object.getPrototypeOf(page.jobs) !== Array.prototype || page.jobs.length > 20
        || Reflect.ownKeys(page.jobs).length !== page.jobs.length + 1) invalid();
      let previous = afterJobId;
      const jobs = [];
      for (let index = 0; index < page.jobs.length; index++) {
        const property = Object.getOwnPropertyDescriptor(page.jobs, String(index));
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
        const job = publicJob(property.value, authorized.tenantId);
        if ((previous !== null && job.jobId <= previous) || (orderId !== null && job.orderId !== orderId)) invalid();
        previous = job.jobId; jobs.push(job);
      }
      const next = page.nextAfterJobId === null ? null : uuid(page.nextAfterJobId);
      if (next !== null && (jobs.length !== 20 || next !== previous)) invalid();
      return Object.freeze({ schemaVersion: 1, jobs: Object.freeze(jobs), nextAfterJobId: next });
    },
    async enqueue(context) {
      const authorized = await authorize(context, 'catering_delivery_enqueue');
      const session = authorized.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      const command = input(() => {
        if (context.schemaVersion !== 1) invalid();
        return { orderId: uuid(context.orderId), expectedOrderVersion: counter(context.expectedOrderVersion),
          expectedStateRevision: counter(context.expectedStateRevision, Number.MAX_SAFE_INTEGER - 2),
          expectedQuoteRevision: counter(context.expectedQuoteRevision) };
      });
      const saved = await repository.enqueue({ ...authorized, ...command, sessionId: uuid(session.id),
        expectedSecurityVersion: session.securityVersion,
        auditEventFor(values) {
          return auditService.createEvent({ ...authorized, action: AUDIT_ACTION.CATERING_DELIVERY_QUEUED,
            targetType: 'catering_order', targetId: uuid(values.orderId), previousState: {
              revision: values.previousRevision, status: 'released' },
            newState: { revision: values.revision, status: 'queued', version: values.orderVersion },
            outcome: AUDIT_OUTCOME.SUCCESS, retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
            metadata: { operation: 'catering_delivery_enqueue' } });
        } });
      if (saved?.status === 'not_authorized') {
        await denied(authorized, 'catering_delivery_enqueue'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const conflicts = { state_conflict: 'CATERING_DELIVERY_REVISION_CONFLICT', order_conflict: 'CATERING_DELIVERY_ORDER_CHANGED',
        already_enqueued: 'CATERING_DELIVERY_ALREADY_ENQUEUED', approval_unavailable: 'CATERING_DELIVERY_APPROVAL_UNAVAILABLE' };
      if (Object.hasOwn(conflicts, saved?.status)) throw new CateringDeliveryConflictError(conflicts[saved.status]);
      record(saved, ['status','replayed','job']);
      if (saved.status !== 'enqueued' || typeof saved.replayed !== 'boolean') invalid();
      const normalized = normalizeCateringDeliveryJob(saved.job, { tenantId: authorized.tenantId });
      if (normalized.orderId !== command.orderId || normalized.orderVersion !== command.expectedOrderVersion
        || normalized.originStateRevision !== command.expectedStateRevision || normalized.quoteRevision !== command.expectedQuoteRevision
        || (!saved.replayed && (normalized.revision !== 1 || normalized.status !== 'queued' || normalized.dispatchAttempts !== 0
          || normalized.automaticReconciliationAttempts !== 0))) invalid();
      return Object.freeze({ schemaVersion: 1, replayed: saved.replayed, job: publicJob(normalized, authorized.tenantId) });
    },
  });
}
