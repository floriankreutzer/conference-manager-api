import { performance } from 'node:perf_hooks';
import { isInternalUuid } from '../../domain/identifiers.js';
import { DEMO_DATABASE_SENTINEL_KEY, DEMO_RUNTIME_SCHEMA_VERSION } from '../../demo/runtime-contract.js';
import { compileRuntimeProductReport } from '../../observability/product-runtime-report.js';
import { DAY_MS } from '../../observability/product-delivery-contract.js';
import { PRODUCT_RUNTIME_MAX_EVENTS } from '../../observability/product-runtime-contract.js';
import { AUDIT_COLUMNS, createTenantAuditRowVerifier, mapAuditRow } from './audit-repository.js';
import { PLATFORM_AUDIT_CHECKPOINT_INTERVAL, PLATFORM_AUDIT_EVENT_COLUMNS,
  createPlatformAuditRowVerifier, mapEventRow } from './platform-audit-repository.js';
import { withDemoRuntimeSharedGate } from './demo-runtime-gate.js';
import { withPostgresTransaction } from './transaction.js';
import { platformProductFacts } from './platform-product-runtime-facts.js';

const MAX_TENANTS = 100;
const MAX_READ_MS = 8000;
const FAILURE_REASONS = new Set(['source_limit', 'integrity_failure']);
const fail = (reason) => { throw Object.assign(new Error('DEMO_PRODUCT_SOURCE_FAILED'), { reason }); };

function boundedQuery(client) {
  const deadline = performance.now() + MAX_READ_MS;
  return async (text, values) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) fail('source_unavailable');
    await client.query('SELECT set_config(\'statement_timeout\', $1, true)', [String(remaining)]);
    const result = await client.query({ text, values });
    if (performance.now() >= deadline) fail('source_unavailable');
    return result;
  };
}

async function source(client, query, work) {
  await query('SAVEPOINT product_runtime_source');
  try {
    const result = await work();
    await query('RELEASE SAVEPOINT product_runtime_source');
    return { state: 'available', ...result };
  } catch (error) {
    // SQL privilege/time-limit failures abort only this source's savepoint. They
    // cannot suppress an independently verified source from the same snapshot.
    await client.query('ROLLBACK TO SAVEPOINT product_runtime_source');
    await client.query('RELEASE SAVEPOINT product_runtime_source');
    return { state: 'not_collected', reason: FAILURE_REASONS.has(error.reason) ? error.reason : 'source_unavailable' };
  }
}

async function tenantSource(query, verify) {
  const tenants = await query('SELECT id FROM tenants ORDER BY id LIMIT $1', [MAX_TENANTS + 1]);
  if (tenants.rows.length > MAX_TENANTS) fail('source_limit');
  const tenantIds = new Set(tenants.rows.map((row) => row.id));
  const result = await query(`SELECT ${AUDIT_COLUMNS} FROM audit_events
    ORDER BY tenant_id, id LIMIT $1`, [PRODUCT_RUNTIME_MAX_EVENTS + 1]);
  if (result.rows.length > PRODUCT_RUNTIME_MAX_EVENTS) fail('source_limit');
  const chains = new Map();
  for (const row of result.rows) {
    if (!tenantIds.has(row.tenant_id)) fail('integrity_failure');
    if (!chains.has(row.tenant_id)) chains.set(row.tenant_id, []);
    chains.get(row.tenant_id).push(row);
  }
  for (const rows of chains.values()) if (!verify(rows)) fail('integrity_failure');
  return { events: result.rows.map(mapAuditRow), rawCount: result.rows.length };
}

async function platformSource(query, verify, remaining) {
  const head = await query(`SELECT event_count, terminal_event_hash, terminal_checkpoint_hash
    FROM platform_audit_chain_state WHERE singleton LIMIT 2`);
  if (head.rows.length !== 1) fail('integrity_failure');
  const count = Number(head.rows[0].event_count);
  if (!Number.isSafeInteger(count) || count < 0) fail('integrity_failure');
  if (count > remaining) fail('source_limit');
  const result = await query(`SELECT ${PLATFORM_AUDIT_EVENT_COLUMNS} FROM platform_audit_events
    ORDER BY sequence LIMIT $1`, [remaining + 1]);
  if (result.rows.length > remaining) fail('source_limit');
  if (count !== result.rows.length || !verify(result.rows)
    || head.rows[0].terminal_event_hash !== (result.rows.at(-1)?.event_hash ?? null)) fail('integrity_failure');
  const checkpoints = await query(`SELECT event_count, terminal_event_hash, previous_checkpoint_hash,
    checkpoint_hash, created_at, integrity_version FROM platform_audit_checkpoints ORDER BY event_count LIMIT $1`,
  [Math.floor(PRODUCT_RUNTIME_MAX_EVENTS / PLATFORM_AUDIT_CHECKPOINT_INTERVAL) + 1]);
  const expectedCheckpoints = Math.floor(count / PLATFORM_AUDIT_CHECKPOINT_INTERVAL);
  if (checkpoints.rows.length !== expectedCheckpoints) fail('integrity_failure');
  let previousHash = null;
  for (const [index, checkpoint] of checkpoints.rows.entries()) {
    const eventCount = (index + 1) * PLATFORM_AUDIT_CHECKPOINT_INTERVAL;
    if (Number(checkpoint.event_count) !== eventCount || checkpoint.previous_checkpoint_hash !== previousHash
      || checkpoint.terminal_event_hash !== result.rows[eventCount - 1]?.event_hash
      || !verify([], checkpoint)) fail('integrity_failure');
    previousHash = checkpoint.checkpoint_hash;
  }
  if (previousHash !== head.rows[0].terminal_checkpoint_hash) fail('integrity_failure');
  return { events: platformProductFacts(result.rows.map(mapEventRow)) };
}

async function revisionSource(query, observedAt) {
  const result = await query(`SELECT tenant_id, request_id, request_version, operation,
    captured_at, actor_role_at_action, request_status FROM demo_product_request_revision_facts
    WHERE captured_at >= $1 AND captured_at < $2 AND operation = 'transitioned'
    ORDER BY tenant_id, request_id, request_version LIMIT $3`,
  [new Date(Date.parse(observedAt) - 28 * DAY_MS).toISOString(), observedAt, PRODUCT_RUNTIME_MAX_EVENTS + 1]);
  if (result.rows.length > PRODUCT_RUNTIME_MAX_EVENTS) fail('source_limit');
  const rows = result.rows.map((row) => {
    if (!isInternalUuid(row.tenant_id) || !Number.isSafeInteger(Number(row.request_version))
      || Number(row.request_version) < 1 || ![null, 'employee', 'conference_manager'].includes(row.actor_role_at_action)) {
      fail('integrity_failure');
    }
    return { tenantId: row.tenant_id, requestId: row.request_id, version: Number(row.request_version),
      operation: row.operation, capturedAt: row.captured_at.toISOString(), roleAtAction: row.actor_role_at_action,
      requestStatus: row.request_status };
  });
  return { rows };
}

// Closed Demo system-aggregation port: no principal, Tenant selector, caller
// query, raw-event result, ingestion route or production composition can use it.
// Its only runtime caller is the existing owner-password private projection.
export function createPostgresDemoProductRuntimeRepository({ pool, gatePool, expectedDatabaseName, expectedRole,
  tenantAuditHmacSecret, platformAuditHmacSecret } = {}) {
  if (!pool?.connect || !gatePool?.connect || pool === gatePool
    || typeof expectedDatabaseName !== 'string' || typeof expectedRole !== 'string') {
    throw new TypeError('DEMO_PRODUCT_RUNTIME_CONFIG_INVALID');
  }
  const verifyTenant = createTenantAuditRowVerifier({ hmacSecret: tenantAuditHmacSecret });
  const verifyPlatform = createPlatformAuditRowVerifier({ hmacSecret: platformAuditHmacSecret });
  return Object.freeze({
    async read() {
      return withDemoRuntimeSharedGate(gatePool, () => withPostgresTransaction(pool, async (client) => {
        const query = boundedQuery(client);
        const binding = await query(`SELECT current_database() AS connected_database, current_user AS connected_role,
          sentinel.database_name, sentinel.platform_role, sentinel.sentinel_key, sentinel.runtime_schema_version,
          epoch.source_epoch, epoch.started_at, statement_timestamp() AS observed_at
          FROM demo_database_sentinel AS sentinel CROSS JOIN demo_product_source_epoch AS epoch
          WHERE sentinel.singleton AND epoch.singleton LIMIT 2`);
        const row = binding.rows[0];
        if (binding.rows.length !== 1 || row.connected_database !== expectedDatabaseName
          || row.database_name !== expectedDatabaseName || row.connected_role !== expectedRole || row.platform_role !== expectedRole
          || row.sentinel_key !== DEMO_DATABASE_SENTINEL_KEY || Number(row.runtime_schema_version) !== DEMO_RUNTIME_SCHEMA_VERSION
          || !isInternalUuid(row.source_epoch) || !(row.started_at instanceof Date)
          || !(row.observed_at instanceof Date) || row.started_at > row.observed_at) fail('source_unavailable');
        const observedAt = row.observed_at.toISOString();
        const tenant = await source(client, query, () => tenantSource(query, verifyTenant));
        const remaining = PRODUCT_RUNTIME_MAX_EVENTS - (tenant.rawCount ?? 0);
        const platform = await source(client, query, () => platformSource(query, verifyPlatform, remaining));
        const revisions = await source(client, query, () => revisionSource(query, observedAt));
        return compileRuntimeProductReport({ observedAt, sourceEpoch: row.source_epoch,
          epochStartedAt: row.started_at.toISOString(), tenant, platform, revisions });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true }));
    },
  });
}
