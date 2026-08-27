import { withPostgresTransaction } from './transaction.js';

function publicPriced(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    active: row.active,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    billingUnit: row.billing_unit,
    sortOrder: row.sort_order,
  });
}

function pricedValues(tenantId, item, changedAt) {
  return [
    tenantId,
    item.id,
    item.name,
    item.description,
    item.active,
    item.priceMinor,
    item.currency,
    item.billingUnit,
    item.sortOrder,
    changedAt,
  ];
}

export function createPostgresTenantCatalogRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function read(tenantId, client = pool) {
    const [tenant, services, packages, items, packageItems] = await Promise.all([
      client.query({ name: 'tenant-catalog-revision-get', text: 'SELECT catalog_revision FROM tenants WHERE id = $1', values: [tenantId] }),
      client.query({
        name: 'tenant-catalog-services-get',
        text: `SELECT id,name,description,active,price_minor,currency,billing_unit,sort_order
               FROM services WHERE tenant_id=$1 ORDER BY sort_order,id`,
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-catalog-packages-get',
        text: `SELECT id,name,description,active,price_minor,currency,billing_unit,sort_order
               FROM catering_packages WHERE tenant_id=$1 ORDER BY sort_order,id`,
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-catalog-items-get',
        text: `SELECT id,name,description,active,price_minor,currency,billing_unit,sort_order
               FROM catering_items WHERE tenant_id=$1 ORDER BY sort_order,id`,
        values: [tenantId],
      }),
      client.query({
        name: 'tenant-catalog-package-items-get',
        text: `SELECT catering_package_id,catering_item_id,quantity
               FROM catering_package_items WHERE tenant_id=$1 ORDER BY catering_package_id,catering_item_id`,
        values: [tenantId],
      }),
    ]);
    if (!tenant.rows[0]) return null;
    const lines = new Map();
    for (const row of packageItems.rows) {
      if (!lines.has(row.catering_package_id)) lines.set(row.catering_package_id, []);
      lines.get(row.catering_package_id).push(Object.freeze({ itemId: row.catering_item_id, quantity: row.quantity }));
    }
    return Object.freeze({
      revision: Number(tenant.rows[0].catalog_revision),
      catalog: Object.freeze({
        services: Object.freeze(services.rows.map(publicPriced)),
        cateringItems: Object.freeze(items.rows.map(publicPriced)),
        cateringPackages: Object.freeze(packages.rows.map((row) => Object.freeze({
          ...publicPriced(row),
          items: Object.freeze(lines.get(row.id) || []),
        }))),
      }),
    });
  }

  async function upsertService(client, tenantId, item, changedAt) {
    await client.query({
      name: 'tenant-catalog-service-upsert',
      text: `
        INSERT INTO services (
          tenant_id,id,name,description,active,price_minor,currency,billing_unit,sort_order,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT (tenant_id,id) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description, active=EXCLUDED.active,
          price_minor=EXCLUDED.price_minor, currency=EXCLUDED.currency,
          billing_unit=EXCLUDED.billing_unit, sort_order=EXCLUDED.sort_order, updated_at=EXCLUDED.updated_at
      `,
      values: pricedValues(tenantId, item, changedAt),
    });
  }

  async function upsertCateringItem(client, tenantId, item, changedAt) {
    await client.query({
      name: 'tenant-catalog-item-upsert',
      text: `
        INSERT INTO catering_items (
          tenant_id,id,name,description,active,price_minor,currency,billing_unit,sort_order,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT (tenant_id,id) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description, active=EXCLUDED.active,
          price_minor=EXCLUDED.price_minor, currency=EXCLUDED.currency,
          billing_unit=EXCLUDED.billing_unit, sort_order=EXCLUDED.sort_order, updated_at=EXCLUDED.updated_at
      `,
      values: pricedValues(tenantId, item, changedAt),
    });
  }

  async function upsertCateringPackage(client, tenantId, item, changedAt) {
    await client.query({
      name: 'tenant-catalog-package-upsert',
      text: `
        INSERT INTO catering_packages (
          tenant_id,id,name,description,active,price_minor,currency,billing_unit,sort_order,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT (tenant_id,id) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description, active=EXCLUDED.active,
          price_minor=EXCLUDED.price_minor, currency=EXCLUDED.currency,
          billing_unit=EXCLUDED.billing_unit, sort_order=EXCLUDED.sort_order, updated_at=EXCLUDED.updated_at
      `,
      values: pricedValues(tenantId, item, changedAt),
    });
  }

  return Object.freeze({
    get: (tenantId) => read(tenantId),
    async update({ tenantId, expectedRevision, catalog, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-catalog-lock',
          text: 'SELECT catalog_revision FROM tenants WHERE id=$1 FOR UPDATE',
          values: [tenantId],
        });
        if (!locked.rows[0]) return null;
        const currentRevision = Number(locked.rows[0].catalog_revision);
        if (currentRevision !== expectedRevision) return Object.freeze({ conflict: true, currentRevision });

        for (const item of catalog.services) await upsertService(client, tenantId, item, changedAt);
        for (const item of catalog.cateringItems) await upsertCateringItem(client, tenantId, item, changedAt);
        for (const item of catalog.cateringPackages) {
          await upsertCateringPackage(client, tenantId, item, changedAt);
          await client.query({
            name: 'tenant-catalog-package-items-clear',
            text: 'DELETE FROM catering_package_items WHERE tenant_id=$1 AND catering_package_id=$2',
            values: [tenantId, item.id],
          });
          for (const line of item.items) {
            await client.query({
              name: 'tenant-catalog-package-item-add',
              text: `INSERT INTO catering_package_items (tenant_id,catering_package_id,catering_item_id,quantity)
                     VALUES ($1,$2,$3,$4)`,
              values: [tenantId,item.id,line.itemId,line.quantity],
            });
          }
        }
        await client.query({
          name: 'tenant-catalog-revision-advance',
          text: 'UPDATE tenants SET catalog_revision=catalog_revision+1, updated_at=$2 WHERE id=$1',
          values: [tenantId, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return read(tenantId, client);
      });
    },
  });
}
