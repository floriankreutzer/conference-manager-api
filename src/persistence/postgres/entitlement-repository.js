import { withPostgresTransaction } from './transaction.js';

function mapEntitlementRow(row, fallback) {
  if (!row) return fallback || null;
  return Object.freeze({
    tenantId: row.tenant_id,
    capabilityId: row.capability_id,
    enabled: row.enabled,
    updatedAt: row.updated_at.toISOString(),
  });
}

export function createPostgresEntitlementRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async findByTenantIdAndCapabilityId(tenantId, capabilityId) {
      const result = await pool.query({
        name: 'entitlement-find-by-tenant-and-capability',
        text: `
          SELECT tenant_id, capability_id, enabled, updated_at
          FROM tenant_entitlements
          WHERE tenant_id = $1
            AND capability_id = $2
          LIMIT 1
        `,
        values: [tenantId, capabilityId],
      });
      return mapEntitlementRow(result.rows[0]);
    },

    async changeByTenantIdAndCapabilityId({
      tenantId,
      capabilityId,
      enabled,
      changedAt,
      auditEventForPrevious,
    }) {
      if (typeof auditEventForPrevious !== 'function') throw new TypeError('AUDIT_EVENT_FACTORY_REQUIRED');
      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          values: [`entitlement:${tenantId}:${capabilityId}`],
        });
        const tenant = await client.query({
          name: 'entitlement-tenant-exists',
          text: 'SELECT 1 FROM tenants WHERE id = $1 FOR SHARE',
          values: [tenantId],
        });
        if (tenant.rowCount !== 1) return null;

        const current = await client.query({
          name: 'entitlement-current-for-update',
          text: `
            SELECT tenant_id, capability_id, enabled, updated_at
            FROM tenant_entitlements
            WHERE tenant_id = $1
              AND capability_id = $2
            FOR UPDATE
          `,
          values: [tenantId, capabilityId],
        });
        const previousEnabled = current.rows[0]?.enabled === true;
        if (current.rowCount === 0 && enabled === false) {
          return Object.freeze({ tenantId, capabilityId, enabled: false, updatedAt: null });
        }
        if (current.rowCount === 1 && previousEnabled === enabled) return mapEntitlementRow(current.rows[0]);

        const result = await client.query({
          name: 'entitlement-upsert-by-tenant-and-capability',
          text: `
            INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, capability_id)
            DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
            RETURNING tenant_id, capability_id, enabled, updated_at
          `,
          values: [tenantId, capabilityId, enabled, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEventForPrevious(previousEnabled));
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return mapEntitlementRow(result.rows[0]);
      });
    },
  });
}
