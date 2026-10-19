import { readEffectiveCateringVersionWithClient } from './catering-effective-version.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { cateringOrderStateFromReceipt } from '../../domain/catering-receipt-state.js';
import { normalizeCateringManualCommand, normalizeCateringManualFact } from '../../domain/catering-manual-contract.js';
import { normalizeCateringReceipt } from '../../integrations/catering-contract.js';
import { lockCateringManager } from './catering-manager-session.js';
import { readCateringOrderWithClient } from './catering-order-source.js';
import { withPostgresTransaction } from './transaction.js';

const result = (status, values = {}) => Object.freeze({ status, ...values });
function uuid(value) { if (!isInternalUuid(value)) throw new TypeError('CATERING_MANUAL_SCOPE_INVALID'); return value.toLowerCase(); }
function counter(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_MANUAL_COUNTER_INVALID');
  }
  return value;
}
function fact(row) {
  return normalizeCateringManualFact({ tenantId: row.tenant_id, orderId: row.order_id, orderVersion: Number(row.order_version),
    sequence: Number(row.sequence), commandId: row.command_id, originStateRevision: Number(row.origin_state_revision),
    kind: row.kind, channel: row.channel, reference: row.reference, occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(), actorUserId: row.recorded_by_user_id,
    actorSecurityVersion: Number(row.actor_security_version), quoteRevision: Number(row.quote_revision),
    decisionSequence: Number(row.decision_sequence), operation: row.operation, status: row.status, receipt: row.receipt },
  { tenantId: row.tenant_id, orderId: row.order_id, orderVersion: Number(row.order_version) });
}
function sameCommand(stored, input) {
  return stored.orderId === input.orderId && stored.orderVersion === input.expectedOrderVersion
    && stored.originStateRevision === input.expectedStateRevision && stored.actorUserId === input.actorUserId
    && stored.actorSecurityVersion === input.expectedSecurityVersion && stored.kind === input.kind && stored.channel === input.channel
    && stored.reference === input.reference && stored.occurredAt === input.occurredAt
    && JSON.stringify(stored.receipt) === JSON.stringify(input.receipt);
}
const state = (view) => Object.freeze({ orderVersion: view.snapshot.orderVersion,
  revision: view.state.revision, status: view.state.status });

export function createPostgresCateringManualDeliveryRepository(pool, { registry, auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!registry || typeof registry.get !== 'function' || typeof auditRepository?.appendWithClient !== 'function') {
    throw new TypeError('CATERING_MANUAL_PERSISTENCE_PORT_REQUIRED');
  }
  async function head(client, tenantId, orderId, version) {
    const rows = await client.query(`SELECT last_sequence FROM catering_manual_delivery_heads
      WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3`, [tenantId,orderId,version]);
    return rows.rowCount === 0 ? 0 : counter(Number(rows.rows[0].last_sequence));
  }
  async function appendAudit(client, input, view, recorded) {
    const event = input.auditEventFor({ orderId: input.orderId, orderVersion: input.expectedOrderVersion,
      sequence: recorded.sequence, previousRevision: view.state.revision, revision: view.state.revision + 1,
      previousStatus: view.state.status, status: recorded.status, kind: recorded.kind });
    if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.targetType !== 'catering_order'
      || event.targetId !== input.orderId || event.correlationId !== input.correlationId || event.outcome !== 'success'
      || event.retentionClass !== 'business' || event.action !== `catering.manual.${recorded.kind}`) {
      throw new TypeError('CATERING_MANUAL_AUDIT_SCOPE_INVALID');
    }
    await auditRepository.appendWithClient(client, event);
  }
  return Object.freeze({
    async load({ tenantId, orderId, orderVersion = null, afterSequence = 0 }) {
      tenantId = uuid(tenantId); orderId = uuid(orderId); counter(afterSequence, 0);
      if (orderVersion !== null) counter(orderVersion);
      return withPostgresTransaction(pool, async (client) => {
        const view = await readCateringOrderWithClient(client, { tenantId, orderId, version: orderVersion, registry });
        if (!view) return null;
        const version = view.snapshot.orderVersion;
        const rows = await client.query(`SELECT * FROM catering_manual_delivery_facts
          WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3 AND sequence>$4 ORDER BY sequence LIMIT 21`,
        [tenantId,orderId,version,afterSequence]);
        const events = Object.freeze(rows.rows.slice(0, 20).map(fact));
        return Object.freeze({ tenantId, orderId, orderVersion: version, orderState: state(view),
          manualSequence: await head(client, tenantId, orderId, version), events,
          nextAfterSequence: rows.rowCount > 20 ? events.at(-1).sequence : null,
          effective: await readEffectiveCateringVersionWithClient(client, tenantId, orderId) });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async record(value) {
      const command = normalizeCateringManualCommand({ schemaVersion: value.schemaVersion, commandId: value.commandId,
        expectedOrderVersion: value.expectedOrderVersion, expectedStateRevision: value.expectedStateRevision, kind: value.kind,
        channel: value.channel, reference: value.reference, occurredAt: value.occurredAt, receipt: value.receipt },
      { orderId: value.orderId });
      const input = { ...command, tenantId: uuid(value.tenantId), actorUserId: uuid(value.actorUserId),
        sessionId: uuid(value.sessionId), expectedSecurityVersion: counter(value.expectedSecurityVersion),
        correlationId: uuid(value.correlationId), auditEventFor: value.auditEventFor };
      if (typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_MANUAL_AUDIT_PORT_REQUIRED');
      try {
        return await withPostgresTransaction(pool, async (client) => {
          if (!await lockCateringManager(client, input)) return result('not_authorized');
          const view = await readCateringOrderWithClient(client, { tenantId: input.tenantId, orderId: input.orderId,
            version: input.expectedOrderVersion, registry, lock: true });
          if (!view) return result('not_found');
          const existing = await client.query('SELECT * FROM catering_manual_delivery_facts WHERE tenant_id=$1 AND command_id=$2',
            [input.tenantId,input.commandId]);
          if (existing.rowCount === 1) {
            const recorded = fact(existing.rows[0]);
            if (!sameCommand(recorded, input)) return result('command_conflict');
            return result('recorded', { replayed: true, fact: recorded, orderState: state(view) });
          }
          if (view.state.revision !== input.expectedStateRevision) return result('state_conflict');
          if (view.decision?.decision !== 'approved' || !view.quote) return result('approval_unavailable');
          const jobs = await client.query(`SELECT status,dispatch_attempts,quote_revision,decision_sequence,created_at,
            origin_state_revision FROM catering_delivery_jobs WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3`,
          [input.tenantId,input.orderId,input.expectedOrderVersion]);
          const job = jobs.rows[0];
          if (!job || job.dispatch_attempts !== 0 || !['queued','deferred'].includes(job.status)
            || Number(job.quote_revision) !== view.quote.revision || Number(job.decision_sequence) !== view.decision.sequence) {
            return result('manual_source_unavailable');
          }
          const configuration = await client.query(`SELECT CASE $4::text WHEN 'initial' THEN order_mode WHEN 'cancel' THEN cancel_mode
            ELSE update_mode END AS mode FROM catering_integration_configuration_revisions
            WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3`,
          [input.tenantId,view.snapshot.integrationId,view.configurationRevision,view.deliveryOperation ?? view.operation]);
          if (configuration.rows[0]?.mode !== 'manual') return result('manual_source_unavailable');
          const sequence = await head(client, input.tenantId, input.orderId, input.expectedOrderVersion) + 1;
          if (sequence >= Number.MAX_SAFE_INTEGER) return result('manual_source_unavailable');
          let normalizedReceipt = null; let status = 'transmitted';
          if (input.kind === 'transmitted') {
            if (sequence !== 1) return result('already_transmitted');
            if (view.state.status !== 'queued' || Number(job.origin_state_revision) + 1 !== view.state.revision) {
              return result('manual_source_unavailable');
            }
          } else {
            if (sequence === 1) return result('transmission_required');
            let normalized;
            try {
              normalized = normalizeCateringReceipt(input.receipt, { orderId: input.orderId, orderVersion: input.expectedOrderVersion,
                positionIds: view.snapshot.positions.map((position) => position.positionId) });
            } catch (error) {
              if (error instanceof TypeError && error.message === 'CATERING_RECEIPT_INVALID') return result('receipt_conflict');
              throw error;
            }
            const { counts, ...receipt } = normalized; normalizedReceipt = receipt;
            status = cateringOrderStateFromReceipt({ operation: view.operation, positionCount: normalized.positions.length, counts });
            if (['confirmed','cancelled'].includes(view.state.status) && status !== view.state.status) return result('terminal_conflict');
          }
          const inserted = await client.query(`INSERT INTO catering_manual_delivery_facts
            (tenant_id,order_id,order_version,sequence,command_id,origin_state_revision,operation,quote_revision,decision_sequence,
              kind,channel,reference,occurred_at,recorded_by_user_id,actor_security_version,correlation_id,status,receipt)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) RETURNING *`,
          [input.tenantId,input.orderId,input.expectedOrderVersion,sequence,input.commandId,input.expectedStateRevision,view.operation,
            view.quote.revision,view.decision.sequence,input.kind,input.channel,input.reference,
            new Date(input.occurredAt),input.actorUserId,
            input.expectedSecurityVersion,input.correlationId,status,
            normalizedReceipt === null ? null : JSON.stringify(normalizedReceipt)]);
          const recorded = fact(inserted.rows[0]);
          const changed = await client.query(`UPDATE catering_order_version_states
            SET revision=revision+1,status=$4,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND revision=$5`,
          [input.tenantId,input.orderId,input.expectedOrderVersion,status,input.expectedStateRevision]);
          if (changed.rowCount !== 1) throw new Error('CATERING_MANUAL_STATE_UPDATE_FAILED');
          const advanced = sequence === 1
            ? await client.query(`INSERT INTO catering_manual_delivery_heads(tenant_id,order_id,order_version,last_sequence)
              VALUES ($1,$2,$3,1)`, [input.tenantId,input.orderId,input.expectedOrderVersion])
            : await client.query(`UPDATE catering_manual_delivery_heads SET last_sequence=$4
              WHERE tenant_id=$1 AND order_id=$2 AND order_version=$3 AND last_sequence=$4-1`,
            [input.tenantId,input.orderId,input.expectedOrderVersion,sequence]);
          if (advanced.rowCount !== 1) throw new Error('CATERING_MANUAL_HEAD_UPDATE_FAILED');
          await appendAudit(client, input, view, recorded);
          return result('recorded', { replayed: false, fact: recorded,
            orderState: Object.freeze({ orderVersion: input.expectedOrderVersion, revision: input.expectedStateRevision + 1, status }) });
        });
      } catch (error) {
        if (error?.code === '23514' && ['CATERING_MANUAL_TIME_INVALID','CATERING_MANUAL_TRANSMISSION_INVALID',
          'CATERING_MANUAL_RECEIPT_INVALID']
          .includes(error.message)) return result('time_conflict');
        if (error?.code === '23514' && error.message === 'CATERING_MANUAL_RECEIPT_POSITIONS_INVALID') return result('receipt_conflict');
        if (error?.code === '23514' && error.message === 'CATERING_MANUAL_APPROVED_SOURCE_REQUIRED') {
          return result('manual_source_unavailable');
        }
        throw error;
      }
    },
  });
}
