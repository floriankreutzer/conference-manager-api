import { randomUUID } from 'node:crypto';
import { normalizeCateringVersionCommand } from '../../domain/catering-version-proposal.js';
import { createCateringOrderSnapshots } from '../../domain/catering-order-snapshot.js';
import { loadCateringOrderSourceWithClient, readCateringOrderWithClient } from './catering-order-source.js';
import { lockCateringManager } from './catering-manager-session.js';
import { withPostgresTransaction } from './transaction.js';
import {
  cateringVersionProposalFromRow as proposal, readCateringVersionContextWithClient, readCateringVersionPageWithClient,
  versionCounter as counter, versionOrderState as state, versionUuid as uuid,
} from './catering-version-state.js';

const result = (status, values = {}) => Object.freeze({ status, ...values });
function replayMatches(row, input) {
  return row.orderId === input.orderId && row.priorOrderVersion === input.expectedOrderVersion
    && row.priorStateRevision === input.expectedStateRevision && row.requestEvidenceVersion === input.expectedRequestVersion
    && row.assignmentRevision === input.expectedAssignmentRevision && row.operation === input.operation
    && row.justification === input.justification && row.proposedByUserId === input.actorUserId
    && row.proposerSecurityVersion === input.expectedSecurityVersion;
}

export function createPostgresCateringVersionRepository(pool, { registry, auditRepository, idFactory = randomUUID } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof registry?.get !== 'function' || typeof auditRepository?.appendWithClient !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('CATERING_VERSION_PERSISTENCE_PORT_REQUIRED');
  }
  return Object.freeze({
    async load({ tenantId, orderId, afterOrderVersion = 1 }) {
      tenantId = uuid(tenantId); orderId = uuid(orderId); counter(afterOrderVersion);
      return withPostgresTransaction(pool, async (client) => {
        const context = await readCateringVersionContextWithClient(client, { tenantId, orderId, registry });
        if (!context) return null;
        const page = await readCateringVersionPageWithClient(client, { tenantId, orderId, afterOrderVersion });
        return Object.freeze({ tenantId, orderId, requestId: context.view.snapshot.requestId, orderState: state(context.view),
          currentRequest: context.request === null ? null : Object.freeze({
            version: context.request.version, status: context.request.status,
          }),
          currentAssignmentRevision: context.assignmentRevision,
          basis: context.basis === null ? null : Object.freeze({ orderVersion: context.effective.orderVersion,
            status: context.effective.status, requestVersion: context.basis.snapshot.requestVersion,
            assignmentRevision: context.basis.snapshot.assignmentRevision, providerCost: context.basis.quote.cost }),
          allowedOperations: Object.freeze(Object.keys(context.plans)), ...page });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async propose(value) {
      const command = normalizeCateringVersionCommand({ schemaVersion: value.schemaVersion, commandId: value.commandId,
        expectedOrderVersion: value.expectedOrderVersion, expectedStateRevision: value.expectedStateRevision,
        expectedRequestVersion: value.expectedRequestVersion, expectedAssignmentRevision: value.expectedAssignmentRevision,
        operation: value.operation, justification: value.justification }, { orderId: value.orderId });
      const input = { ...command, tenantId: uuid(value.tenantId), actorUserId: uuid(value.actorUserId), sessionId: uuid(value.sessionId),
        expectedSecurityVersion: counter(value.expectedSecurityVersion), correlationId: uuid(value.correlationId),
        auditEventFor: value.auditEventFor };
      if (typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_VERSION_AUDIT_REQUIRED');
      try {
        return await withPostgresTransaction(pool, async (client) => {
          if (!await lockCateringManager(client, input)) return result('not_authorized');
          const context = await readCateringVersionContextWithClient(client,
            { tenantId: input.tenantId, orderId: input.orderId, registry, lock: true });
          if (!context) return result('not_found');
          const existing = await client.query('SELECT * FROM catering_version_proposals WHERE tenant_id=$1 AND command_id=$2',
            [input.tenantId,input.commandId]);
          if (existing.rowCount === 1) {
            const saved = proposal(existing.rows[0]);
            if (!replayMatches(saved, input)) return result('command_conflict');
            const selected = await readCateringOrderWithClient(client,
              { tenantId: input.tenantId, orderId: input.orderId, version: saved.orderVersion, registry });
            if (!selected) throw new Error('CATERING_VERSION_REPLAY_SOURCE_MISSING');
            return result('proposed', { replayed: true, proposal: saved, orderState: state(selected) });
          }
          const view = context.view;
          if (view.snapshot.orderVersion !== input.expectedOrderVersion || view.state.revision !== input.expectedStateRevision) {
            return result('state_conflict');
          }
          if (context.request?.version !== input.expectedRequestVersion) return result('request_conflict');
          const plan = context.plans[input.operation];
          if (!plan || !context.configured) return result('source_unavailable');
          const assignment = plan.source === 'current_request' ? context.assignmentRevision : plan.basisAssignmentRevision;
          if (assignment !== input.expectedAssignmentRevision) return result('assignment_conflict');
          const source = await loadCateringOrderSourceWithClient(client, { tenantId: input.tenantId,
            requestId: view.snapshot.requestId, requestVersion: plan.sourceRequestVersion, assignmentRevision: assignment });
          if (!source) return result('source_unavailable');
          let snapshot;
          try {
            [snapshot] = createCateringOrderSnapshots({ ...source, orderVersion: plan.nextOrderVersion,
              onlyIntegrationId: view.snapshot.integrationId, orderIdFactory: () => input.orderId,
              positionIdFactory: () => uuid(idFactory()) });
          } catch (error) {
            if (error instanceof TypeError && error.message === 'CATERING_ORDER_SNAPSHOT_INVALID') return result('source_unavailable');
            throw error;
          }
          if (!snapshot) return result('source_unavailable');
          await client.query(`INSERT INTO catering_order_versions
            (tenant_id,order_id,version,request_id,request_version,integration_id,assignment_revision,catalogue_revision,
              configuration_revision,operation,position_count,conference_total_minor,currency,created_at,created_by_user_id,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp(),$14,$15)`,
          [input.tenantId,input.orderId,plan.nextOrderVersion,snapshot.requestId,snapshot.requestVersion,snapshot.integrationId,
            snapshot.assignmentRevision,snapshot.catalogueRevision,context.configured.revision,input.operation,snapshot.positions.length,
            snapshot.conferencePrice.amountMinor,snapshot.conferencePrice.currency,input.actorUserId,input.correlationId]);
          await client.query(`INSERT INTO catering_order_positions(tenant_id,order_id,version,position_id,kind,entry_id)
            SELECT $1,$2,$3,position_id,kind,entry_id FROM unnest($4::uuid[],$5::text[],$6::text[]) entry(position_id,kind,entry_id)`,
          [input.tenantId,input.orderId,plan.nextOrderVersion,snapshot.positions.map((line) => line.positionId),
            snapshot.positions.map((line) => line.kind),snapshot.positions.map((line) => line.entryId)]);
          await client.query(`INSERT INTO catering_order_version_states(tenant_id,order_id,version,revision,status,updated_at)
            VALUES ($1,$2,$3,1,'pending_quote',clock_timestamp())`, [input.tenantId,input.orderId,plan.nextOrderVersion]);
          const inserted = await client.query(`INSERT INTO catering_version_proposals
            (tenant_id,order_id,order_version,prior_order_version,prior_state_revision,basis_order_version,command_id,operation,
              request_id,request_evidence_version,request_evidence_status,source_request_version,assignment_revision,configuration_revision,
              justification,proposed_by_user_id,proposer_security_version,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [input.tenantId,input.orderId,plan.nextOrderVersion,input.expectedOrderVersion,input.expectedStateRevision,plan.basisOrderVersion,
            input.commandId,input.operation,snapshot.requestId,plan.requestEvidenceVersion,plan.requestEvidenceStatus,
            plan.sourceRequestVersion,assignment,context.configured.revision,input.justification,input.actorUserId,
            input.expectedSecurityVersion,input.correlationId]);
          const saved = proposal(inserted.rows[0]);
          const advanced = await client.query(`UPDATE catering_order_heads SET current_version=$3
            WHERE tenant_id=$1 AND order_id=$2 AND current_version=$4`,
          [input.tenantId,input.orderId,plan.nextOrderVersion,input.expectedOrderVersion]);
          if (advanced.rowCount !== 1) throw new Error('CATERING_VERSION_HEAD_ADVANCE_FAILED');
          const event = input.auditEventFor({ orderId: input.orderId, orderVersion: plan.nextOrderVersion,
            priorOrderVersion: input.expectedOrderVersion, priorStateRevision: input.expectedStateRevision,
            basisOrderVersion: plan.basisOrderVersion, requestVersion: plan.requestEvidenceVersion,
            sourceRequestVersion: plan.sourceRequestVersion, operation: input.operation });
          if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.targetType !== 'catering_order'
            || event.targetId !== input.orderId || event.action !== 'catering.order.version_proposed'
            || event.correlationId !== input.correlationId || event.outcome !== 'success' || event.retentionClass !== 'business') {
            throw new TypeError('CATERING_VERSION_AUDIT_SCOPE_INVALID');
          }
          await auditRepository.appendWithClient(client, event);
          return result('proposed', { replayed: false, proposal: saved, orderState: Object.freeze({
            orderVersion: plan.nextOrderVersion, revision: 1, status: 'pending_quote',
          }) });
        });
      } catch (error) {
        if (error?.code === '23514' && ['CATERING_VERSION_SOURCE_INVALID','CATERING_VERSION_CONFIRMED_BASIS_REQUIRED',
          'CATERING_VERSION_CHANGE_SOURCE_INVALID','CATERING_VERSION_RETAINED_SOURCE_INVALID'].includes(error.message)) {
          return result('source_unavailable');
        }
        throw error;
      }
    },
  });
}
