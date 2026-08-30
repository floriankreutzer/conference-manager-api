import { withPostgresTransaction } from './transaction.js';

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapTenant(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

async function requireAuthoritativeReadiness(client, tenantId) {
  const connection = await client.query({
    name: 'tenant-pilot-lock-ready-connection',
    text: `
      SELECT id, provider_reference
      FROM integrations
      WHERE tenant_id = $1
        AND provider = 'microsoft365'
        AND status = 'connected'
        AND places_permission_status = 'granted'
        AND calendars_permission_status = 'granted'
      FOR SHARE
    `,
    values: [tenantId],
  });
  if (connection.rowCount !== 1) return false;
  const integration = connection.rows[0];
  const [binding, mapping, health, entitlements] = await Promise.all([
    client.query({
      name: 'tenant-pilot-lock-ready-binding',
      text: `
        SELECT 1 FROM tenant_identity_bindings
        WHERE tenant_id = $1 AND provider = 'microsoft_entra'
          AND provider_tenant_reference = $2 AND status = 'active'
        FOR SHARE
      `,
      values: [tenantId, integration.provider_reference],
    }),
    client.query({
      name: 'tenant-pilot-lock-ready-room',
      text: `
        SELECT 1 FROM microsoft365_room_mappings
        WHERE tenant_id = $1 AND integration_id = $2 AND provider_status = 'active'
        LIMIT 1 FOR SHARE
      `,
      values: [tenantId, integration.id],
    }),
    client.query({
      name: 'tenant-pilot-lock-ready-free-busy',
      text: `
        SELECT 1 FROM microsoft365_capability_health
        WHERE tenant_id = $1 AND integration_id = $2
          AND capability = 'free_busy' AND status = 'healthy'
          AND last_success_at IS NOT NULL
        FOR SHARE
      `,
      values: [tenantId, integration.id],
    }),
    client.query({
      name: 'tenant-pilot-lock-ready-entitlements',
      text: `
        SELECT capability_id FROM tenant_entitlements
        WHERE tenant_id = $1
          AND capability_id = ANY($2::varchar[])
          AND enabled = TRUE
        FOR SHARE
      `,
      values: [tenantId, ['microsoft.directory', 'microsoft.calendar']],
    }),
  ]);
  return binding.rowCount === 1
    && mapping.rowCount === 1
    && health.rowCount === 1
    && entitlements.rowCount === 2;
}

export async function changeTenantStatusWithClient(client, {
  tenantId,
  expectedStatus,
  expectedRevision = null,
  targetStatus,
  changedAt,
  requireReady = false,
} = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  const current = await client.query({
    name: 'tenant-lifecycle-lock-current',
    text: `
      SELECT id, display_name, status, lifecycle_revision, customer_session_revision,
        created_at, updated_at
      FROM tenants
      WHERE id = $1 AND status = $2
      FOR UPDATE
    `,
    values: [tenantId, expectedStatus],
  });
  if (current.rowCount !== 1) return Object.freeze({ outcome: 'stale' });
  if (expectedRevision !== null && Number(current.rows[0].lifecycle_revision) !== expectedRevision) {
    return Object.freeze({ outcome: 'stale' });
  }
  if (requireReady && !await requireAuthoritativeReadiness(client, tenantId)) {
    return Object.freeze({ outcome: 'not_ready' });
  }
  const revokeCustomerSessions = ['suspended', 'archived'].includes(targetStatus);
  const result = await client.query({
    name: 'tenant-lifecycle-change-cas',
    text: `
      UPDATE tenants
      SET status = $3,
          customer_session_revision = customer_session_revision + CASE WHEN $5 THEN 1 ELSE 0 END,
          updated_at = $4
      WHERE id = $1 AND status = $2
        AND ($6::bigint IS NULL OR lifecycle_revision = $6)
      RETURNING id, display_name, status, lifecycle_revision,
        customer_session_revision, created_at, updated_at
    `,
    values: [tenantId, expectedStatus, targetStatus, changedAt, revokeCustomerSessions, expectedRevision],
  });
  if (result.rowCount !== 1) return Object.freeze({ outcome: 'stale' });
  let revokedSessionCount = 0;
  if (revokeCustomerSessions) {
    const revoked = await client.query({
      name: 'tenant-lifecycle-revoke-customer-sessions',
      text: `
        UPDATE sessions
        SET revoked_at = GREATEST(issued_at, $2::timestamptz)
        WHERE tenant_id = $1 AND revoked_at IS NULL
      `,
      values: [tenantId, changedAt],
    });
    revokedSessionCount = revoked.rowCount;
  }
  return Object.freeze({
    outcome: 'updated',
    tenant: mapTenant(result.rows[0]),
    revision: Number(result.rows[0].lifecycle_revision),
    customerSessionRevision: Number(result.rows[0].customer_session_revision),
    revokedSessionCount,
  });
}

export function createPostgresTenantRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }

  return Object.freeze({
    changeStatusWithClient: (client, values) => changeTenantStatusWithClient(client, values),

    async findLifecycleById(tenantId, { client = pool } = {}) {
      const result = await client.query({
        name: 'tenant-lifecycle-find-by-id',
        text: 'SELECT id, status, lifecycle_revision FROM tenants WHERE id = $1 LIMIT 1',
        values: [tenantId],
      });
      if (!result.rows[0]) return null;
      return Object.freeze({
        tenantId: result.rows[0].id,
        status: result.rows[0].status,
        revision: Number(result.rows[0].lifecycle_revision),
      });
    },

    async findById(tenantId) {
      const result = await pool.query({
        name: 'tenant-find-by-id',
        text: `
          SELECT id, display_name, status, created_at, updated_at
          FROM tenants
          WHERE id = $1
        `,
        values: [tenantId],
      });
      return mapTenant(result.rows[0]);
    },

    async changeStatus({ tenantId, expectedStatus, targetStatus, changedAt, auditEvent }) {
      if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
        throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const result = await changeTenantStatusWithClient(client, {
          tenantId, expectedStatus, targetStatus, changedAt,
        });
        if (result.outcome !== 'updated') return null;
        const appended = await auditRepository.appendWithClient(client, auditEvent);
        if (!appended) throw new Error('AUDIT_APPEND_FAILED');
        return result.tenant;
      });
    },

    async changeStatusIfReady({ tenantId, expectedStatus, targetStatus, changedAt, auditEvent }) {
      if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
        throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const result = await changeTenantStatusWithClient(client, {
          tenantId,
          expectedStatus,
          targetStatus,
          changedAt,
          requireReady: true,
        });
        if (result.outcome !== 'updated') return result;
        const appended = await auditRepository.appendWithClient(client, auditEvent);
        if (!appended) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ outcome: 'updated', tenant: result.tenant });
      });
    },
  });
}
