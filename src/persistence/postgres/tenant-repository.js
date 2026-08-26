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

export function createPostgresTenantRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }

  return Object.freeze({
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
        const result = await client.query({
          name: 'tenant-change-status',
          text: `
            UPDATE tenants
            SET status = $3, updated_at = $4
            WHERE id = $1 AND status = $2
            RETURNING id, display_name, status, created_at, updated_at
          `,
          values: [tenantId, expectedStatus, targetStatus, changedAt],
        });
        const tenant = mapTenant(result.rows[0]);
        if (!tenant) return null;
        const appended = await auditRepository.appendWithClient(client, auditEvent);
        if (!appended) throw new Error('AUDIT_APPEND_FAILED');
        return tenant;
      });
    },

    async changeStatusIfReady({ tenantId, expectedStatus, targetStatus, changedAt, auditEvent }) {
      if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
        throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const current = await client.query({
          name: 'tenant-pilot-lock-lifecycle',
          text: `
            SELECT id, display_name, status, created_at, updated_at
            FROM tenants
            WHERE id = $1 AND status = $2
            FOR UPDATE
          `,
          values: [tenantId, expectedStatus],
        });
        if (current.rowCount !== 1) return Object.freeze({ outcome: 'stale' });
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
        if (connection.rowCount !== 1) return Object.freeze({ outcome: 'not_ready' });
        const integration = connection.rows[0];
        const binding = await client.query({
            name: 'tenant-pilot-lock-ready-binding',
            text: `
              SELECT 1
              FROM tenant_identity_bindings
              WHERE tenant_id = $1
                AND provider = 'microsoft_entra'
                AND provider_tenant_reference = $2
                AND status = 'active'
              FOR SHARE
            `,
            values: [tenantId, integration.provider_reference],
          });
        const mapping = await client.query({
            name: 'tenant-pilot-lock-ready-room',
            text: `
              SELECT 1
              FROM microsoft365_room_mappings
              WHERE tenant_id = $1 AND integration_id = $2 AND provider_status = 'active'
              LIMIT 1
              FOR SHARE
            `,
            values: [tenantId, integration.id],
          });
        const health = await client.query({
            name: 'tenant-pilot-lock-ready-free-busy',
            text: `
              SELECT 1
              FROM microsoft365_capability_health
              WHERE tenant_id = $1
                AND integration_id = $2
                AND capability = 'free_busy'
                AND status = 'healthy'
                AND last_success_at IS NOT NULL
              FOR SHARE
            `,
            values: [tenantId, integration.id],
          });
        const entitlements = await client.query({
            name: 'tenant-pilot-lock-ready-entitlements',
            text: `
              SELECT capability_id
              FROM tenant_entitlements
              WHERE tenant_id = $1
                AND capability_id = ANY($2::varchar[])
                AND enabled = TRUE
              FOR SHARE
            `,
            values: [tenantId, ['microsoft.directory', 'microsoft.calendar']],
          });
        if (
          binding.rowCount !== 1
          || mapping.rowCount !== 1
          || health.rowCount !== 1
          || entitlements.rowCount !== 2
        ) return Object.freeze({ outcome: 'not_ready' });
        const result = await client.query({
          name: 'tenant-change-status-if-ready',
          text: `
            UPDATE tenants
            SET status = $3, updated_at = $4
            WHERE id = $1 AND status = $2
            RETURNING id, display_name, status, created_at, updated_at
          `,
          values: [tenantId, expectedStatus, targetStatus, changedAt],
        });
        const tenant = mapTenant(result.rows[0]);
        if (!tenant) return Object.freeze({ outcome: 'stale' });
        const appended = await auditRepository.appendWithClient(client, auditEvent);
        if (!appended) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ outcome: 'updated', tenant });
      });
    },
  });
}
