import { selectEffectiveTenantBookingPolicy } from '../../domain/tenant-booking-policies.js';
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
    price: row.price_minor === null
      ? null
      : Object.freeze({ amountMinor: Number(row.price_minor), currency: row.currency }),
  });
}

function publicApplicability(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    order: Number(row.sort_order),
    price: Object.freeze({ amountMinor: Number(row.price_minor), currency: row.currency }),
    siteIds: Object.freeze(row.site_ids ?? []),
    roomIds: Object.freeze(row.room_ids ?? []),
  });
}

function publicVariant(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    order: Number(row.sort_order),
    price: Object.freeze({ amountMinor: Number(row.price_minor), currency: row.currency }),
  });
}

function publicPackage(row, variants) {
  return Object.freeze({
    ...publicApplicability(row),
    itemIds: Object.freeze(row.item_ids ?? []),
    variants: Object.freeze((variants.get(row.id) ?? []).map(publicVariant)),
  });
}

function publicCostCenter(row) {
  return Object.freeze({
    id: row.id,
    code: row.code,
    name: row.name,
    group: row.group_name ?? null,
  });
}

function publicBookingPolicy(row) {
  const evaluatedAt = row.evaluated_at;
  if (!(evaluatedAt instanceof Date) || Number.isNaN(evaluatedAt.getTime())) {
    throw new Error('APPLICATION_BOOKING_POLICY_STATE_INVALID');
  }
  const selected = selectEffectiveTenantBookingPolicy(row.configuration, evaluatedAt);
  return Object.freeze({
    policyVersionId: selected.id,
    effectiveFrom: selected.effectiveFrom,
    evaluatedAt: evaluatedAt.toISOString(),
    rules: selected.rules,
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

const CATALOG_PAGE_SECTIONS = new Set([
  'sites',
  'rooms',
  'services',
  'equipment',
  'cateringPackages',
  'cateringItems',
  'costCenters',
]);
const CONFIGURATION_REVISION_KEYS = Object.freeze([
  'organization',
  'locations',
  'catalogue',
  'bookingPolicies',
  'costAllocation',
]);

function publicConfigurationRevisions(row) {
  return Object.freeze({
    organization: Number(row.organization_revision),
    locations: Number(row.locations_revision),
    catalogue: Number(row.catalog_revision),
    bookingPolicies: Number(row.booking_policies_revision),
    costAllocation: Number(row.cost_allocation_revision),
  });
}

function catalogPageContextMatches(context, expectedRevisions, expectedPolicyVersionId) {
  if (expectedRevisions === null) return expectedPolicyVersionId === null;
  if (!expectedRevisions || expectedPolicyVersionId === null) return false;
  return CONFIGURATION_REVISION_KEYS.every((key) => (
    context.configurationRevisions[key] === expectedRevisions[key]
  )) && context.bookingPolicy.policyVersionId === expectedPolicyVersionId;
}

async function loadCatalogPageContext(client, tenantId) {
  const revisions = await client.query({
    name: 'application-catalogue-page-revisions',
    text: `
      SELECT tenant.organization_revision, tenant.locations_revision,
        tenant.catalog_revision, tenant.booking_policies_revision,
        tenant.cost_allocation_revision, organization.default_currency
      FROM tenants tenant
      JOIN tenant_organization_settings organization
        ON organization.tenant_id = tenant.id
      WHERE tenant.id = $1
    `,
    values: [tenantId],
  });
  if (!revisions.rows[0]) return null;
  const bookingPolicy = await client.query({
    name: 'application-catalogue-page-booking-policy',
    text: `
      SELECT configuration, transaction_timestamp() AS evaluated_at
      FROM tenant_booking_policy_configuration
      WHERE tenant_id = $1
    `,
    values: [tenantId],
  });
  const costAllocation = await client.query({
    name: 'application-catalogue-page-cost-allocation',
    text: `
      SELECT allocation_required
      FROM tenant_cost_allocation_configuration
      WHERE tenant_id = $1
    `,
    values: [tenantId],
  });
  if (!bookingPolicy.rows[0] || !costAllocation.rows[0]) {
    throw new Error('APPLICATION_CATALOGUE_STATE_INVALID');
  }
  return Object.freeze({
    configurationRevisions: publicConfigurationRevisions(revisions.rows[0]),
    defaultCurrency: revisions.rows[0].default_currency,
    bookingPolicy: publicBookingPolicy(bookingPolicy.rows[0]),
    allocationRequired: costAllocation.rows[0].allocation_required,
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
      return withPostgresTransaction(pool, async (client) => {
        const revisions = await client.query({
          name: 'application-catalogue-revisions',
          text: `
            SELECT organization_revision, locations_revision, catalog_revision,
              booking_policies_revision, cost_allocation_revision
            FROM tenants
            WHERE id = $1
          `,
          values: [tenantId],
        });
        if (!revisions.rows[0]) return null;
        const bookingPolicy = await client.query({
          name: 'application-effective-booking-policy',
          text: `
            SELECT configuration, transaction_timestamp() AS evaluated_at
            FROM tenant_booking_policy_configuration
            WHERE tenant_id = $1
          `,
          values: [tenantId],
        });
        if (!bookingPolicy.rows[0]) {
          throw new Error('APPLICATION_BOOKING_POLICY_STATE_INVALID');
        }
        const sites = await client.query({
          name: 'application-sites-list',
          text: 'SELECT id, name, active, time_zone FROM sites WHERE tenant_id = $1 ORDER BY id',
          values: [tenantId],
        });
        const rooms = await client.query({
          name: 'application-rooms-list',
          text: `
            SELECT room.id, room.site_id, room.name, room.capacity, room.active,
              price.price_minor, price.currency
            FROM rooms room
            LEFT JOIN tenant_room_prices price
              ON price.tenant_id = room.tenant_id AND price.room_id = room.id
            WHERE room.tenant_id = $1
            ORDER BY room.id
          `,
          values: [tenantId],
        });
        const services = await client.query({
          name: 'application-services-list',
          text: `
            SELECT service.id, service.name, service.description, service.active,
              service.sort_order, service.price_minor, service.currency,
              ARRAY(
                SELECT relation.site_id
                FROM service_site_applicability relation
                WHERE relation.tenant_id = service.tenant_id
                  AND relation.service_id = service.id
                ORDER BY relation.site_id
              ) AS site_ids,
              ARRAY(
                SELECT relation.room_id
                FROM service_room_applicability relation
                WHERE relation.tenant_id = service.tenant_id
                  AND relation.service_id = service.id
                ORDER BY relation.room_id
              ) AS room_ids
            FROM services service
            WHERE service.tenant_id = $1
            ORDER BY service.sort_order, service.id
          `,
          values: [tenantId],
        });
        const packages = await client.query({
          name: 'application-catering-packages-list',
          text: `
            SELECT catering_package.id, catering_package.name, catering_package.description,
              catering_package.active, catering_package.sort_order,
              catering_package.price_minor, catering_package.currency,
              ARRAY(
                SELECT relation.site_id
                FROM catering_package_site_applicability relation
                WHERE relation.tenant_id = catering_package.tenant_id
                  AND relation.package_id = catering_package.id
                ORDER BY relation.site_id
              ) AS site_ids,
              ARRAY(
                SELECT relation.room_id
                FROM catering_package_room_applicability relation
                WHERE relation.tenant_id = catering_package.tenant_id
                  AND relation.package_id = catering_package.id
                ORDER BY relation.room_id
              ) AS room_ids,
              ARRAY(
                SELECT relation.item_id
                FROM catering_package_items relation
                WHERE relation.tenant_id = catering_package.tenant_id
                  AND relation.package_id = catering_package.id
                ORDER BY relation.item_id
              ) AS item_ids
            FROM catering_packages catering_package
            WHERE catering_package.tenant_id = $1
            ORDER BY catering_package.sort_order, catering_package.id
          `,
          values: [tenantId],
        });
        const variants = await client.query({
          name: 'application-catering-package-variants-list',
          text: `
            SELECT package_id, id, name, description, active, sort_order, price_minor, currency
            FROM catering_package_variants
            WHERE tenant_id = $1
            ORDER BY package_id, sort_order, id
          `,
          values: [tenantId],
        });
        const items = await client.query({
          name: 'application-catering-items-list',
          text: `
            SELECT item.id, item.name, item.description, item.active, item.sort_order,
              item.price_minor, item.currency,
              ARRAY(
                SELECT relation.site_id
                FROM catering_item_site_applicability relation
                WHERE relation.tenant_id = item.tenant_id
                  AND relation.item_id = item.id
                ORDER BY relation.site_id
              ) AS site_ids,
              ARRAY(
                SELECT relation.room_id
                FROM catering_item_room_applicability relation
                WHERE relation.tenant_id = item.tenant_id
                  AND relation.item_id = item.id
                ORDER BY relation.room_id
              ) AS room_ids
            FROM catering_items item
            WHERE item.tenant_id = $1
            ORDER BY item.sort_order, item.id
          `,
          values: [tenantId],
        });
        const costAllocation = await client.query({
          name: 'application-cost-allocation',
          text: `
            SELECT allocation_required
            FROM tenant_cost_allocation_configuration
            WHERE tenant_id = $1
          `,
          values: [tenantId],
        });
        if (!costAllocation.rows[0]) {
          throw new Error('APPLICATION_COST_ALLOCATION_STATE_INVALID');
        }
        const costCenters = await client.query({
          name: 'application-active-cost-centers',
          text: `
            SELECT id, code, name, group_name
            FROM tenant_cost_centers
            WHERE tenant_id = $1 AND active = TRUE
            ORDER BY code, id
          `,
          values: [tenantId],
        });
        const variantsByPackage = new Map();
        for (const variant of variants.rows) {
          const entries = variantsByPackage.get(variant.package_id) ?? [];
          entries.push(variant);
          variantsByPackage.set(variant.package_id, entries);
        }
        const revision = revisions.rows[0];
        return Object.freeze({
          configurationRevisions: Object.freeze({
            organization: Number(revision.organization_revision),
            locations: Number(revision.locations_revision),
            catalogue: Number(revision.catalog_revision),
            bookingPolicies: Number(revision.booking_policies_revision),
            costAllocation: Number(revision.cost_allocation_revision),
          }),
          sites: Object.freeze(sites.rows.map(publicSite)),
          rooms: Object.freeze(rooms.rows.map(publicRoom)),
          services: Object.freeze(services.rows.map(publicApplicability)),
          cateringPackages: Object.freeze(packages.rows.map((row) => (
            publicPackage(row, variantsByPackage)
          ))),
          cateringItems: Object.freeze(items.rows.map(publicApplicability)),
          bookingPolicy: publicBookingPolicy(bookingPolicy.rows[0]),
          costAllocation: Object.freeze({
            allocationRequired: costAllocation.rows[0].allocation_required,
            costCenters: Object.freeze(costCenters.rows.map(publicCostCenter)),
          }),
        });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },

    async loadCatalogPage({
      tenantId,
      section,
      afterId = null,
      limit,
      expectedRevisions = null,
      expectedPolicyVersionId = null,
    }) {
      if (
        !CATALOG_PAGE_SECTIONS.has(section)
        || (afterId !== null && (typeof afterId !== 'string' || afterId.length > 128))
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 11
        || (expectedRevisions === null) !== (expectedPolicyVersionId === null)
      ) throw new TypeError('APPLICATION_CATALOGUE_PAGE_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const context = await loadCatalogPageContext(client, tenantId);
        if (!context) return Object.freeze({ status: 'not_found' });
        if (!catalogPageContextMatches(context, expectedRevisions, expectedPolicyVersionId)) {
          return Object.freeze({ status: 'stale' });
        }

        let rows;
        if (section === 'sites') {
          rows = await client.query({
            name: 'application-catalogue-page-sites',
            text: `
              SELECT id, name, active, time_zone
              FROM sites
              WHERE tenant_id = $1
                AND active = TRUE
                AND ($2::varchar IS NULL OR id > $2)
              ORDER BY id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else if (section === 'rooms') {
          rows = await client.query({
            name: 'application-catalogue-page-rooms',
            text: `
              SELECT room.id, room.site_id, room.name, room.capacity, room.active,
                price.price_minor, price.currency
              FROM rooms room
              JOIN sites site
                ON site.tenant_id = room.tenant_id
               AND site.id = room.site_id
               AND site.active = TRUE
              JOIN tenant_room_prices price
                ON price.tenant_id = room.tenant_id
               AND price.room_id = room.id
              WHERE room.tenant_id = $1
                AND room.active = TRUE
                AND ($2::varchar IS NULL OR room.id > $2)
              ORDER BY room.id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else if (section === 'services') {
          rows = await client.query({
            name: 'application-catalogue-page-services',
            text: `
              SELECT service.id, service.name, service.description, service.active,
                service.sort_order, service.price_minor, service.currency,
                ARRAY(
                  SELECT relation.site_id
                  FROM service_site_applicability relation
                  WHERE relation.tenant_id = service.tenant_id
                    AND relation.service_id = service.id
                  ORDER BY relation.site_id
                ) AS site_ids,
                ARRAY(
                  SELECT relation.room_id
                  FROM service_room_applicability relation
                  WHERE relation.tenant_id = service.tenant_id
                    AND relation.service_id = service.id
                  ORDER BY relation.room_id
                ) AS room_ids
              FROM services service
              WHERE service.tenant_id = $1
                AND service.active = TRUE
                AND ($2::varchar IS NULL OR service.id > $2)
              ORDER BY service.id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else if (section === 'equipment') {
          rows = await client.query({
            name: 'application-catalogue-page-equipment',
            text: `
              SELECT equipment_entry.id, equipment_entry.name,
                equipment_entry.description, equipment_entry.active,
                equipment_entry.sort_order, equipment_entry.price_minor,
                equipment_entry.currency,
                ARRAY(
                  SELECT site_relation.site_id
                  FROM equipment_site_applicability site_relation
                  WHERE site_relation.tenant_id = $1
                    AND site_relation.tenant_id = equipment_entry.tenant_id
                    AND site_relation.equipment_id = equipment_entry.id
                  ORDER BY site_relation.site_id
                ) AS site_ids,
                ARRAY(
                  SELECT room_relation.room_id
                  FROM equipment_room_applicability room_relation
                  WHERE room_relation.tenant_id = $1
                    AND room_relation.tenant_id = equipment_entry.tenant_id
                    AND room_relation.equipment_id = equipment_entry.id
                  ORDER BY room_relation.room_id
                ) AS room_ids
              FROM equipment equipment_entry
              WHERE equipment_entry.tenant_id = $1
                AND equipment_entry.active = TRUE
                AND ($2::varchar IS NULL OR equipment_entry.id > $2)
              ORDER BY equipment_entry.id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else if (section === 'cateringPackages') {
          rows = await client.query({
            name: 'application-catalogue-page-packages',
            text: `
              SELECT catering_package.id, catering_package.name,
                catering_package.description, catering_package.active,
                catering_package.sort_order, catering_package.price_minor,
                catering_package.currency,
                ARRAY(
                  SELECT relation.site_id
                  FROM catering_package_site_applicability relation
                  WHERE relation.tenant_id = catering_package.tenant_id
                    AND relation.package_id = catering_package.id
                  ORDER BY relation.site_id
                ) AS site_ids,
                ARRAY(
                  SELECT relation.room_id
                  FROM catering_package_room_applicability relation
                  WHERE relation.tenant_id = catering_package.tenant_id
                    AND relation.package_id = catering_package.id
                  ORDER BY relation.room_id
                ) AS room_ids,
                ARRAY(
                  SELECT relation.item_id
                  FROM catering_package_items relation
                  WHERE relation.tenant_id = catering_package.tenant_id
                    AND relation.package_id = catering_package.id
                  ORDER BY relation.item_id
                ) AS item_ids
              FROM catering_packages catering_package
              WHERE catering_package.tenant_id = $1
                AND catering_package.active = TRUE
                AND EXISTS (
                  SELECT 1
                  FROM catering_package_variants variant
                  WHERE variant.tenant_id = catering_package.tenant_id
                    AND variant.package_id = catering_package.id
                    AND variant.active = TRUE
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM catering_package_items relation
                  JOIN catering_items item
                    ON item.tenant_id = relation.tenant_id
                   AND item.id = relation.item_id
                  WHERE relation.tenant_id = catering_package.tenant_id
                    AND relation.package_id = catering_package.id
                    AND item.active = FALSE
                )
                AND ($2::varchar IS NULL OR catering_package.id > $2)
              ORDER BY catering_package.id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else if (section === 'cateringItems') {
          rows = await client.query({
            name: 'application-catalogue-page-items',
            text: `
              SELECT item.id, item.name, item.description, item.active, item.sort_order,
                item.price_minor, item.currency,
                ARRAY(
                  SELECT relation.site_id
                  FROM catering_item_site_applicability relation
                  WHERE relation.tenant_id = item.tenant_id
                    AND relation.item_id = item.id
                  ORDER BY relation.site_id
                ) AS site_ids,
                ARRAY(
                  SELECT relation.room_id
                  FROM catering_item_room_applicability relation
                  WHERE relation.tenant_id = item.tenant_id
                    AND relation.item_id = item.id
                  ORDER BY relation.room_id
                ) AS room_ids
              FROM catering_items item
              WHERE item.tenant_id = $1
                AND item.active = TRUE
                AND ($2::varchar IS NULL OR item.id > $2)
              ORDER BY item.id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        } else {
          rows = await client.query({
            name: 'application-catalogue-page-cost-centers',
            text: `
              SELECT id, code, name, group_name
              FROM tenant_cost_centers
              WHERE tenant_id = $1
                AND active = TRUE
                AND ($2::varchar IS NULL OR id > $2)
              ORDER BY id
              LIMIT $3
            `,
            values: [tenantId, afterId, limit],
          });
        }

        let entries;
        if (section === 'sites') entries = rows.rows.map(publicSite);
        else if (section === 'rooms') entries = rows.rows.map(publicRoom);
        else if (['services', 'equipment', 'cateringItems'].includes(section)) {
          entries = rows.rows.map(publicApplicability);
        } else if (section === 'costCenters') entries = rows.rows.map(publicCostCenter);
        else {
          const ids = rows.rows.map((row) => row.id);
          const variants = ids.length === 0
            ? { rows: [] }
            : await client.query({
              name: 'application-catalogue-page-package-variants',
              text: `
                SELECT package_id, id, name, description, active, sort_order,
                  price_minor, currency
                FROM catering_package_variants
                WHERE tenant_id = $1
                  AND package_id = ANY($2::varchar[])
                  AND active = TRUE
                ORDER BY package_id, sort_order, id
              `,
              values: [tenantId, ids],
            });
          const variantsByPackage = new Map();
          for (const variant of variants.rows) {
            const current = variantsByPackage.get(variant.package_id) ?? [];
            current.push(variant);
            variantsByPackage.set(variant.package_id, current);
          }
          entries = rows.rows.map((row) => publicPackage(row, variantsByPackage));
        }
        return Object.freeze({
          status: 'ready',
          ...context,
          entries: Object.freeze(entries),
        });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },

    async loadSites(tenantId) {
      const result = await pool.query({
        name: 'application-sites-presentation-list',
        text: 'SELECT id, name, active, time_zone FROM sites WHERE tenant_id = $1 ORDER BY id',
        values: [tenantId],
      });
      return Object.freeze(result.rows.map(publicSite));
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
