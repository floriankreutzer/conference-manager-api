import { isInternalUuid } from '../../domain/identifiers.js';
import { cateringOrderWithdrawalEligibility, normalizeCateringWithdrawalCommand,
  normalizeCateringWithdrawalFact } from '../../domain/catering-order-withdrawal.js';
import { lockCateringManager } from './catering-manager-session.js';
import { readCateringOrderWithClient } from './catering-order-source.js';
import { readEffectiveCateringVersionWithClient } from './catering-effective-version.js';
import { withPostgresTransaction } from './transaction.js';

const result = (status, extra = {}) => Object.freeze({ status, ...extra });
function uuid(value) { if (!isInternalUuid(value)) throw new TypeError('CATERING_WITHDRAWAL_SCOPE_INVALID'); return value.toLowerCase(); }
function count(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_WITHDRAWAL_COUNTER_INVALID');
  }
  return value;
}
function fact(row) {
  return normalizeCateringWithdrawalFact({ tenantId: row.tenant_id, orderId: row.order_id, orderVersion: Number(row.order_version),
    commandId: row.command_id, originStateRevision: Number(row.origin_state_revision), previousStatus: row.previous_status,
    quoteRevision: row.prior_quote_revision === null ? null : Number(row.prior_quote_revision),
    decisionSequence: row.prior_decision_sequence === null ? null : Number(row.prior_decision_sequence),
    jobId: row.job_id, jobRevision: row.job_revision === null ? null : Number(row.job_revision), justification: row.justification,
    attestNotTransmitted: row.attest_not_transmitted,
    recordedAt: row.recorded_at.toISOString(), actorUserId: row.recorded_by_user_id,
    actorSecurityVersion: Number(row.actor_security_version) },
  { tenantId: row.tenant_id, orderId: row.order_id });
}
const state = (view) => Object.freeze({ orderVersion: view.snapshot.orderVersion,
  revision: view.state.revision, status: view.state.status });

export function createPostgresCateringWithdrawalRepository(pool, { registry, auditRepository } = {}) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof registry?.get !== 'function'
    || typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('CATERING_WITHDRAWAL_PORT_REQUIRED');
  async function context(client, { tenantId, orderId, orderVersion = null, lock = false }) {
    const heads = await client.query(`SELECT current_version FROM catering_order_heads
      WHERE tenant_id=$1 AND order_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [tenantId,orderId]);
    if (heads.rowCount === 0) return null;
    const currentVersion = Number(heads.rows[0].current_version);
    const view = await readCateringOrderWithClient(client, { tenantId, orderId, version: orderVersion, registry, lock });
    if (!view) return null;
    const selected = view.snapshot.orderVersion;
    const jobs = await client.query(`SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3
      ${lock ? 'FOR UPDATE' : ''}`, [tenantId,orderId,selected]);
    if (jobs.rowCount > 1) throw new TypeError('CATERING_WITHDRAWAL_SOURCE_INVALID');
    const job = jobs.rows[0] ?? null;
    const evidence = (await client.query(`SELECT
      coalesce((SELECT last_sequence FROM catering_manual_delivery_heads
        WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3),0) AS manual_sequence,
      EXISTS (SELECT 1 FROM catering_delivery_attempts WHERE tenant_id=$1 AND job_id=$4) AS has_attempt,
      EXISTS (SELECT 1 FROM catering_delivery_observations WHERE tenant_id=$1 AND job_id=$4) AS has_observation`,
    [tenantId,orderId,selected,job?.id ?? null])).rows[0];
    const effective = await readEffectiveCateringVersionWithClient(client, tenantId, orderId);
    const eligibility = cateringOrderWithdrawalEligibility({ orderVersion: selected, status: view.state.status,
      decision: view.decision?.decision ?? null, effective: effective !== null && effective.orderVersion > selected ? null : effective,
      manualSequence: Number(evidence.manual_sequence), job: job === null ? null : {
        status: job.status, dispatchAttempts: job.dispatch_attempts, hasAttempt: evidence.has_attempt,
        hasObservation: evidence.has_observation, leaseActive: job.lease_id !== null || job.lease_expires_at !== null,
      } });
    return { view, job, effective, eligible: currentVersion === selected && eligibility.eligible };
  }
  return Object.freeze({
    async load({ tenantId, orderId, orderVersion = null }) {
      tenantId = uuid(tenantId); orderId = uuid(orderId); if (orderVersion !== null) count(orderVersion);
      return withPostgresTransaction(pool, async (client) => {
        const source = await context(client, { tenantId, orderId, orderVersion });
        if (!source) return null;
        const rows = await client.query(`SELECT * FROM catering_order_withdrawals
          WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3`, [tenantId,orderId,source.view.snapshot.orderVersion]);
        return Object.freeze({ tenantId, orderId, orderState: state(source.view), eligible: source.eligible,
          effective: source.effective, withdrawal: rows.rowCount === 0 ? null : fact(rows.rows[0]) });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async withdraw(value) {
      const command = normalizeCateringWithdrawalCommand({ schemaVersion: value.schemaVersion, commandId: value.commandId,
        expectedOrderVersion: value.expectedOrderVersion, expectedStateRevision: value.expectedStateRevision,
        justification: value.justification, attestNotTransmitted: value.attestNotTransmitted }, { orderId: value.orderId });
      const input = { ...command, tenantId: uuid(value.tenantId), actorUserId: uuid(value.actorUserId), sessionId: uuid(value.sessionId),
        expectedSecurityVersion: count(value.expectedSecurityVersion), correlationId: uuid(value.correlationId),
        auditEventFor: value.auditEventFor };
      if (typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_WITHDRAWAL_AUDIT_REQUIRED');
      try {
        return await withPostgresTransaction(pool, async (client) => {
          if (!await lockCateringManager(client, input)) return result('not_authorized');
          const source = await context(client, { tenantId: input.tenantId, orderId: input.orderId, lock: true });
          if (!source) return result('not_found');
          const existing = await client.query('SELECT * FROM catering_order_withdrawals WHERE tenant_id=$1 AND command_id=$2',
            [input.tenantId,input.commandId]);
          if (existing.rowCount === 1) {
            const saved = fact(existing.rows[0]);
            if (saved.orderId !== input.orderId || saved.orderVersion !== input.expectedOrderVersion
              || saved.originStateRevision !== input.expectedStateRevision || saved.justification !== input.justification
              || saved.actorUserId !== input.actorUserId || saved.actorSecurityVersion !== input.expectedSecurityVersion) {
              return result('command_conflict');
            }
            const selected = await readCateringOrderWithClient(client,
              { tenantId: input.tenantId, orderId: input.orderId, version: saved.orderVersion, registry });
            if (!selected) throw new Error('CATERING_WITHDRAWAL_REPLAY_SOURCE_MISSING');
            return result('withdrawn', { replayed: true, withdrawal: saved, orderState: state(selected) });
          }
          const view = source.view;
          if (view.snapshot.orderVersion !== input.expectedOrderVersion || view.state.revision !== input.expectedStateRevision) {
            return result('state_conflict');
          }
          if (!source.eligible) return result('source_unavailable');
          const inserted = await client.query(`INSERT INTO catering_order_withdrawals
            (tenant_id,order_id,order_version,command_id,origin_state_revision,previous_status,prior_quote_revision,
              prior_decision_sequence,job_id,job_revision,justification,recorded_by_user_id,actor_security_version,correlation_id,
              attest_not_transmitted)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true) RETURNING *`,
          [input.tenantId,input.orderId,input.expectedOrderVersion,input.commandId,input.expectedStateRevision,view.state.status,
            view.quote?.revision ?? null,view.decision?.sequence ?? null,source.job?.id ?? null,source.job?.revision ?? null,
            input.justification,input.actorUserId,input.expectedSecurityVersion,input.correlationId]);
          const saved = fact(inserted.rows[0]);
          if (source.job) await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='superseded',available_at=NULL,
            lease_id=NULL,lease_expires_at=NULL,lease_manual=false,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
          [input.tenantId,source.job.id]);
          const changed = await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status='withdrawn',
            updated_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND revision=$4`,
          [input.tenantId,input.orderId,input.expectedOrderVersion,input.expectedStateRevision]);
          if (changed.rowCount !== 1) throw new Error('CATERING_WITHDRAWAL_STATE_UPDATE_FAILED');
          const event = input.auditEventFor({ orderId: input.orderId, orderVersion: input.expectedOrderVersion,
            previousStatus: view.state.status, previousRevision: input.expectedStateRevision, revision: input.expectedStateRevision + 1 });
          if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.targetType !== 'catering_order'
            || event.targetId !== input.orderId || event.action !== 'catering.order.withdrawn'
            || event.correlationId !== input.correlationId || event.outcome !== 'success' || event.retentionClass !== 'business') {
            throw new TypeError('CATERING_WITHDRAWAL_AUDIT_SCOPE_INVALID');
          }
          await auditRepository.appendWithClient(client, event);
          return result('withdrawn', { replayed: false, withdrawal: saved, orderState: Object.freeze({
            orderVersion: input.expectedOrderVersion, revision: input.expectedStateRevision + 1, status: 'withdrawn',
          }) });
        });
      } catch (error) {
        if (error?.code === '23514' && ['CATERING_WITHDRAWAL_SOURCE_INVALID','CATERING_WITHDRAWAL_DELIVERY_STARTED']
          .includes(error.message)) return result('source_unavailable');
        throw error;
      }
    },
  });
}
