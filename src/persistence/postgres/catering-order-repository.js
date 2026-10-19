import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { isRequestId } from '../../domain/request.js';
import { createCateringOrderSnapshots } from '../../domain/catering-order-snapshot.js';
import { normalizeCateringOrderTotal } from '../../domain/catering-order-money.js';
import { evaluateCateringOrderRelease } from '../../domain/catering-order-release-policy.js';
import {
  canDecideCateringOrderQuote, canRecordCateringOrderQuote, capabilityForCateringOrderOperation,
} from '../../domain/catering-order-state.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { loadCateringOrderSourceWithClient, readCateringOrderWithClient } from './catering-order-source.js';
import { withPostgresTransaction } from './transaction.js';
import { lockCateringManager as lockActor } from './catering-manager-session.js';

const MODES = ['catalogue','availability','order','update','cancel','status'];
const result = (status, extra = {}) => Object.freeze({ status, ...extra });
function counter(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_ORDER_COUNTER_INVALID');
  }
  return value;
}
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_ORDER_IDENTIFIER_INVALID');
  return value.toLowerCase();
}
function actor(input) {
  const normalized = { ...input, tenantId: uuid(input?.tenantId), actorUserId: uuid(input?.actorUserId),
    sessionId: uuid(input?.sessionId), correlationId: uuid(input?.correlationId),
    expectedSecurityVersion: counter(input?.expectedSecurityVersion) };
  if (!(input.changedAt instanceof Date) || !Number.isFinite(input.changedAt.getTime())
    || typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_ORDER_WRITE_CONTEXT_INVALID');
  return normalized;
}
async function currentRequest(client, tenantId, requestId) {
  if (!isRequestId(requestId)) throw new TypeError('CATERING_ORDER_REQUEST_INVALID');
  const rows = await client.query({ name: 'catering-order-current-request-lock',
    text: 'SELECT request_version,status FROM requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', values: [tenantId, requestId] });
  return rows.rows[0] ?? null;
}
async function connection(client, tenantId, integrationId, registry) {
  const rows = await client.query({ name: 'catering-order-current-connection-lock',
    text: `SELECT configuration.*,integration.provider,integration.status FROM catering_integration_configurations configuration
      JOIN integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2 FOR SHARE OF configuration,integration`,
    values: [tenantId, integrationId] });
  if (rows.rowCount !== 1) return null;
  const row = rows.rows[0];
  const configuration = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
    capabilities: Object.fromEntries(MODES.map((name) => [`catering.${name}`, row[`${name}_mode`]])) }, registry.get(row.provider));
  return ['configured','active'].includes(row.status) ? { ...configuration, revision: counter(Number(row.revision)) } : null;
}
async function appendAudit(client, repository, input, orderId, action, values) {
  const event = input.auditEventFor(values);
  if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.targetType !== 'catering_order'
    || event.targetId !== orderId || event.action !== action || event.correlationId !== input.correlationId
    || event.outcome !== 'success' || event.retentionClass !== 'business') throw new TypeError('CATERING_ORDER_AUDIT_SCOPE_INVALID');
  await repository.appendWithClient(client, event);
}
function reference(row) {
  return Object.freeze({ orderId: uuid(row.id), integrationId: uuid(row.integration_id),
    version: counter(Number(row.current_version)), stateRevision: counter(Number(row.state_revision)), status: row.status });
}

export function createPostgresCateringOrderRepository(pool, { registry, auditRepository, idFactory = randomUUID } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  if (typeof idFactory !== 'function') throw new TypeError('ID_FACTORY_REQUIRED');
  async function detail(client, tenantId, orderId, lock = false) {
    return readCateringOrderWithClient(client, { tenantId, orderId, registry, lock });
  }
  async function writable(client, input) {
    if (!await lockActor(client, input)) return result('not_authorized');
    const view = await detail(client, input.tenantId, uuid(input.orderId), true);
    if (!view) return result('not_found');
    if (view.state.revision !== counter(input.expectedStateRevision)) {
      return result('state_conflict', { currentRevision: view.state.revision });
    }
    const request = await currentRequest(client, input.tenantId, view.snapshot.requestId);
    if (!request || Number(request.request_version) !== view.snapshot.requestVersion || request.status !== 'Confirmed') {
      return result('request_conflict');
    }
    const configured = await connection(client, input.tenantId, view.snapshot.integrationId, registry);
    const capability = capabilityForCateringOrderOperation(view.operation);
    if (!configured || configured.capabilities[capability] === 'unsupported') return result('connection_unavailable');
    return { view, configured };
  }
  return Object.freeze({
    load({ tenantId, orderId }) {
      return withPostgresTransaction(pool, (client) => detail(client, uuid(tenantId), uuid(orderId)), {
        isolationLevel: 'REPEATABLE READ', readOnly: true,
      });
    },
    async list({ tenantId, afterOrderId = null, requestId = null }) {
      tenantId = uuid(tenantId);
      const after = afterOrderId === null ? null : uuid(afterOrderId);
      if (requestId !== null && !isRequestId(requestId)) throw new TypeError('CATERING_ORDER_REQUEST_INVALID');
      const rows = await pool.query({ name: 'catering-order-list-bounded',
        text: `SELECT owned.id,owned.integration_id,head.current_version,state.revision AS state_revision,state.status
          FROM catering_orders owned JOIN catering_order_heads head ON head.tenant_id=owned.tenant_id AND head.order_id=owned.id
          JOIN catering_order_version_states state ON state.tenant_id=head.tenant_id AND state.order_id=head.order_id
            AND state.version=head.current_version
          WHERE owned.tenant_id=$1 AND ($2::uuid IS NULL OR owned.id>$2::uuid)
            AND ($3::text IS NULL OR owned.request_id=$3) ORDER BY owned.id LIMIT 21`, values: [tenantId, after, requestId] });
      const items = Object.freeze(rows.rows.slice(0, 20).map(reference));
      return Object.freeze({ tenantId, items, nextAfterOrderId: rows.rowCount > 20 ? items.at(-1).orderId : null });
    },
    async prepare(value) {
      const input = actor(value);
      input.commandId = uuid(value.commandId);
      counter(input.expectedRequestVersion); counter(input.expectedAssignmentRevision);
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockActor(client, input)) return result('not_authorized');
        const request = await currentRequest(client, input.tenantId, input.requestId);
        if (!request) return result('not_found');
        if (Number(request.request_version) !== input.expectedRequestVersion || request.status !== 'Confirmed') {
          return result('request_conflict');
        }
        const existing = await client.query({ name: 'catering-order-preparation-existing',
          text: `SELECT owned.id,owned.integration_id,owned.creation_command_id,history.request_version,history.assignment_revision,
            head.current_version,state.revision AS state_revision,state.status FROM catering_orders owned
            JOIN catering_order_versions history ON history.tenant_id=owned.tenant_id AND history.order_id=owned.id AND history.version=1
            JOIN catering_order_heads head ON head.tenant_id=owned.tenant_id AND head.order_id=owned.id
            JOIN catering_order_version_states state ON state.tenant_id=head.tenant_id AND state.order_id=head.order_id
              AND state.version=head.current_version
            WHERE owned.tenant_id=$1 AND owned.request_id=$2 ORDER BY owned.id LIMIT 102`, values: [input.tenantId, input.requestId] });
        if (existing.rowCount > 101) throw new TypeError('CATERING_ORDER_PREPARATION_BOUND_INVALID');
        if (existing.rowCount > 0) {
          if (existing.rows.some((row) => row.creation_command_id !== input.commandId
            || Number(row.request_version) !== input.expectedRequestVersion
            || Number(row.assignment_revision) !== input.expectedAssignmentRevision)) {
            return result('already_prepared');
          }
          return result('prepared', { tenantId: input.tenantId, replayed: true, orders: Object.freeze(existing.rows.map(reference)) });
        }
        const head = await client.query({ name: 'catering-order-assignment-head-lock',
          text: 'SELECT revision FROM catering_catalogue_assignment_heads WHERE tenant_id=$1 FOR SHARE', values: [input.tenantId] });
        if (head.rowCount !== 1 || Number(head.rows[0].revision) !== input.expectedAssignmentRevision) return result('assignment_conflict');
        const source = await loadCateringOrderSourceWithClient(client, { tenantId: input.tenantId, requestId: input.requestId,
          requestVersion: input.expectedRequestVersion, assignmentRevision: input.expectedAssignmentRevision });
        if (!source) return result('assignment_conflict');
        const snapshots = createCateringOrderSnapshots({ ...source,
          orderIdFactory: () => idFactory(), positionIdFactory: () => idFactory() });
        if (snapshots.length === 0) return result('no_catering');
        const orders = [];
        for (const snapshot of snapshots) {
          const configured = await connection(client, input.tenantId, snapshot.integrationId, registry);
          if (!configured || configured.capabilities['catering.order'] === 'unsupported') return result('connection_unavailable');
          orders.push({ snapshot, configured });
        }
        const references = [];
        for (const { snapshot, configured } of orders) {
          await client.query({ name: 'catering-order-identity-insert',
            text: `INSERT INTO catering_orders (tenant_id,id,request_id,integration_id,created_at,created_by_user_id,
              creation_command_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            values: [input.tenantId, snapshot.orderId, input.requestId, snapshot.integrationId, input.changedAt,
              input.actorUserId, input.commandId, input.correlationId] });
          await client.query({ name: 'catering-order-initial-version-insert',
            text: `INSERT INTO catering_order_versions (tenant_id,order_id,version,request_id,request_version,integration_id,
              assignment_revision,catalogue_revision,configuration_revision,operation,position_count,conference_total_minor,currency,
              created_at,created_by_user_id,correlation_id) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,'initial',$9,$10,$11,$12,$13,$14)`,
            values: [input.tenantId, snapshot.orderId, input.requestId, snapshot.requestVersion, snapshot.integrationId,
              snapshot.assignmentRevision, snapshot.catalogueRevision, configured.revision, snapshot.positions.length,
              snapshot.conferencePrice.amountMinor, snapshot.conferencePrice.currency,
              input.changedAt, input.actorUserId, input.correlationId] });
          await client.query({ name: 'catering-order-positions-insert',
            text: `INSERT INTO catering_order_positions (tenant_id,order_id,version,position_id,kind,entry_id)
              SELECT $1,$2,1,position_id,kind,entry_id FROM unnest($3::uuid[],$4::text[],$5::text[]) AS entry(position_id,kind,entry_id)`,
            values: [input.tenantId, snapshot.orderId, snapshot.positions.map((entry) => entry.positionId),
              snapshot.positions.map((entry) => entry.kind), snapshot.positions.map((entry) => entry.entryId)] });
          await client.query({ name: 'catering-order-initial-head-insert',
            text: 'INSERT INTO catering_order_heads (tenant_id,order_id,current_version) VALUES ($1,$2,1)',
            values: [input.tenantId, snapshot.orderId] });
          await client.query({ name: 'catering-order-initial-state-insert',
            text: `INSERT INTO catering_order_version_states (tenant_id,order_id,version,revision,status,updated_at)
              VALUES ($1,$2,1,1,'pending_quote',$3)`, values: [input.tenantId, snapshot.orderId, input.changedAt] });
          await appendAudit(client, auditRepository, input, snapshot.orderId, 'catering.order.prepared', {
            orderId: snapshot.orderId, requestVersion: snapshot.requestVersion, assignmentRevision: snapshot.assignmentRevision,
            catalogueRevision: snapshot.catalogueRevision, configurationRevision: configured.revision,
            positionCount: snapshot.positions.length, version: 1, previousRevision: 0, revision: 1, status: 'pending_quote',
          });
          references.push(Object.freeze({ orderId: snapshot.orderId, integrationId: snapshot.integrationId,
            version: 1, stateRevision: 1, status: 'pending_quote' }));
        }
        return result('prepared', { tenantId: input.tenantId, replayed: false,
          orders: Object.freeze(references.sort((a, b) => a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0)) });
      });
    },
    async recordQuote(value) {
      const input = actor(value);
      input.orderId = uuid(value.orderId);
      const cost = normalizeCateringOrderTotal(value.cost);
      counter(input.expectedQuoteRevision, 0);
      if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))
        || new Date(input.expiresAt).toISOString() !== input.expiresAt) {
        throw new TypeError('CATERING_ORDER_QUOTE_EXPIRY_INVALID');
      }
      return withPostgresTransaction(pool, async (client) => {
        const loaded = await writable(client, input);
        if (loaded.status) return loaded;
        const { view, configured } = loaded;
        if (configured.capabilities['catering.order'] !== 'manual') return result('manual_quote_not_supported');
        if (!canRecordCateringOrderQuote(view.state.status)) return result('delivery_in_progress');
        const currentQuote = view.quote?.revision ?? 0;
        if (currentQuote !== input.expectedQuoteRevision) return result('quote_conflict', { currentRevision: currentQuote });
        if (view.state.revision >= Number.MAX_SAFE_INTEGER - 1 || currentQuote >= Number.MAX_SAFE_INTEGER - 1) {
          return result('revision_exhausted');
        }
        const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
        if (Date.parse(input.expiresAt) <= now.getTime()) return result('quote_expired');
        const next = currentQuote + 1;
        await client.query({ name: 'catering-order-manual-quote-insert',
          text: `INSERT INTO catering_order_quotes (tenant_id,order_id,version,revision,amount_minor,currency,source,
            created_at,expires_at,recorded_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10)`,
          values: [input.tenantId, input.orderId, view.snapshot.orderVersion, next, cost.amountMinor, cost.currency,
            input.changedAt, new Date(input.expiresAt), input.actorUserId, input.correlationId] });
        const updated = await client.query({ name: 'catering-order-quote-state-update',
          text: `UPDATE catering_order_version_states SET revision=revision+1,status='pending_manager_review',quote_revision=$4,
            decision_sequence=NULL,updated_at=$5 WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND revision=$6`,
          values: [input.tenantId, input.orderId, view.snapshot.orderVersion, next, input.changedAt, view.state.revision] });
        if (updated.rowCount !== 1) throw new Error('CATERING_ORDER_STATE_UPDATE_FAILED');
        await appendAudit(client, auditRepository, input, input.orderId, 'catering.order.quoted', {
          orderId: input.orderId, version: view.snapshot.orderVersion, previousRevision: view.state.revision,
          revision: view.state.revision + 1, quoteRevision: next, amountMinor: cost.amountMinor, currency: cost.currency,
          status: 'pending_manager_review',
        });
        return result('quoted', { current: await detail(client, input.tenantId, input.orderId) });
      });
    },
    async decide(value) {
      const input = actor(value);
      input.orderId = uuid(value.orderId);
      counter(input.expectedQuoteRevision);
      if (!['approved','rejected'].includes(input.decision)) throw new TypeError('CATERING_ORDER_DECISION_INVALID');
      try {
        return await withPostgresTransaction(pool, async (client) => {
          const loaded = await writable(client, input);
          if (loaded.status) return loaded;
          const { view, configured } = loaded;
          if (!canDecideCateringOrderQuote(view.state.status)) return result('delivery_in_progress');
          if (!view.quote || view.quote.revision !== input.expectedQuoteRevision) return result('quote_conflict');
          if (view.state.revision >= Number.MAX_SAFE_INTEGER - 1) return result('revision_exhausted');
          const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
          const expected = { tenantId: input.tenantId, integrationId: view.snapshot.integrationId,
            orderId: input.orderId, orderVersion: view.snapshot.orderVersion };
          const approval = { ...expected, quoteRevision: view.quote.revision, cost: view.quote.cost,
            decision: input.decision, deciderUserId: input.actorUserId };
          if (input.decision === 'approved' && !evaluateCateringOrderRelease({
            initialOrderMode: configured.initialOrderMode, operation: view.operation, conferenceApproved: true,
            originalProviderCost: null, quote: { revision: view.quote.revision, cost: view.quote.cost, expiresAt: view.quote.expiresAt },
            managerApproval: approval, expected, startsAt: view.snapshot.startsAt, now,
          }).eligible) return result(view.operation !== 'cancel' && Date.parse(now) >= Date.parse(view.snapshot.startsAt)
            ? 'conference_started' : 'quote_expired');
          const last = await client.query({ name: 'catering-order-last-decision',
            text: `SELECT coalesce(max(sequence),0) AS sequence FROM catering_order_decisions
              WHERE tenant_id=$1 AND order_id=$2 AND version=$3`, values: [input.tenantId, input.orderId, view.snapshot.orderVersion] });
          const sequence = counter(Number(last.rows[0].sequence), 0) + 1;
          if (sequence >= Number.MAX_SAFE_INTEGER) return result('revision_exhausted');
          await client.query({ name: 'catering-order-manager-decision-insert',
            text: `INSERT INTO catering_order_decisions (tenant_id,order_id,version,sequence,quote_revision,amount_minor,currency,
              decision,decided_at,decider_user_id,decider_security_version,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            values: [input.tenantId, input.orderId, view.snapshot.orderVersion, sequence, view.quote.revision,
              view.quote.cost.amountMinor, view.quote.cost.currency, input.decision, input.changedAt, input.actorUserId,
              input.expectedSecurityVersion, input.correlationId] });
          const status = input.decision === 'approved' ? 'released' : 'rejected';
          const updated = await client.query({ name: 'catering-order-decision-state-update',
            text: `UPDATE catering_order_version_states SET revision=revision+1,status=$4,decision_sequence=$5,updated_at=$6
              WHERE tenant_id=$1 AND order_id=$2 AND version=$3 AND revision=$7`,
            values: [input.tenantId, input.orderId, view.snapshot.orderVersion, status, sequence, input.changedAt, view.state.revision] });
          if (updated.rowCount !== 1) throw new Error('CATERING_ORDER_STATE_UPDATE_FAILED');
          await appendAudit(client, auditRepository, input, input.orderId, 'catering.order.decided', {
            orderId: input.orderId, version: view.snapshot.orderVersion, previousRevision: view.state.revision,
            revision: view.state.revision + 1, quoteRevision: view.quote.revision, amountMinor: view.quote.cost.amountMinor,
            currency: view.quote.cost.currency, decision: input.decision, status,
          });
          return result('decided', { current: await detail(client, input.tenantId, input.orderId) });
        });
      } catch (error) {
        if (error?.code === '23514' && error.message === 'CATERING_ORDER_SCHEDULE_PASSED') return result('conference_started');
        if (error?.code === '23514' && error.message === 'CATERING_ORDER_APPROVAL_EXPIRED_OR_REVOKED') {
          return result('approval_unavailable');
        }
        throw error;
      }
    },
  });
}
