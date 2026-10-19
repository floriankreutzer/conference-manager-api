import { isInternalUuid } from '../../domain/identifiers.js';
import { CATERING_HEALTH_SAMPLE_LIMIT } from '../../domain/catering-operational-health.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { cateringDeliveryJobFromRow } from './catering-delivery-row.js';
import { withPostgresTransaction } from './transaction.js';

const MODES = ['catalogue','availability','order','update','cancel','status'];
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_HEALTH_SCOPE_INVALID');
  return value.toLowerCase();
}
export function createPostgresCateringOperationalHealthRepository(pool, { registry } = {}) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof registry?.get !== 'function') {
    throw new TypeError('CATERING_HEALTH_PERSISTENCE_REQUIRED');
  }
  return Object.freeze({
    async load({ tenantId, integrationId }) {
      tenantId = uuid(tenantId); integrationId = uuid(integrationId);
      return withPostgresTransaction(pool, async (client) => {
        const headers = await client.query({ name: 'catering-operational-health-configuration',
          text: `SELECT configuration.tenant_id,configuration.integration_id,configuration.revision,configuration.initial_order_mode,
            configuration.catalogue_mode,configuration.availability_mode,configuration.order_mode,
            configuration.update_mode,configuration.cancel_mode,configuration.status_mode,integration.provider,
            integration.status IN ('configured','active') AS connection_available,
            tenant.status='active' AS tenant_business_active,clock_timestamp() AS observed_at
            FROM catering_integration_configurations configuration JOIN integrations integration
              ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
            JOIN tenants tenant ON tenant.id=configuration.tenant_id
            WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2`, values: [tenantId,integrationId] });
        if (headers.rowCount === 0) return null;
        if (headers.rowCount !== 1) throw new TypeError('CATERING_HEALTH_CONFIGURATION_INVALID');
        const row = headers.rows[0];
        const configuration = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
          capabilities: Object.fromEntries(MODES.map((name) => [`catering.${name}`, row[`${name}_mode`]])) }, registry.get(row.provider));
        // Existing UNIQUE(tenant,integration,order,version,operation) supports this
        // bounded prefix/order scan. No all-history COUNT or provider I/O occurs.
        const sampled = await client.query({ name: 'catering-operational-health-jobs',
          text: `SELECT job.tenant_id,job.id,job.integration_id,job.order_id,job.order_version,job.operation,job.revision,job.status,
            job.dispatch_attempts,job.reconciliation_attempts,job.quote_revision,job.decision_sequence,job.origin_state_revision,
            job.created_at,job.updated_at,job.available_at,state.status AS order_status,
            coalesce(manual.last_sequence,0) AS manual_sequence,
            coalesce(job.lease_expires_at<=$4::timestamptz,false) AS lease_expired,
            catering_order_delivery_operation(job.tenant_id,job.order_id,job.order_version) AS delivery_operation
            FROM catering_delivery_jobs job LEFT JOIN catering_order_version_states state
              ON state.tenant_id=job.tenant_id AND state.order_id=job.order_id AND state.version=job.order_version
            LEFT JOIN catering_manual_delivery_heads manual
              ON manual.tenant_id=job.tenant_id AND manual.order_id=job.order_id AND manual.order_version=job.order_version
            WHERE job.tenant_id=$1 AND job.integration_id=$2 ORDER BY job.order_id,job.order_version,job.operation LIMIT $3`,
          values: [tenantId,integrationId,CATERING_HEALTH_SAMPLE_LIMIT + 1,row.observed_at] });
        return Object.freeze({ tenantId: row.tenant_id, integrationId: row.integration_id, providerId: row.provider,
          configurationRevision: Number(row.revision), configuration: Object.freeze({
            initialOrderMode: configuration.initialOrderMode, capabilities: configuration.capabilities,
          }),
          connectionAvailable: row.connection_available, tenantBusinessActive: row.tenant_business_active,
          observedAt: row.observed_at.toISOString(), jobs: Object.freeze(sampled.rows.map((item) => Object.freeze({
            job: cateringDeliveryJobFromRow(item, tenantId), orderStatus: item.order_status,
            manualSequence: Number(item.manual_sequence), leaseExpired: item.lease_expired, deliveryOperation: item.delivery_operation,
          }))) });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
  });
}
