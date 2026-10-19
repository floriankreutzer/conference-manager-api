import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringDeliveryJob } from '../../domain/catering-delivery-job.js';
import { cateringOrderStateFromReceipt } from '../../domain/catering-receipt-state.js';
import { cateringDeliveryJobFromRow as projection } from './catering-delivery-row.js';
import { normalizeCateringReceipt } from '../../integrations/catering-contract.js';
import { readCateringOrderWithClient } from './catering-order-source.js';
import { withPostgresTransaction } from './transaction.js';

const DUE = `(status IN ('queued','retry_wait') AND available_at<=clock_timestamp())
  OR (status='reconciliation_required' AND reconciliation_attempts<10 AND available_at<=clock_timestamp())
  OR (status IN ('leased','dispatching','reconciling') AND lease_expires_at<=clock_timestamp())`;
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_JOB_IDENTIFIER_INVALID');
  return value.toLowerCase();
}

export function createPostgresCateringJobRepository(pool, {
  registry, auditRepository, auditService, idFactory = randomUUID, leaseMs = 30000,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!registry || typeof registry.get !== 'function' || !auditRepository || typeof auditRepository.appendWithClient !== 'function'
    || !auditService || typeof auditService.createActorEvent !== 'function' || typeof idFactory !== 'function'
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000) {
    throw new TypeError('CATERING_JOB_PERSISTENCE_PORT_REQUIRED');
  }
  async function audit(client, row, action, previousStatus, status) {
    const event = auditService.createActorEvent({ tenantId: uuid(row.tenant_id), actorUserId: null,
      correlationId: uuid(idFactory()), action, targetType: 'catering_order', targetId: uuid(row.order_id),
      previousState: { status: previousStatus }, newState: { status }, outcome: 'success', retentionClass: 'business',
      metadata: { operation: 'catering_job_processing' } });
    if (event.tenantId !== row.tenant_id || event.actorUserId !== null || event.action !== action
      || event.targetId !== row.order_id || event.targetType !== 'catering_order' || event.outcome !== 'success'
      || event.retentionClass !== 'business') throw new TypeError('CATERING_JOB_AUDIT_SCOPE_INVALID');
    await auditRepository.appendWithClient(client, event);
  }
  async function tenantLock(client, tenantId) {
    const rows = await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    return rows.rowCount === 1;
  }
  async function locked(client, input, status) {
    const tenantId = uuid(input?.job?.tenantId); const jobId = uuid(input?.job?.jobId); const leaseId = uuid(input?.leaseId);
    const expected = normalizeCateringDeliveryJob(input.job, { tenantId, jobId });
    if (!await tenantLock(client, tenantId)) return null;
    const rows = await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_live
      ,catering_order_delivery_operation(tenant_id,order_id,order_version) AS delivery_operation
      FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId,jobId]);
    if (rows.rowCount !== 1) return null;
    const row = rows.rows[0];
    if (!row.lease_live || row.lease_id !== leaseId || row.status !== status || Number(row.order_version) !== input.job.orderVersion
      || row.order_id !== input.job.orderId || row.integration_id !== input.job.integrationId || row.operation !== input.job.operation
      || row.provider_id !== input.providerId || Number(row.quote_revision) !== input.job.quoteRevision
      || row.delivery_operation !== (input.deliveryOperation ?? input.job.operation)
      || Number(row.decision_sequence) !== input.job.decisionSequence) return null;
    const expectedRevision = expected.revision + (status === 'dispatching' ? 1 : 0);
    if (Number(row.revision) !== expectedRevision || (status === 'dispatching' && row.dispatch_attempts !== input.attempt)
      || (status === 'reconciling' && row.reconciliation_attempts !== expected.automaticReconciliationAttempts)) return null;
    return row;
  }
  async function currentMode(client, row, reading = false) {
    const configured = await client.query(`SELECT CASE WHEN $4::boolean THEN configuration.status_mode ELSE
      CASE catering_order_delivery_operation($1,$3,$6::bigint) WHEN 'initial' THEN configuration.order_mode
        WHEN 'cancel' THEN configuration.cancel_mode
        ELSE configuration.update_mode END END AS mode FROM catering_integration_configurations configuration
      JOIN integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      JOIN tenants tenant ON tenant.id=integration.tenant_id AND tenant.status='active'
      WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2 AND integration.provider=$5
        AND integration.status IN ('configured','active')`,
    [row.tenant_id,row.integration_id,row.order_id,reading,row.provider_id,Number(row.order_version)]);
    const mode = configured.rows[0]?.mode ?? 'unsupported';
    if (!['api','manual','unsupported'].includes(mode)) throw new TypeError('CATERING_JOB_MODE_INVALID');
    return mode;
  }
  async function defer(client, row) {
    await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='deferred',lease_id=NULL,
      lease_expires_at=NULL,lease_manual=false,available_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
    [row.tenant_id,row.id]);
    await audit(client, row, 'catering.delivery.deferred', row.status, 'deferred');
    return 'deferred';
  }
  async function unavailable(client, row, reconciling) {
    if (!reconciling) return Object.freeze({ kind: 'resolved', status: await defer(client, row) });
    await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,available_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2 AND status='reconciliation_required'`, [row.tenant_id,row.id]);
    await audit(client, row, 'catering.delivery.deferred', 'reconciliation_required', 'reconciliation_required');
    return Object.freeze({ kind: 'resolved', status: 'reconciliation_required' });
  }
  async function orderStatus(client, row, status) {
    await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND status IN ('queued','dispatching','reconciliation_required')`,
    [row.tenant_id,row.order_id,row.order_version,status]);
  }
  async function authorityForClaim(client, row) {
    // A known failed write is a fact even after approval expires. A retry may
    // restore queued only inside this savepoint and the same approved source.
    // The old schema's deferred authority guard also rechecks at claim commit.
    const retry = row.status === 'retry_wait';
    if (retry) {
      await client.query('SAVEPOINT catering_retry_authority');
      await client.query(`UPDATE catering_order_version_states state SET revision=revision+1,status='queued',
        updated_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND status='failed'
        AND revision<9007199254740990 AND EXISTS (SELECT 1 FROM catering_delivery_observations observation
          WHERE observation.tenant_id=$1 AND observation.job_id=$4 AND observation.sequence=$5
            AND observation.outcome='not_sent' AND observation.retryable=true)`,
      [row.tenant_id,row.order_id,row.order_version,row.id,row.last_observation]);
    }
    const authority = await client.query(`SELECT catering_delivery_authority_current(job) AS eligible
      FROM catering_delivery_jobs job WHERE tenant_id=$1 AND id=$2`, [row.tenant_id,row.id]);
    const eligible = authority.rows[0]?.eligible === true;
    if (retry) {
      if (!eligible) await client.query('ROLLBACK TO SAVEPOINT catering_retry_authority');
      await client.query('RELEASE SAVEPOINT catering_retry_authority');
    }
    return eligible;
  }
  async function recover(client, row) {
    if (row.status === 'leased') {
      await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='queued',lease_id=NULL,lease_manual=false,
        lease_expires_at=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id,row.id]);
      await audit(client, row, 'catering.delivery.recovered', 'leased', 'queued');
    } else {
      const sequence = Number(row.last_observation ?? 0) + 1;
      await client.query(`INSERT INTO catering_delivery_observations
        (tenant_id,job_id,sequence,attempt,lease_id,kind,outcome,retryable,failure_code,correlation_id)
        VALUES ($1,$2,$3,$4,$5,'recovery','unknown',false,'lease_expired',$6)`,
      [row.tenant_id,row.id,sequence,row.dispatch_attempts,row.lease_id,uuid(idFactory())]);
      await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='reconciliation_required',
        last_observation=$3,lease_id=NULL,lease_expires_at=NULL,lease_manual=false,
        available_at=CASE WHEN reconciliation_attempts<10 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id,row.id,sequence]);
      await orderStatus(client, row, 'reconciliation_required');
      await audit(client, row, 'catering.delivery.recovered', row.status, 'reconciliation_required');
    }
    return (await client.query('SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2',
      [row.tenant_id,row.id])).rows[0];
  }
  return Object.freeze({
    async claimNext() {
      return withPostgresTransaction(pool, async (client) => {
        // Tenant first, then scoped job: the same order as foreground enqueue and
        // audit/configuration writers. SKIP LOCKED never waits on another worker.
        const tenants = await client.query(`SELECT tenant.id FROM tenants tenant WHERE EXISTS
          (SELECT 1 FROM catering_delivery_jobs WHERE tenant_id=tenant.id AND (${DUE}))
          ORDER BY tenant.id LIMIT 1 FOR UPDATE OF tenant SKIP LOCKED`);
        if (tenants.rowCount === 0) return null;
        const selected = await client.query(`SELECT *,lease_expires_at<=clock_timestamp() AS expired
          FROM catering_delivery_jobs WHERE tenant_id=$1 AND (${DUE})
          ORDER BY coalesce(lease_expires_at,available_at),id LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenants.rows[0].id]);
        if (selected.rowCount === 0) return null;
        let row = selected.rows[0];
        if (row.expired) row = await recover(client, row);
        const reconciling = row.status === 'reconciliation_required';
        if (reconciling && (row.reconciliation_attempts >= 10 || row.available_at === null)) {
          return Object.freeze({ kind: 'resolved', status: 'reconciliation_required' });
        }
        if (!reconciling) {
          if (!await authorityForClaim(client, row)) return unavailable(client, row, false);
        }
        let descriptor;
        try { descriptor = registry.get(row.provider_id); } catch { return unavailable(client, row, reconciling); }
        const mode = await currentMode(client, row, reconciling);
        if (mode !== 'api') return unavailable(client, row, reconciling);
        let source;
        try {
          source = await readCateringOrderWithClient(client, { tenantId: row.tenant_id, orderId: row.order_id,
            version: Number(row.order_version), registry });
          if (!source || source.snapshot.integrationId !== row.integration_id || source.providerId !== descriptor.id
            || source.quote?.revision !== Number(row.quote_revision)) throw new TypeError('CATERING_JOB_SOURCE_INVALID');
        } catch (error) {
          if (error instanceof TypeError) return unavailable(client, row, reconciling);
          throw error;
        }
        const token = uuid(idFactory());
        const updated = await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status=$3::varchar,
          lease_id=$4,lease_expires_at=clock_timestamp()+make_interval(secs=>$6::double precision/1000),
          lease_manual=false,available_at=NULL,
          reconciliation_attempts=reconciliation_attempts+$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [row.tenant_id,row.id,reconciling ? 'reconciling' : 'leased',token,reconciling ? 1 : 0,leaseMs]);
        await audit(client, row, 'catering.delivery.claimed', row.status, reconciling ? 'reconciling' : 'leased');
        return Object.freeze({ kind: reconciling ? 'reconcile' : 'dispatch', job: projection(updated.rows[0]), leaseId: token,
          ...(source.deliveryOperation === undefined ? {} : { deliveryOperation: source.deliveryOperation }),
          providerId: descriptor.id, mode, snapshot: source.snapshot,
          quote: Object.freeze({ revision: source.quote.revision, cost: source.quote.cost }) });
      });
    },
    async defer(input) {
      return withPostgresTransaction(pool, async (client) => {
        const row = await locked(client, input, 'leased'); return row ? defer(client, row) : 'obsolete';
      });
    },
    async beginDispatch(input) {
      return withPostgresTransaction(pool, async (client) => {
        const row = await locked(client, input, 'leased'); if (!row) return null;
        const authority = await client.query(`SELECT catering_delivery_authority_current(job) AS eligible
          FROM catering_delivery_jobs job WHERE tenant_id=$1 AND id=$2`, [row.tenant_id,row.id]);
        if (authority.rows[0]?.eligible !== true || await currentMode(client, row) !== 'api') {
          await defer(client, row); return null;
        }
        const attempt = row.dispatch_attempts + 1;
        await client.query(`INSERT INTO catering_delivery_attempts (tenant_id,job_id,attempt,lease_id,correlation_id)
          VALUES ($1,$2,$3,$4,$5)`, [row.tenant_id,row.id,attempt,row.lease_id,uuid(idFactory())]);
        await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='dispatching',dispatch_attempts=$3,
          updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [row.tenant_id,row.id,attempt]);
        await orderStatus(client, row, 'dispatching');
        await audit(client, row, 'catering.delivery.attempted', 'leased', 'dispatching');
        return Object.freeze({ lease: input, attempt });
      });
    },
    async finish(input) {
      const candidate = input?.lease;
      const kind = candidate?.kind === 'dispatch' ? 'dispatch' : candidate?.kind === 'reconcile' ? 'reconcile' : null;
      if (!kind || !['transmitted','not_sent','rejected','unknown'].includes(input.outcome)
        || !['succeeded','failed','retry_wait','reconciliation_required'].includes(input.status)
        || typeof input.retryable !== 'boolean' || !['none','timeout','throttled','unavailable','authorization',
          'validation','response_invalid','unknown'].includes(input.failureCode)
        || (input.delayMs !== null && (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 304000))) {
        throw new TypeError('CATERING_JOB_OBSERVATION_INVALID');
      }
      if ((input.outcome === 'transmitted') !== (input.status === 'succeeded')
        || (input.outcome === 'unknown') !== (input.status === 'reconciliation_required')
        || (input.outcome === 'transmitted') !== (input.failureCode === 'none')
        || (input.retryable && input.outcome !== 'not_sent')
        || (input.status === 'retry_wait' && (input.outcome !== 'not_sent' || !input.retryable || input.delayMs === null))
        || (input.delayMs !== null && !['retry_wait','reconciliation_required'].includes(input.status))
        || (kind === 'reconcile' && !['transmitted','unknown'].includes(input.outcome))) {
        throw new TypeError('CATERING_JOB_OBSERVATION_INVALID');
      }
      return withPostgresTransaction(pool, async (client) => {
        const row = await locked(client, candidate, kind === 'dispatch' ? 'dispatching' : 'reconciling');
        if (!row) return 'obsolete';
        let receipt = null; let status = input.outcome === 'unknown' ? 'reconciliation_required' : input.status;
        let businessStatus = status === 'reconciliation_required' ? status : 'failed';
        if (input.outcome === 'transmitted') {
          const positions = await client.query(`SELECT position_id FROM catering_order_positions
            WHERE tenant_id=$1 AND order_id=$2 AND version=$3 ORDER BY position_id LIMIT 102`,
          [row.tenant_id,row.order_id,row.order_version]);
          const normalized = normalizeCateringReceipt(input.receipt, { orderId: row.order_id, orderVersion: Number(row.order_version),
            positionIds: positions.rows.map((position) => position.position_id) });
          const { counts, ...value } = normalized; receipt = value; status = 'succeeded';
          businessStatus = cateringOrderStateFromReceipt({ operation: row.operation,
            positionCount: normalized.positions.length, counts });
        } else if (input.receipt !== null) throw new TypeError('CATERING_JOB_OBSERVATION_INVALID');
        const sequence = Number(row.last_observation ?? 0) + 1;
        await client.query(`INSERT INTO catering_delivery_observations
          (tenant_id,job_id,sequence,attempt,lease_id,kind,outcome,retryable,failure_code,receipt,correlation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [row.tenant_id,row.id,sequence,row.dispatch_attempts,row.lease_id,kind,input.outcome,input.retryable,
          input.failureCode,receipt === null ? null : JSON.stringify(receipt),uuid(idFactory())]);
        await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status=$3::varchar,last_observation=$4,
          lease_id=NULL,lease_expires_at=NULL,lease_manual=false,available_at=CASE WHEN $5::integer IS NULL THEN NULL
            ELSE clock_timestamp()+make_interval(secs=>$5::double precision/1000) END,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`, [row.tenant_id,row.id,status,sequence,input.delayMs]);
        await orderStatus(client, row, businessStatus);
        await audit(client, row, 'catering.delivery.observed', row.status, status);
        return status;
      });
    },
  });
}
