import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';

const MODES = ['catalogue','availability','order','update','cancel','status'];
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_CONNECTION_REVISION_INVALID');
  }
  return value;
}

export async function readCurrentCateringConnectionWithClient(client, tenantId, integrationId, registry) {
  const rows = await client.query({ name: 'catering-order-current-connection-lock',
    text: `SELECT configuration.*,integration.provider,integration.status FROM catering_integration_configurations configuration
      JOIN integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2 FOR SHARE OF configuration,integration`,
    values: [tenantId, integrationId] });
  if (rows.rowCount !== 1) return null;
  const row = rows.rows[0];
  const configuration = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
    capabilities: Object.fromEntries(MODES.map((name) => [`catering.${name}`, row[`${name}_mode`]])) }, registry.get(row.provider));
  return ['configured','active'].includes(row.status) ? { ...configuration, revision: revision(Number(row.revision)) } : null;
}
