function mapRoom(row) {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    capacity: row.capacity,
    active: row.active,
  };
}

function nullable(value) {
  return value === undefined ? null : value;
}

export function createPostgresRoomAdapter(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  return Object.freeze({
    async findByTenantIdAndId(tenantId, id) {
      const result = await pool.query({
        name: 'room-find-by-tenant-and-id',
        text: `
          SELECT tenant_id, id, site_id, name, capacity, active
          FROM rooms
          WHERE tenant_id = $1 AND id = $2
        `,
        values: [tenantId, id],
      });
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    },

    async listByTenantId(tenantId) {
      const result = await pool.query({
        name: 'room-list-by-tenant',
        text: `
          SELECT tenant_id, id, site_id, name, capacity, active
          FROM rooms
          WHERE tenant_id = $1
          ORDER BY id
        `,
        values: [tenantId],
      });
      return result.rows.map(mapRoom);
    },

    async insertForTenant(tenantId, value) {
      const result = await pool.query({
        name: 'room-insert-for-tenant',
        text: `
          INSERT INTO rooms (tenant_id, id, site_id, name, capacity, active)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING tenant_id, id, site_id, name, capacity, active
        `,
        values: [tenantId, value.id, value.siteId, value.name, value.capacity, value.active ?? true],
      });
      return mapRoom(result.rows[0]);
    },

    async updateByTenantIdAndId(tenantId, id, value) {
      const result = await pool.query({
        name: 'room-update-by-tenant-and-id',
        text: `
          UPDATE rooms
          SET site_id = COALESCE($3, site_id),
              name = COALESCE($4, name),
              capacity = COALESCE($5, capacity),
              active = COALESCE($6, active),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
          RETURNING tenant_id, id, site_id, name, capacity, active
        `,
        values: [
          tenantId,
          id,
          nullable(value.siteId),
          nullable(value.name),
          nullable(value.capacity),
          nullable(value.active),
        ],
      });
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    },

    async deleteByTenantIdAndId(tenantId, id) {
      const result = await pool.query({
        name: 'room-delete-by-tenant-and-id',
        text: 'DELETE FROM rooms WHERE tenant_id = $1 AND id = $2',
        values: [tenantId, id],
      });
      return result.rowCount === 1;
    },
  });
}
