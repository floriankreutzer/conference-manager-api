import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadMigrations } from '../db-migrations.mjs';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { withPostgresTransaction } from '../../src/persistence/postgres/transaction.js';
import { createPostgresProtectedRuntimeExecutionScopes }
  from '../../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { AUDIT_COLUMNS, createTenantAuditRowVerifier, mapAuditRow } from '../../src/persistence/postgres/audit-repository.js';
import { createSegmentRowVerifier, mapEventRow, PLATFORM_AUDIT_EVENT_COLUMNS }
  from '../../src/persistence/postgres/platform-audit-integrity.js';
import { platformProductFacts } from '../../src/persistence/postgres/platform-product-runtime-facts.js';
import { compileRuntimeProductReport } from '../../src/observability/product-runtime-report.js';
import { DAY_MS } from '../../src/observability/product-delivery-contract.js';

const MAX_EVENTS = 2000;
const refuse = () => { throw new Error('PROTECTED_PRODUCT_COLLECTION_REFUSED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function tenantSource(query, tenantIds, secret) {
  const result = await query(`SELECT ${AUDIT_COLUMNS} FROM audit_events
    WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id,id LIMIT $2`, [tenantIds, MAX_EVENTS + 1]);
  if (result.rows.length > MAX_EVENTS) refuse();
  const chains = new Map();
  for (const row of result.rows) {
    if (!tenantIds.includes(row.tenant_id)) refuse();
    if (!chains.has(row.tenant_id)) chains.set(row.tenant_id, []);
    chains.get(row.tenant_id).push(row);
  }
  const verify = createTenantAuditRowVerifier({ hmacSecret: secret });
  for (const rows of chains.values()) if (!verify(rows)) refuse();
  return { state: 'available', events: result.rows.map(mapAuditRow), rawCount: result.rows.length };
}

async function platformSource(query, tenantIds, epoch, secret, maximum) {
  const result = await query(`SELECT s.*,h.event_count,h.terminal_event_hash,h.terminal_checkpoint_hash
    FROM platform_audit_segments s JOIN platform_audit_segment_heads h ON h.segment_id=s.id
    WHERE s.environment='int' AND s.deployment_epoch=$1 LIMIT 2`, [epoch]);
  if (result.rows.length !== 1) refuse();
  const row = result.rows[0], count = Number(row.event_count);
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) refuse();
  const segment = { id: row.id, environment: 'int', deploymentEpoch: epoch,
    legacyEventCount: Number(row.legacy_event_count), inventoryDigest: row.inventory_digest,
    approvalReference: row.approval_reference };
  const verify = createSegmentRowVerifier({ hmacSecret: secret, segment });
  const events = await query(`SELECT ${PLATFORM_AUDIT_EVENT_COLUMNS},segment_id,segment_sequence
    FROM platform_audit_events WHERE segment_id=$1 ORDER BY segment_sequence LIMIT $2`, [row.id, maximum + 1]);
  if (events.rows.length !== count || !verify(events.rows)
    || events.rows.at(-1)?.event_hash !== row.terminal_event_hash) refuse();
  const genesis = events.rows[0];
  if (genesis.target_type !== 'platform_audit_segment' || genesis.target_id !== segment.id
    || genesis.metadata?.operation !== 'audit_segment_genesis'
    || genesis.metadata?.inventoryDigest !== segment.inventoryDigest
    || genesis.metadata?.legacyVerification !== 'unavailable') refuse();
  const checkpoints = await query(`SELECT * FROM platform_audit_segment_checkpoints
    WHERE segment_id=$1 ORDER BY event_count LIMIT $2`, [row.id, Math.floor(MAX_EVENTS / 32) + 1]);
  if (checkpoints.rows.length !== Math.floor(count / 32)) refuse();
  let previous = null;
  for (const [index, checkpoint] of checkpoints.rows.entries()) {
    const at = (index + 1) * 32;
    if (Number(checkpoint.event_count) !== at || checkpoint.previous_checkpoint_hash !== previous
      || checkpoint.terminal_event_hash !== events.rows[at - 1]?.event_hash || !verify([], checkpoint)) refuse();
    previous = checkpoint.checkpoint_hash;
  }
  if (previous !== row.terminal_checkpoint_hash) refuse();
  return { state: 'available', startedAt: row.created_at,
    events: platformProductFacts(events.rows.map(mapEventRow)).filter(event => tenantIds.includes(event.tenantId)) };
}

// Offline owner only, bound to the existing INT database and immutable security
// epoch. No runtime grant, public ingestion route, tenant selector or Demo import.
export async function collectProtectedProductReport({ pool, leasePool, expectedOfflineRole, securityEpoch, dataProfile,
  tenantAuditHmacSecret, platformAuditHmacSecret } = {}) {
  if (!pool?.connect || !pool?.query || !leasePool?.connect || !leasePool?.query || pool===leasePool
    || !isInternalUuid(securityEpoch) || !['real','synthetic'].includes(dataProfile)
    || typeof expectedOfflineRole !== 'string' || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole)
    || expectedOfflineRole.startsWith('cm_protected_')
    || [tenantAuditHmacSecret, platformAuditHmacSecret].some(value => typeof value !== 'string'
      || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 512)
    || tenantAuditHmacSecret === platformAuditHmacSecret) refuse();
  const migrations = await loadMigrations();
  try {
    const deadline = performance.now() + 8000;
    const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch });
    // The existing separate lease is acquired before BEGIN RR. A lock SELECT
    // inside RR could itself retain a pre-reset snapshot after the reset commits.
    return await scopes.withShared(()=>withPostgresTransaction(pool, async client => {
      const query = async (text, values) => {
        const remaining = Math.floor(deadline - performance.now()); if (remaining < 1) refuse();
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]);
        const result = await client.query({ text, values });
        if (performance.now() >= deadline) refuse();return result;
      };
      const owner = await query(`SELECT current_user AS active_role,session_user AS authenticated_role,
        pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass`);
      if (owner.rows.length !== 1 || ['active_role','authenticated_role','owner_role']
        .some(key => owner.rows[0][key] !== expectedOfflineRole)) refuse();
      const ledger = await query('SELECT version,name,checksum FROM schema_migrations ORDER BY version LIMIT $1',
        [migrations.length + 1]);
      if (ledger.rows.length !== migrations.length || ledger.rows.some((row, index) => row.version !== migrations[index].version
        || row.name !== migrations[index].name || row.checksum !== migrations[index].checksum)) refuse();
      const binding = await query(`SELECT d.created_at,e.created_at AS epoch_started_at,
        date_trunc('milliseconds',statement_timestamp()) AS observed_at FROM protected_runtime_deployments d
        JOIN protected_runtime_epoch_history e ON e.environment=d.environment AND e.security_epoch=d.security_epoch
        WHERE d.environment='int' AND d.security_epoch=$1`, [securityEpoch]);
      if (binding.rows.length !== 1) refuse();
      const now = binding.rows[0].observed_at;
      if (!(now instanceof Date)) refuse();
      const tenants = await query(`SELECT r.tenant_id,r.created_at,r.generation_id FROM tenant_runtime_registry r
        LEFT JOIN synthetic_tenant_generations g ON g.id=r.generation_id AND g.environment=r.environment
        LEFT JOIN platform_operators o ON o.id=g.operator_id
        WHERE r.environment='int' AND r.mode=$1 AND (r.mode='real' OR
          (g.state='active' AND g.security_epoch=$2 AND o.status='active' AND o.security_version=g.operator_security_version))
        ORDER BY r.tenant_id LIMIT 101`, [dataProfile, securityEpoch]);
      if (tenants.rows.length > 100 || tenants.rows.some(row => !isInternalUuid(row.tenant_id))) refuse();
      const ids = tenants.rows.map(row => row.tenant_id);
      const tenant = await tenantSource(query, ids, tenantAuditHmacSecret);
      const platform = await platformSource(query, ids, securityEpoch, platformAuditHmacSecret, MAX_EVENTS - tenant.rawCount);
      const revisions = await query(`SELECT tenant_id,request_id,request_version,operation,captured_at,
        actor_role_at_action,record->>'status' AS request_status FROM request_revisions
        WHERE tenant_id=ANY($1::uuid[]) AND operation='transitioned' AND captured_at >= $2 AND captured_at < $3
        ORDER BY tenant_id,request_id,request_version LIMIT $4`,
      [ids, new Date(now.getTime() - 28 * DAY_MS), now, MAX_EVENTS + 1]);
      if (revisions.rows.length > MAX_EVENTS) refuse();
      const rows = revisions.rows.map(row => ({ tenantId: row.tenant_id, requestId: row.request_id,
        version: Number(row.request_version), operation: row.operation, capturedAt: row.captured_at.toISOString(),
        roleAtAction: row.actor_role_at_action, requestStatus: row.request_status }));
      const start = Math.max(binding.rows[0].epoch_started_at.getTime(), platform.startedAt.getTime(),
        ...tenants.rows.map(row => row.created_at.getTime()));
      if (!Number.isSafeInteger(start) || start > now.getTime()) refuse();
      return compileRuntimeProductReport({ observedAt: now.toISOString(), epochStartedAt: new Date(start).toISOString(),
        sourceEpoch: digest([securityEpoch, dataProfile, tenants.rows.map(row => [row.tenant_id,row.generation_id])]),
        environment: 'production', accessMode: 'application_passkey',
        sourceContext: { runtimeEnvironment: 'int', dataProfile, securityEpochDigest: digest(securityEpoch) },
        tenant, platform, revisions: { state: 'available', rows } });
    }, { isolationLevel: 'REPEATABLE READ', readOnly: true }));
  } catch { refuse(); }
}
