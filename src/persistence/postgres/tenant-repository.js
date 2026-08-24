function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function createPostgresTenantRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

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
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        displayName: row.display_name,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    },
  });
}
