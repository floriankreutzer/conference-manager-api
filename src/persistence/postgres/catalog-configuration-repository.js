import {
  TENANT_CONFIGURATION_DOMAIN,
  TenantConfigurationInputError,
} from '../../domain/tenant-configuration/protocol.js';
import { createPostgresConfigurationDomainRepository } from './configuration-domain-repository.js';

const UPSERT_SERVICE = `
  INSERT INTO services (
    tenant_id,id,name,description,active,price_minor,currency,billing_unit,metadata
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (tenant_id,id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    active = EXCLUDED.active,
    price_minor = EXCLUDED.price_minor,
    currency = EXCLUDED.currency,
    billing_unit = EXCLUDED.billing_unit,
    metadata = EXCLUDED.metadata
`;

const UPSERT_CATERING_ITEM = `
  INSERT INTO catering_items (
    tenant_id,id,name,description,active,price_minor,currency,billing_unit,metadata
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (tenant_id,id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    active = EXCLUDED.active,
    price_minor = EXCLUDED.price_minor,
    currency = EXCLUDED.currency,
    billing_unit = EXCLUDED.billing_unit,
    metadata = EXCLUDED.metadata
`;

const UPSERT_CATERING_PACKAGE = `
  INSERT INTO catering_packages (
    tenant_id,id,name,description,active,price_minor,currency,billing_unit,metadata,item_ids
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT (tenant_id,id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    active = EXCLUDED.active,
    price_minor = EXCLUDED.price_minor,
    currency = EXCLUDED.currency,
    billing_unit = EXCLUDED.billing_unit,
    metadata = EXCLUDED.metadata,
    item_ids = EXCLUDED.item_ids
`;

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeStringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function publicPriced(row, { packageEntry = false } = {}) {
  const metadata = safeObject(row.metadata);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    billingUnit: row.billing_unit,
    dietaryTags: safeStringList(metadata.dietaryTags),
    allergens: safeStringList(metadata.allergens),
    ...(packageEntry ? { itemIds: safeStringList(row.item_ids) } : {}),
  };
}

async function initializeCatalog(client, tenantId) {
  const [services, packages, items] = await Promise.all([
    client.query(
      `SELECT id,name,description,active,price_minor,currency,billing_unit,metadata
         FROM services WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    ),
    client.query(
      `SELECT id,name,description,active,price_minor,currency,billing_unit,metadata,item_ids
         FROM catering_packages WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    ),
    client.query(
      `SELECT id,name,description,active,price_minor,currency,billing_unit,metadata
         FROM catering_items WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    ),
  ]);
  return {
    services: services.rows.map((row) => publicPriced(row)),
    cateringPackages: packages.rows.map((row) => publicPriced(row, { packageEntry: true })),
    cateringItems: items.rows.map((row) => publicPriced(row)),
  };
}

function assertExistingIdsRetained(existing, proposed, code) {
  const proposedIds = new Set(proposed);
  if (existing.some((id) => !proposedIds.has(id))) {
    throw new TenantConfigurationInputError(code);
  }
}

function pricedValues(tenantId, entry) {
  return [
    tenantId,
    entry.id,
    entry.name,
    entry.description,
    entry.active,
    entry.priceMinor,
    entry.currency,
    entry.billingUnit,
    { dietaryTags: entry.dietaryTags, allergens: entry.allergens },
  ];
}

async function applyCatalog(client, configuration, _changedAt, tenantId) {
  const [services, packages, items] = await Promise.all([
    client.query('SELECT id FROM services WHERE tenant_id = $1', [tenantId]),
    client.query('SELECT id FROM catering_packages WHERE tenant_id = $1', [tenantId]),
    client.query('SELECT id FROM catering_items WHERE tenant_id = $1', [tenantId]),
  ]);
  assertExistingIdsRetained(
    services.rows.map((row) => row.id),
    configuration.services.map((entry) => entry.id),
    'TENANT_SERVICE_ARCHIVE_REQUIRED',
  );
  assertExistingIdsRetained(
    packages.rows.map((row) => row.id),
    configuration.cateringPackages.map((entry) => entry.id),
    'TENANT_CATERING_PACKAGE_ARCHIVE_REQUIRED',
  );
  assertExistingIdsRetained(
    items.rows.map((row) => row.id),
    configuration.cateringItems.map((entry) => entry.id),
    'TENANT_CATERING_ITEM_ARCHIVE_REQUIRED',
  );
  for (const entry of configuration.services) {
    await client.query(UPSERT_SERVICE, pricedValues(tenantId, entry));
  }
  for (const entry of configuration.cateringItems) {
    await client.query(UPSERT_CATERING_ITEM, pricedValues(tenantId, entry));
  }
  for (const entry of configuration.cateringPackages) {
    await client.query(UPSERT_CATERING_PACKAGE, [...pricedValues(tenantId, entry), entry.itemIds]);
  }
}

export function createPostgresCatalogConfigurationRepository(store) {
  return createPostgresConfigurationDomainRepository({
    store,
    domain: TENANT_CONFIGURATION_DOMAIN.CATALOG,
    initialize: initializeCatalog,
    applyProjection: applyCatalog,
  });
}
