import { withPostgresTransaction } from './transaction.js';

function publicOrganization(row) {
  return Object.freeze({
    revision: Number(row.organization_revision),
    organization: Object.freeze({
      displayName: row.display_name,
      defaultLocale: row.default_locale,
      currency: row.currency,
      accent: row.brand_accent,
      logoAssetId: row.logo_asset_id ?? null,
    }),
  });
}

export function createPostgresTenantOrganizationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async get(tenantId) {
      const result = await pool.query({
        name: 'tenant-organization-get',
        text: `
          SELECT display_name, default_locale, currency, brand_accent, logo_asset_id,
                 organization_revision
          FROM tenants
          WHERE id = $1
        `,
        values: [tenantId],
      });
      return result.rows[0] ? publicOrganization(result.rows[0]) : null;
    },

    async update({ tenantId, expectedRevision, organization, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-organization-lock',
          text: 'SELECT organization_revision FROM tenants WHERE id = $1 FOR UPDATE',
          values: [tenantId],
        });
        if (!locked.rows[0]) return null;
        const currentRevision = Number(locked.rows[0].organization_revision);
        if (currentRevision !== expectedRevision) {
          return Object.freeze({ conflict: true, currentRevision });
        }
        if (organization.logoAssetId !== null) {
          const asset = await client.query({
            name: 'tenant-organization-logo-check',
            text: 'SELECT 1 FROM tenant_brand_assets WHERE tenant_id = $1 AND id = $2',
            values: [tenantId, organization.logoAssetId],
          });
          if (!asset.rows[0]) return Object.freeze({ missingLogoAsset: true });
        }
        const updated = await client.query({
          name: 'tenant-organization-update',
          text: `
            UPDATE tenants
            SET display_name = $2,
                default_locale = $3,
                currency = $4,
                brand_accent = $5,
                logo_asset_id = $6,
                organization_revision = organization_revision + 1,
                updated_at = $7
            WHERE id = $1
            RETURNING display_name, default_locale, currency, brand_accent, logo_asset_id,
                      organization_revision
          `,
          values: [
            tenantId,
            organization.displayName,
            organization.defaultLocale,
            organization.currency,
            organization.accent,
            organization.logoAssetId,
            changedAt,
          ],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return publicOrganization(updated.rows[0]);
      });
    },

    async createBrandAsset({
      tenantId,
      assetId,
      actorUserId,
      mediaType,
      content,
      sha256,
      createdAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'tenant-brand-asset-create',
          text: `
            INSERT INTO tenant_brand_assets (
              tenant_id, id, media_type, size_bytes, sha256, content,
              created_by_user_id, created_at
            )
            SELECT $1, $2, $3, $4, $5, $6, $7, $8
            WHERE EXISTS (
              SELECT 1 FROM users
              WHERE tenant_id = $1 AND id = $7 AND active = true
            )
            RETURNING id, media_type, size_bytes, sha256
          `,
          values: [tenantId, assetId, mediaType, content.length, sha256, content, actorUserId, createdAt],
        });
        if (!result.rows[0]) return null;
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({
          id: result.rows[0].id,
          mediaType: result.rows[0].media_type,
          sizeBytes: result.rows[0].size_bytes,
          sha256: result.rows[0].sha256,
        });
      });
    },

    async findBrandAsset(tenantId, assetId) {
      const result = await pool.query({
        name: 'tenant-brand-asset-find',
        text: `
          SELECT id, media_type, size_bytes, sha256, content
          FROM tenant_brand_assets
          WHERE tenant_id = $1 AND id = $2
        `,
        values: [tenantId, assetId],
      });
      if (!result.rows[0]) return null;
      return Object.freeze({
        id: result.rows[0].id,
        mediaType: result.rows[0].media_type,
        sizeBytes: result.rows[0].size_bytes,
        sha256: result.rows[0].sha256,
        content: Buffer.from(result.rows[0].content),
      });
    },
  });
}
