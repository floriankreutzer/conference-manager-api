import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { cateringDeliveryJobFromRow as projection } from './catering-delivery-row.js';
import { readCateringOrderWithClient } from './catering-order-source.js';
import { lockCateringManager } from './catering-manager-session.js';
import { withPostgresTransaction } from './transaction.js';

const result = (status, extra = {}) => Object.freeze({ status, ...extra });
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_DELIVERY_IDENTIFIER_INVALID');
  return value.toLowerCase();
}
function counter(value, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('CATERING_DELIVERY_COUNTER_INVALID');
  return value;
}

export function createPostgresCateringDeliveryRepository(pool, { registry, auditRepository, idFactory = randomUUID } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  if (typeof idFactory !== 'function') throw new TypeError('ID_FACTORY_REQUIRED');
  async function load(client, tenantId, jobId) {
    const rows = await client.query({ name: 'catering-delivery-job-read',
      text: 'SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2', values: [tenantId,jobId] });
    return rows.rowCount === 0 ? null : projection(rows.rows[0], tenantId, jobId);
  }
  return Object.freeze({
    load({ tenantId, jobId }) { return load(pool, uuid(tenantId), uuid(jobId)); },
    async list({ tenantId, afterJobId = null, orderId = null }) {
      tenantId = uuid(tenantId);
      if (afterJobId !== null) afterJobId = uuid(afterJobId);
      if (orderId !== null) orderId = uuid(orderId);
      const rows = await pool.query({ name: 'catering-delivery-job-list',
        text: `SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid)
          AND ($3::uuid IS NULL OR order_id=$3::uuid) ORDER BY id LIMIT 21`, values: [tenantId,afterJobId,orderId] });
      const jobs = Object.freeze(rows.rows.slice(0, 20).map((row) => projection(row, tenantId)));
      return Object.freeze({ tenantId, jobs, nextAfterJobId: rows.rowCount > 20 ? jobs.at(-1).jobId : null });
    },
    async enqueue(value) {
      const input = { ...value, tenantId: uuid(value?.tenantId), actorUserId: uuid(value?.actorUserId),
        sessionId: uuid(value?.sessionId), correlationId: uuid(value?.correlationId), orderId: uuid(value?.orderId),
        expectedSecurityVersion: counter(value?.expectedSecurityVersion), expectedOrderVersion: counter(value?.expectedOrderVersion),
        expectedStateRevision: counter(value?.expectedStateRevision, Number.MAX_SAFE_INTEGER - 2),
        expectedQuoteRevision: counter(value?.expectedQuoteRevision) };
      if (typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_DELIVERY_AUDIT_REQUIRED');
      try {
        return await withPostgresTransaction(pool, async (client) => {
          if (!await lockCateringManager(client, input)) return result('not_authorized');
          const view = await readCateringOrderWithClient(client, {
            tenantId: input.tenantId, orderId: input.orderId, registry, lock: true });
          if (!view) return result('not_found');
          if (view.snapshot.orderVersion !== input.expectedOrderVersion) return result('order_conflict');
          const existing = await client.query({ name: 'catering-delivery-job-existing',
            text: `SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3`,
            values: [input.tenantId,input.orderId,input.expectedOrderVersion] });
          if (existing.rowCount > 1) throw new TypeError('CATERING_DELIVERY_JOB_SOURCE_INVALID');
          if (existing.rowCount === 1) {
            const job = projection(existing.rows[0], input.tenantId);
            if (job.originStateRevision !== input.expectedStateRevision || job.quoteRevision !== input.expectedQuoteRevision
              || job.integrationId !== view.snapshot.integrationId || job.operation !== view.operation) return result('already_enqueued');
            return result('enqueued', { replayed: true, job });
          }
          if (view.state.revision !== input.expectedStateRevision) return result('state_conflict');
          if (view.state.status !== 'released' || !view.quote || view.quote.expired
            || view.quote.revision !== input.expectedQuoteRevision || view.decision?.decision !== 'approved'
            || view.decision.quoteRevision !== input.expectedQuoteRevision) return result('approval_unavailable');
          const jobId = uuid(idFactory());
          const updated = await client.query({ name: 'catering-delivery-order-queue',
            text: `UPDATE catering_order_version_states SET revision=revision+1,status='queued',updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND revision=$4`,
            values: [input.tenantId,input.orderId,input.expectedOrderVersion,input.expectedStateRevision] });
          if (updated.rowCount !== 1) throw new Error('CATERING_DELIVERY_ORDER_UPDATE_FAILED');
          await client.query({ name: 'catering-delivery-job-enqueue',
            text: `INSERT INTO catering_delivery_jobs (tenant_id,id,integration_id,provider_id,order_id,order_version,operation,
              quote_revision,decision_sequence,origin_state_revision,revision,status,dispatch_attempts,reconciliation_attempts,
              available_at,created_by_user_id,correlation_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'queued',0,0,clock_timestamp(),$11,$12)`,
            values: [input.tenantId,jobId,view.snapshot.integrationId,view.providerId,input.orderId,input.expectedOrderVersion,
              view.operation,input.expectedQuoteRevision,view.decision.sequence,input.expectedStateRevision,
              input.actorUserId,input.correlationId] });
          const event = input.auditEventFor({ orderId: input.orderId, orderVersion: input.expectedOrderVersion,
            previousRevision: input.expectedStateRevision, revision: input.expectedStateRevision + 1 });
          if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId
            || event.targetType !== 'catering_order' || event.targetId !== input.orderId || event.action !== 'catering.delivery.queued'
            || event.correlationId !== input.correlationId || event.outcome !== 'success' || event.retentionClass !== 'business') {
            throw new TypeError('CATERING_DELIVERY_AUDIT_SCOPE_INVALID');
          }
          await auditRepository.appendWithClient(client, event);
          const job = await load(client, input.tenantId, jobId);
          if (!job) throw new Error('CATERING_DELIVERY_JOB_INSERT_FAILED');
          return result('enqueued', { replayed: false, job });
        });
      } catch (error) {
        if (error?.code === '23514' && error.message === 'CATERING_DELIVERY_CURRENT_APPROVAL_REQUIRED') {
          return result('approval_unavailable');
        }
        throw error;
      }
    },
  });
}
