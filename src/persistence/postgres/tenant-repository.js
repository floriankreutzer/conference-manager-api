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
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
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
  });
}
