import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeTenantCatalogue } from '../../domain/tenant-catalogue.js';
import { withPostgresTransaction } from './transaction.js';
import {
  finalizeTenantBulkTransferReceipt,
  lockTenantBulkTransferReceipt,
} from './tenant-bulk-transfer-transaction.js';

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function repositoryInputError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const APPLICABILITY_TABLES = Object.freeze([
  Object.freeze({ kind: 'service', scope: 'site', table: 'service_site_applicability', owner: 'service_id', target: 'site_id' }),
  Object.freeze({ kind: 'service', scope: 'room', table: 'service_room_applicability', owner: 'service_id', target: 'room_id' }),
  Object.freeze({ kind: 'equipment', scope: 'site', table: 'equipment_site_applicability', owner: 'equipment_id', target: 'site_id' }),
  Object.freeze({ kind: 'equipment', scope: 'room', table: 'equipment_room_applicability', owner: 'equipment_id', target: 'room_id' }),
  Object.freeze({ kind: 'package', scope: 'site', table: 'catering_package_site_applicability', owner: 'package_id', target: 'site_id' }),
  Object.freeze({ kind: 'package', scope: 'room', table: 'catering_package_room_applicability', owner: 'package_id', target: 'room_id' }),
  Object.freeze({ kind: 'item', scope: 'site', table: 'catering_item_site_applicability', owner: 'item_id', target: 'site_id' }),
  Object.freeze({ kind: 'item', scope: 'room', table: 'catering_item_room_applicability', owner: 'item_id', target: 'room_id' }),
]);

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
  return value.toLowerCase();
}

function requireResourceId(value, code) {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) throw new TypeError(code);
  return value;
}

function requireDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('TENANT_CATALOGUE_CHANGED_AT_INVALID');
  }
}

function moneyFromRow(row) {
  return Object.freeze({ amountMinor: Number(row.price_minor), currency: row.currency });
}

function relationMap(rows, ownerKey, targetKey) {
  const map = new Map();
  for (const row of rows) {
    const entries = map.get(row[ownerKey]) || [];
    entries.push(row[targetKey]);
    map.set(row[ownerKey], entries);
  }
  return map;
}

function simpleEntry(row, sites, rooms) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    price: moneyFromRow(row),
    active: row.active,
    order: Number(row.sort_order),
    siteIds: Object.freeze([...(sites.get(row.id) || [])].sort()),
    roomIds: Object.freeze([...(rooms.get(row.id) || [])].sort()),
  });
}

function variantFromRow(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    price: moneyFromRow(row),
    active: row.active,
    order: Number(row.sort_order),
  });
}

async function queryRows(client, name, table, tenantId, columns = '*') {
  const result = await client.query({
    name,
    text: `SELECT ${columns} FROM ${table} WHERE tenant_id = $1`,
    values: [tenantId],
  });
  return result.rows;
}

async function loadCurrentWithClient(client, tenantId, { lock = false } = {}) {
  const tenantResult = await client.query({
    name: lock ? 'tenant-catalogue-current-lock' : 'tenant-catalogue-current-tenant',
    text: `
      SELECT
        t.id,
        t.catalog_revision,
        COALESCE(r.effective_at, t.created_at) AS catalogue_effective_at
      FROM tenants t
      LEFT JOIN tenant_catalogue_revisions r
        ON r.tenant_id = t.id AND r.revision = t.catalog_revision
      WHERE t.id = $1
      ${lock ? 'FOR UPDATE OF t' : ''}
    `,
    values: [tenantId],
  });
  const tenant = tenantResult.rows[0];
  if (!tenant) return null;

  const [
    services,
    equipment,
    packages,
    items,
    variants,
    packageItems,
    serviceSites,
    serviceRooms,
    equipmentSites,
    equipmentRooms,
    packageSites,
    packageRooms,
    itemSites,
    itemRooms,
    roomPrices,
  ] = await Promise.all([
    queryRows(client, 'tenant-catalogue-services-read', 'services', tenantId,
      'id, name, description, price_minor, currency, active, sort_order'),
    queryRows(client, 'tenant-catalogue-equipment-read', 'equipment', tenantId,
      'id, name, description, price_minor, currency, active, sort_order'),
    queryRows(client, 'tenant-catalogue-packages-read', 'catering_packages', tenantId,
      'id, name, description, price_minor, currency, active, sort_order'),
    queryRows(client, 'tenant-catalogue-items-read', 'catering_items', tenantId,
      'id, name, description, price_minor, currency, active, sort_order'),
    queryRows(client, 'tenant-catalogue-variants-read', 'catering_package_variants', tenantId,
      'package_id, id, name, description, price_minor, currency, active, sort_order'),
    queryRows(client, 'tenant-catalogue-package-items-read', 'catering_package_items', tenantId,
      'package_id, item_id'),
    queryRows(client, 'tenant-catalogue-service-sites-read', 'service_site_applicability', tenantId,
      'service_id, site_id'),
    queryRows(client, 'tenant-catalogue-service-rooms-read', 'service_room_applicability', tenantId,
      'service_id, room_id'),
    queryRows(client, 'tenant-catalogue-equipment-sites-read', 'equipment_site_applicability', tenantId,
      'equipment_id, site_id'),
    queryRows(client, 'tenant-catalogue-equipment-rooms-read', 'equipment_room_applicability', tenantId,
      'equipment_id, room_id'),
    queryRows(client, 'tenant-catalogue-package-sites-read', 'catering_package_site_applicability', tenantId,
      'package_id, site_id'),
    queryRows(client, 'tenant-catalogue-package-rooms-read', 'catering_package_room_applicability', tenantId,
      'package_id, room_id'),
    queryRows(client, 'tenant-catalogue-item-sites-read', 'catering_item_site_applicability', tenantId,
      'item_id, site_id'),
    queryRows(client, 'tenant-catalogue-item-rooms-read', 'catering_item_room_applicability', tenantId,
      'item_id, room_id'),
    queryRows(client, 'tenant-catalogue-room-prices-read', 'tenant_room_prices', tenantId,
      'room_id, price_minor, currency'),
  ]);

  const serviceSiteMap = relationMap(serviceSites, 'service_id', 'site_id');
  const serviceRoomMap = relationMap(serviceRooms, 'service_id', 'room_id');
  const equipmentSiteMap = relationMap(equipmentSites, 'equipment_id', 'site_id');
  const equipmentRoomMap = relationMap(equipmentRooms, 'equipment_id', 'room_id');
  const packageSiteMap = relationMap(packageSites, 'package_id', 'site_id');
  const packageRoomMap = relationMap(packageRooms, 'package_id', 'room_id');
  const itemSiteMap = relationMap(itemSites, 'item_id', 'site_id');
  const itemRoomMap = relationMap(itemRooms, 'item_id', 'room_id');
  const packageItemMap = relationMap(packageItems, 'package_id', 'item_id');
  const variantMap = new Map();
  for (const row of variants) {
    const entries = variantMap.get(row.package_id) || [];
    entries.push(variantFromRow(row));
    variantMap.set(row.package_id, entries);
  }

  const catalogue = normalizeTenantCatalogue({
    services: services
      .map((row) => simpleEntry(row, serviceSiteMap, serviceRoomMap))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    equipment: equipment
      .map((row) => simpleEntry(row, equipmentSiteMap, equipmentRoomMap))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    cateringPackages: packages
      .map((row) => Object.freeze({
        ...simpleEntry(row, packageSiteMap, packageRoomMap),
        itemIds: Object.freeze([...(packageItemMap.get(row.id) || [])].sort()),
        variants: Object.freeze([...(variantMap.get(row.id) || [])]
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))),
      }))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    cateringItems: items
      .map((row) => simpleEntry(row, itemSiteMap, itemRoomMap))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    roomPrices: roomPrices
      .map((row) => Object.freeze({ roomId: row.room_id, price: moneyFromRow(row) }))
      .sort((left, right) => left.roomId.localeCompare(right.roomId)),
  });

  return Object.freeze({
    revision: Number(tenant.catalog_revision),
    catalogue,
    effectiveAt: tenant.catalogue_effective_at,
  });
}

function snapshotEqual(left, right) {
  return JSON.stringify(normalizeTenantCatalogue(left))
    === JSON.stringify(normalizeTenantCatalogue(right));
}

async function ensureSnapshot(client, {
  tenantId,
  revision,
  catalogue,
  effectiveAt,
  actorUserId,
  correlationId,
}) {
  const existing = await client.query({
    name: 'tenant-catalogue-snapshot-read',
    text: 'SELECT snapshot FROM tenant_catalogue_revisions WHERE tenant_id = $1 AND revision = $2',
    values: [tenantId, revision],
  });
  if (existing.rowCount === 1) {
    if (!snapshotEqual(existing.rows[0].snapshot, catalogue)) {
      throw new Error('TENANT_CATALOGUE_SNAPSHOT_DIVERGED');
    }
    return;
  }
  const inserted = await client.query({
    name: 'tenant-catalogue-snapshot-insert',
    text: `
      INSERT INTO tenant_catalogue_revisions (
        tenant_id, revision, snapshot, effective_at, actor_user_id, correlation_id
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6)
    `,
    values: [
      tenantId,
      revision,
      JSON.stringify(catalogue),
      effectiveAt,
      actorUserId,
      correlationId,
    ],
  });
  if (inserted.rowCount !== 1) throw new Error('TENANT_CATALOGUE_SNAPSHOT_INSERT_FAILED');
}

function identifiers(value) {
  return new Set(value.map((entry) => entry.id));
}

function containsCurrentEntities(current, proposed) {
  for (const key of ['services', 'equipment', 'cateringPackages', 'cateringItems']) {
    const proposedIds = identifiers(proposed[key]);
    if (current[key].some((entry) => !proposedIds.has(entry.id))) return false;
  }
  const proposedPackages = new Map(proposed.cateringPackages.map((entry) => [entry.id, entry]));
  for (const currentPackage of current.cateringPackages) {
    const proposedVariantIds = identifiers(proposedPackages.get(currentPackage.id)?.variants || []);
    if (currentPackage.variants.some((variant) => !proposedVariantIds.has(variant.id))) return false;
  }
  const proposedRoomIds = new Set(proposed.roomPrices.map((entry) => entry.roomId));
  if (current.roomPrices.some((entry) => !proposedRoomIds.has(entry.roomId))) return false;
  return true;
}

async function referencesExist(client, tenantId, catalogue) {
  const siteIds = new Set();
  const roomIds = new Set();
  for (const collection of [
    catalogue.services,
    catalogue.equipment,
    catalogue.cateringPackages,
    catalogue.cateringItems,
  ]) {
    for (const entry of collection) {
      entry.siteIds.forEach((id) => siteIds.add(id));
      entry.roomIds.forEach((id) => roomIds.add(id));
    }
  }
  catalogue.roomPrices.forEach((entry) => roomIds.add(entry.roomId));
  const [sites, rooms] = await Promise.all([
    client.query({
      name: 'tenant-catalogue-site-references',
      text: 'SELECT id FROM sites WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
      values: [tenantId, [...siteIds]],
    }),
    client.query({
      name: 'tenant-catalogue-room-references',
      text: 'SELECT id FROM rooms WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
      values: [tenantId, [...roomIds]],
    }),
  ]);
  return sites.rowCount === siteIds.size && rooms.rowCount === roomIds.size;
}

async function upsertSimple(client, tenantId, changedAt, table, statementName, entry) {
  await client.query({
    name: statementName,
    text: `
      INSERT INTO ${table} (
        tenant_id, id, name, description, active, price_minor, currency, sort_order,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        active = EXCLUDED.active,
        price_minor = EXCLUDED.price_minor,
        currency = EXCLUDED.currency,
        sort_order = EXCLUDED.sort_order,
        updated_at = EXCLUDED.updated_at
    `,
    values: [
      tenantId,
      entry.id,
      entry.name,
      entry.description,
      entry.active,
      entry.price.amountMinor,
      entry.price.currency,
      entry.order,
      changedAt,
    ],
  });
}

async function persistEntities(client, tenantId, catalogue, changedAt) {
  for (const service of catalogue.services) {
    await upsertSimple(client, tenantId, changedAt, 'services', 'tenant-catalogue-service-upsert', service);
  }
  for (const entry of catalogue.equipment) {
    await upsertSimple(client, tenantId, changedAt, 'equipment', 'tenant-catalogue-equipment-upsert', entry);
  }
  for (const cateringPackage of catalogue.cateringPackages) {
    await upsertSimple(
      client,
      tenantId,
      changedAt,
      'catering_packages',
      'tenant-catalogue-package-upsert',
      cateringPackage,
    );
  }
  for (const item of catalogue.cateringItems) {
    await upsertSimple(client, tenantId, changedAt, 'catering_items', 'tenant-catalogue-item-upsert', item);
  }
  for (const cateringPackage of catalogue.cateringPackages) {
    for (const variant of cateringPackage.variants) {
      await client.query({
        name: 'tenant-catalogue-variant-upsert',
        text: `
          INSERT INTO catering_package_variants (
            tenant_id, package_id, id, name, description, active,
            price_minor, currency, sort_order, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
          ON CONFLICT (tenant_id, package_id, id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            active = EXCLUDED.active,
            price_minor = EXCLUDED.price_minor,
            currency = EXCLUDED.currency,
            sort_order = EXCLUDED.sort_order,
            updated_at = EXCLUDED.updated_at
        `,
        values: [
          tenantId,
          cateringPackage.id,
          variant.id,
          variant.name,
          variant.description,
          variant.active,
          variant.price.amountMinor,
          variant.price.currency,
          variant.order,
          changedAt,
        ],
      });
    }
  }
  for (const roomPrice of catalogue.roomPrices) {
    await client.query({
      name: 'tenant-catalogue-room-price-upsert',
      text: `
        INSERT INTO tenant_room_prices (
          tenant_id, room_id, price_minor, currency, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (tenant_id, room_id) DO UPDATE SET
          price_minor = EXCLUDED.price_minor,
          currency = EXCLUDED.currency,
          updated_at = EXCLUDED.updated_at
      `,
      values: [
        tenantId,
        roomPrice.roomId,
        roomPrice.price.amountMinor,
        roomPrice.price.currency,
        changedAt,
      ],
    });
  }
}

function collectionForKind(catalogue, kind) {
  if (kind === 'service') return catalogue.services;
  if (kind === 'equipment') return catalogue.equipment;
  if (kind === 'package') return catalogue.cateringPackages;
  return catalogue.cateringItems;
}

async function replaceRelations(client, tenantId, catalogue) {
  await client.query({
    name: 'tenant-catalogue-package-items-delete',
    text: 'DELETE FROM catering_package_items WHERE tenant_id = $1',
    values: [tenantId],
  });
  for (const cateringPackage of catalogue.cateringPackages) {
    for (const itemId of cateringPackage.itemIds) {
      await client.query({
        name: 'tenant-catalogue-package-item-insert',
        text: `
          INSERT INTO catering_package_items (tenant_id, package_id, item_id)
          VALUES ($1, $2, $3)
        `,
        values: [tenantId, cateringPackage.id, itemId],
      });
    }
  }

  for (const relation of APPLICABILITY_TABLES) {
    await client.query({
      name: `tenant-catalogue-${relation.kind}-${relation.scope}-delete`,
      text: `DELETE FROM ${relation.table} WHERE tenant_id = $1`,
      values: [tenantId],
    });
    for (const entry of collectionForKind(catalogue, relation.kind)) {
      const references = relation.scope === 'site' ? entry.siteIds : entry.roomIds;
      for (const reference of references) {
        await client.query({
          name: `tenant-catalogue-${relation.kind}-${relation.scope}-insert`,
          text: `
            INSERT INTO ${relation.table} (tenant_id, ${relation.owner}, ${relation.target})
            VALUES ($1, $2, $3)
          `,
          values: [tenantId, entry.id, reference],
        });
      }
    }
  }
}

export function createPostgresTenantCatalogueRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async loadCurrent(tenantIdValue) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_CATALOGUE_TENANT_ID_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        return loadCurrentWithClient(client, tenantId);
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },

    async listHistory({ tenantId: tenantIdValue, limit = 25, beforeRevision = null } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_CATALOGUE_TENANT_ID_INVALID');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('TENANT_CATALOGUE_HISTORY_LIMIT_INVALID');
      }
      if (
        beforeRevision !== null
        && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
      ) {
        throw new TypeError('TENANT_CATALOGUE_HISTORY_CURSOR_INVALID');
      }
      const result = await pool.query({
        name: 'tenant-catalogue-history-list',
        text: `
          SELECT revision, snapshot, effective_at
          FROM tenant_catalogue_revisions
          WHERE tenant_id = $1
            AND ($2::bigint IS NULL OR revision < $2::bigint)
          ORDER BY revision DESC
          LIMIT $3
        `,
        values: [tenantId, beforeRevision, limit],
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        revision: Number(row.revision),
        effectiveAt: row.effective_at.toISOString(),
        catalogue: normalizeTenantCatalogue(row.snapshot),
      })));
    },

    async scopeExists({ tenantId: tenantIdValue, siteId: siteIdValue, roomId: roomIdValue } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_CATALOGUE_TENANT_ID_INVALID');
      const siteId = requireResourceId(siteIdValue, 'TENANT_CATALOGUE_SITE_ID_INVALID');
      const roomId = requireResourceId(roomIdValue, 'TENANT_CATALOGUE_ROOM_ID_INVALID');
      const result = await pool.query({
        name: 'tenant-catalogue-scope-exists',
        text: `
          SELECT 1
          FROM rooms r
          JOIN sites s ON s.tenant_id = r.tenant_id AND s.id = r.site_id
          WHERE r.tenant_id = $1 AND r.id = $2 AND s.id = $3
        `,
        values: [tenantId, roomId, siteId],
      });
      return result.rowCount === 1;
    },

    async replace({
      tenantId: tenantIdValue,
      actorUserId: actorUserIdValue,
      correlationId: correlationIdValue,
      expectedRevision,
      catalogue: catalogueValue,
      changedAt,
      auditEventFor,
      bulkReceipt = null,
      bulkResponseFor = null,
    } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_CATALOGUE_TENANT_ID_INVALID');
      const actorUserId = requireUuid(actorUserIdValue, 'TENANT_CATALOGUE_ACTOR_ID_INVALID');
      const correlationId = requireUuid(correlationIdValue, 'TENANT_CATALOGUE_CORRELATION_ID_INVALID');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new TypeError('TENANT_CATALOGUE_REVISION_INVALID');
      }
      const catalogue = normalizeTenantCatalogue(catalogueValue);
      requireDate(changedAt);
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('TENANT_CATALOGUE_AUDIT_FACTORY_REQUIRED');
      }

      return withPostgresTransaction(pool, async (client) => {
        if (bulkReceipt) {
          const receipt = await lockTenantBulkTransferReceipt(client, {
            tenantId, actorUserId, ...bulkReceipt,
          });
          if (receipt.status === 'replay') {
            return Object.freeze({ status: 'bulk_replay', response: receipt.response });
          }
          if (receipt.status !== 'ready') {
            throw repositoryInputError(`TENANT_BULK_RECEIPT_${receipt.status.toUpperCase()}`);
          }
          if (receipt.sourceRevision !== expectedRevision || typeof bulkResponseFor !== 'function') {
            throw repositoryInputError('TENANT_BULK_RECEIPT_INVALID');
          }
        }
        const current = await loadCurrentWithClient(client, tenantId, { lock: true });
        if (!current) return Object.freeze({ status: 'not_found' });
        if (current.revision !== expectedRevision) {
          return Object.freeze({ status: 'conflict', currentRevision: current.revision });
        }
        if (!containsCurrentEntities(current.catalogue, catalogue)) {
          return Object.freeze({ status: 'removal_forbidden' });
        }
        if (await referencesExist(client, tenantId, catalogue) !== true) {
          return Object.freeze({ status: 'reference_invalid' });
        }

        await ensureSnapshot(client, {
          tenantId,
          revision: current.revision,
          catalogue: current.catalogue,
          effectiveAt: current.effectiveAt,
          actorUserId: null,
          correlationId: null,
        });
        await persistEntities(client, tenantId, catalogue, changedAt);
        await replaceRelations(client, tenantId, catalogue);

        const nextRevision = current.revision + 1;
        const revisionUpdate = await client.query({
          name: 'tenant-catalogue-revision-update',
          text: `
            UPDATE tenants
            SET catalog_revision = $3,
                updated_at = $4
            WHERE id = $1 AND catalog_revision = $2
          `,
          values: [tenantId, current.revision, nextRevision, changedAt],
        });
        if (revisionUpdate.rowCount !== 1) throw new Error('TENANT_CATALOGUE_REVISION_UPDATE_FAILED');
        await ensureSnapshot(client, {
          tenantId,
          revision: nextRevision,
          catalogue,
          effectiveAt: changedAt,
          actorUserId,
          correlationId,
        });
        const audit = await auditRepository.appendWithClient(client, auditEventFor({
          previous: current.catalogue,
          next: catalogue,
          nextRevision,
        }));
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        const result = Object.freeze({
          status: 'updated',
          current: Object.freeze({ revision: nextRevision, catalogue }),
        });
        if (bulkReceipt) {
          const bulkResponse = bulkResponseFor(result);
          await finalizeTenantBulkTransferReceipt(client, {
            tenantId, actorUserId, ...bulkReceipt, response: bulkResponse,
          });
          return Object.freeze({ status: 'bulk_applied', response: bulkResponse });
        }
        return result;
      });
    },
  });
}
