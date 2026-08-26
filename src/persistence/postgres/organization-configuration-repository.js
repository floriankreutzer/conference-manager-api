import {
  TENANT_CONFIGURATION_DOMAIN,
  TenantConfigurationNotFoundError,
} from '../../domain/tenant-configuration/protocol.js';
import { createPostgresConfigurationDomainRepository } from './configuration-domain-repository.js';

export function createPostgresOrganizationConfigurationRepository(store) {
  return createPostgresConfigurationDomainRepository({
    store,
    domain: TENANT_CONFIGURATION_DOMAIN.ORGANIZATION,
    initialize: async (client, tenantId) => {
      const tenant = await client.query(
        'SELECT display_name FROM tenants WHERE id = $1',
        [tenantId],
      );
      if (tenant.rowCount !== 1) throw new TenantConfigurationNotFoundError('TENANT_NOT_FOUND');
      return {
        organization: {
          displayName: tenant.rows[0].display_name,
          defaultLocale: 'de',
          currency: 'EUR',
          theme: { accent: 'bordeaux', logoAssetId: null },
        },
      };
    },
    applyProjection: async (client, configuration, _changedAt, tenantId) => {
      const { organization } = configuration;
      if (organization.theme.logoAssetId !== null) {
        const asset = await client.query(
          'SELECT 1 FROM tenant_brand_assets WHERE tenant_id = $1 AND id = $2',
          [tenantId, organization.theme.logoAssetId],
        );
        if (asset.rowCount !== 1) {
          throw new TenantConfigurationNotFoundError('TENANT_BRAND_ASSET_NOT_FOUND');
        }
      }
      await client.query(
        'UPDATE tenants SET display_name = $2 WHERE id = $1',
        [tenantId, organization.displayName],
      );
    },
  });
}
