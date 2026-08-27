import { withPostgresTransaction } from './transaction.js';

function publicSite(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    active: row.active,
    timeZone: row.time_zone ?? null,
  });
}

function publicRoom(row) {
  return Object.freeze({
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    capacity: row.capacity,
    active: row.active,
  });
}

function publicPriced(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    active: row.active,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
  });
}

function publicNotification(row) {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at ? row.read_at.toISOString() : null,
  });
}

export function createPostgresApplicationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async findProfile(tenantId, userId) {
      const result = await pool.query({
        name: 'application-profile-find',
        text: `
          SELECT display_name
          FROM users
          WHERE tenant_id = $1 AND id = $2 AND active = true
        `,
        values: [tenantId, userId],
      });
      return result.rows[0]
        ? Object.freeze({ displayName: result.rows[0].display_name })
        : null;
    },

    async updateProfile({ tenantId, userId, displayName, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'application-profile-update',
          text: `
            UPDATE users
            SET display_name = $3, updated_at = $4
            WHERE tenant_id = $1 AND id = $2 AND active = true
            RETURNING display_name
          `,
          values: [tenantId, userId, displayName, changedAt],
        });
        if (!result.rows[0]) return null;
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ displayName: result.rows[0].display_name });
      });
    },

    async loadCatalog(tenantId) {
      const [sites, rooms, services, packages, items] = await Promise.all([
        pool.query({
          name: 'application-sites-list',
          text: 'SELECT id, name, active, time_zone FROM sites WHERE tenant_id = $1 ORDER BY id',
          values: [tenantId],
        }),
        pool.query({
          name: 'application-rooms-list',
          text: 'SELECT id, site_id, name, capacity, active FROM rooms WHERE tenant_id = $1 ORDER BY id',
          values: [tenantId],
        }),
        pool.query({
          name: 'application-services-list',
          text: `
            SELECT id, name, active, price_minor, currency
            FROM services WHERE tenant_id = $1 ORDER BY id
          `,
          values: [tenantId],
        }),
        pool.query({
          name: 'application-catering-packages-list',
          text: `
            SELECT id, name, active, price_minor, currency
            FROM catering_packages WHERE tenant_id = $1 ORDER BY id
          `,
          values: [tenantId],
        }),
        pool.query({
          name: 'application-catering-items-list',
          text: `
            SELECT id, name, active, price_minor, currency
            FROM catering_items WHERE tenant_id = $1 ORDER BY id
          `,
          values: [tenantId],
        }),
      ]);
      return Object.freeze({
        sites: Object.freeze(sites.rows.map(publicSite)),
        rooms: Object.freeze(rooms.rows.map(publicRoom)),
        services: Object.freeze(services.rows.map(publicPriced)),
        cateringPackages: Object.freeze(packages.rows.map(publicPriced)),
        cateringItems: Object.freeze(items.rows.map(publicPriced)),
      });
    },

    async findRoomBookingContext(tenantId, roomId) {
      const result = await pool.query({
        name: 'application-room-booking-context-find',
        text: `
          SELECT rooms.active AS room_active, sites.active AS site_active, sites.time_zone
          FROM rooms
          JOIN sites
            ON sites.tenant_id = rooms.tenant_id
           AND sites.id = rooms.site_id
          WHERE rooms.tenant_id = $1 AND rooms.id = $2
        `,
        values: [tenantId, roomId],
      });
      return result.rows[0]
        ? Object.freeze({
          roomActive: result.rows[0].room_active,
          siteActive: result.rows[0].site_active,
          timeZone: result.rows[0].time_zone ?? null,
        })
        : null;
    },

    async listNotifications(tenantId, userId, limit = 200) {
      const result = await pool.query({
        name: 'application-notifications-list',
        text: `
          SELECT id, kind, created_at, read_at
          FROM notifications
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at DESC, id
          LIMIT $3
        `,
        values: [tenantId, userId, limit],
      });
      return Object.freeze(result.rows.map(publicNotification));
    },

    async markNotificationRead(tenantId, userId, notificationId, readAt) {
      const result = await pool.query({
        name: 'application-notification-mark-read',
        text: `
          UPDATE notifications
          SET read_at = COALESCE(read_at, $4)
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3
          RETURNING id, kind, created_at, read_at
        `,
        values: [tenantId, userId, notificationId, readAt],
      });
      return result.rows[0] ? publicNotification(result.rows[0]) : null;
    },
  });
}
