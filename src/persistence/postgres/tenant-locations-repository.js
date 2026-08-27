import { withPostgresTransaction } from './transaction.js';

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function createPostgresTenantLocationsRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function read(tenantId, client = pool) {
    const [tenant, sites, rooms, services, packages, mappings] = await Promise.all([
      client.query({
        name: 'tenant-locations-revision-get',
        text: 'SELECT locations_revision FROM tenants WHERE id = $1',
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-locations-sites-get',
        text: `SELECT id, name, active, time_zone, description, sort_order
               FROM sites WHERE tenant_id = $1 ORDER BY sort_order, id`,
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-locations-rooms-get',
        text: `SELECT id, site_id, name, capacity, active, description, floor_label, sort_order
               FROM rooms WHERE tenant_id = $1 ORDER BY sort_order, id`,
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-locations-room-services-get',
        text: 'SELECT room_id, service_id FROM room_service_availability WHERE tenant_id = $1 ORDER BY room_id, service_id',
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-locations-room-packages-get',
        text: 'SELECT room_id, catering_package_id FROM room_catering_package_availability WHERE tenant_id = $1 ORDER BY room_id, catering_package_id',
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-locations-mappings-get',
        text: `SELECT room_id, provider_display_name, provider_capacity, provider_status, last_seen_at
               FROM microsoft365_room_mappings WHERE tenant_id = $1`,
        values: [tenantId],
      }),
    ]);
    if (!tenant.rows[0]) return null;
    const serviceIds = new Map();
    for (const row of services.rows) {
      if (!serviceIds.has(row.room_id)) serviceIds.set(row.room_id, []);
      serviceIds.get(row.room_id).push(row.service_id);
    }
    const packageIds = new Map();
    for (const row of packages.rows) {
      if (!packageIds.has(row.room_id)) packageIds.set(row.room_id, []);
      packageIds.get(row.room_id).push(row.catering_package_id);
    }
    const provider = new Map(mappings.rows.map((row) => [row.room_id, Object.freeze({
      displayName: row.provider_display_name,
      capacity: row.provider_capacity,
      status: row.provider_status,
      lastSeenAt: iso(row.last_seen_at),
    })]));
    return Object.freeze({
      revision: Number(tenant.rows[0].locations_revision),
      locations: Object.freeze({
        sites: Object.freeze(sites.rows.map((row) => Object.freeze({
          id: row.id,
          name: row.name,
          active: row.active,
          timeZone: row.time_zone,
          description: row.description ?? null,
          sortOrder: row.sort_order,
        }))),
        rooms: Object.freeze(rooms.rows.map((row) => Object.freeze({
          id: row.id,
          siteId: row.site_id,
          name: row.name,
          capacity: row.capacity,
          active: row.active,
          description: row.description ?? null,
          floorLabel: row.floor_label ?? null,
          sortOrder: row.sort_order,
          serviceIds: Object.freeze(serviceIds.get(row.id) || []),
          cateringPackageIds: Object.freeze(packageIds.get(row.id) || []),
          provider: provider.get(row.id) || null,
        }))),
      }),
    });
  }

  async function allReferencesExist(client, tenantId, locations) {
    const serviceIds = [...new Set(locations.rooms.flatMap((room) => room.serviceIds))];
    const packageIds = [...new Set(locations.rooms.flatMap((room) => room.cateringPackageIds))];
    const [services, packages] = await Promise.all([
      serviceIds.length === 0 ? { rows: [] } : client.query({
        name: 'tenant-locations-service-ref-check',
        text: 'SELECT id FROM services WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
        values: [tenantId, serviceIds],
      }),
      packageIds.length === 0 ? { rows: [] } : client.query({
        name: 'tenant-locations-package-ref-check',
        text: 'SELECT id FROM catering_packages WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
        values: [tenantId, packageIds],
      }),
    ]);
    return services.rows.length === serviceIds.length && packages.rows.length === packageIds.length;
  }

  async function deactivationProtected(client, tenantId, locations, changedAt) {
    const disabledRooms = locations.rooms.filter((room) => !room.active).map((room) => room.id);
    const disabledSites = locations.sites.filter((site) => !site.active).map((site) => site.id);
    if (disabledRooms.length === 0 && disabledSites.length === 0) return false;
    const result = await client.query({
      name: 'tenant-locations-deactivation-protection',
      text: `
        SELECT 1
        FROM requests r
        JOIN rooms rm ON rm.tenant_id = r.tenant_id AND rm.id = r.room_id
        WHERE r.tenant_id = $1
          AND r.ends_at > $2
          AND r.status NOT IN ('Rejected', 'Cancelled')
          AND (r.room_id = ANY($3::varchar[]) OR rm.site_id = ANY($4::varchar[]))
        LIMIT 1
      `,
      values: [tenantId, changedAt, disabledRooms, disabledSites],
    });
    return Boolean(result.rows[0]);
  }

  return Object.freeze({
    get: (tenantId) => read(tenantId),

    async update({ tenantId, expectedRevision, locations, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-locations-lock',
          text: 'SELECT locations_revision FROM tenants WHERE id = $1 FOR UPDATE',
          values: [tenantId],
        });
        if (!locked.rows[0]) return null;
        const currentRevision = Number(locked.rows[0].locations_revision);
        if (currentRevision !== expectedRevision) return Object.freeze({ conflict: true, currentRevision });
        if (!await allReferencesExist(client, tenantId, locations)) return Object.freeze({ invalidReference: true });
        if (await deactivationProtected(client, tenantId, locations, changedAt)) return Object.freeze({ protectedReference: true });

        for (const site of locations.sites) {
          await client.query({
            name: 'tenant-location-site-upsert',
            text: `
              INSERT INTO sites (
                tenant_id, id, name, active, time_zone, description, sort_order, created_at, updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
              ON CONFLICT (tenant_id, id) DO UPDATE SET
                name = EXCLUDED.name,
                active = EXCLUDED.active,
                time_zone = EXCLUDED.time_zone,
                description = EXCLUDED.description,
                sort_order = EXCLUDED.sort_order,
                updated_at = EXCLUDED.updated_at
            `,
            values: [tenantId, site.id, site.name, site.active, site.timeZone, site.description, site.sortOrder, changedAt],
          });
        }

        for (const room of locations.rooms) {
          const updated = await client.query({
            name: 'tenant-location-room-update',
            text: `
              UPDATE rooms SET
                site_id = $3, name = $4, capacity = $5, active = $6,
                description = $7, floor_label = $8, sort_order = $9, updated_at = $10
              WHERE tenant_id = $1 AND id = $2
              RETURNING id
            `,
            values: [tenantId, room.id, room.siteId, room.name, room.capacity, room.active, room.description, room.floorLabel, room.sortOrder, changedAt],
          });
          if (!updated.rows[0]) return Object.freeze({ unknownRoom: true });
          await client.query({
            name: 'tenant-location-room-services-clear',
            text: 'DELETE FROM room_service_availability WHERE tenant_id = $1 AND room_id = $2',
            values: [tenantId, room.id],
          });
          for (const serviceId of room.serviceIds) {
            await client.query({
              name: 'tenant-location-room-service-add',
              text: 'INSERT INTO room_service_availability (tenant_id, room_id, service_id) VALUES ($1,$2,$3)',
              values: [tenantId, room.id, serviceId],
            });
          }
          await client.query({
            name: 'tenant-location-room-packages-clear',
            text: 'DELETE FROM room_catering_package_availability WHERE tenant_id = $1 AND room_id = $2',
            values: [tenantId, room.id],
          });
          for (const packageId of room.cateringPackageIds) {
            await client.query({
              name: 'tenant-location-room-package-add',
              text: 'INSERT INTO room_catering_package_availability (tenant_id, room_id, catering_package_id) VALUES ($1,$2,$3)',
              values: [tenantId, room.id, packageId],
            });
          }
        }

        await client.query({
          name: 'tenant-locations-revision-advance',
          text: `UPDATE tenants SET locations_revision = locations_revision + 1, updated_at = $2 WHERE id = $1`,
          values: [tenantId, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return read(tenantId, client);
      });
    },
  });
}
