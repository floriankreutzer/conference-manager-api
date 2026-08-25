import { isInternalUuid } from '../../domain/identifiers.js';

const CAPABILITIES = new Set(['places', 'free_busy', 'calendar_write']);
const STATUSES = new Set([
  'healthy',
  'degraded',
  'unavailable',
  'revoked',
  'permission_missing',
  'not_configured',
]);
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
  return value;
}

function requireCapability(value) {
  if (!CAPABILITIES.has(value)) throw new TypeError('MICROSOFT365_HEALTH_CAPABILITY_INVALID');
  return value;
}

function requireStatus(value) {
  if (!STATUSES.has(value)) throw new TypeError('MICROSOFT365_HEALTH_STATUS_INVALID');
  return value;
}

function requireReason(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) {
    throw new TypeError('MICROSOFT365_HEALTH_REASON_INVALID');
  }
  return value;
}

function requireDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(code);
  return value;
}

function mapRow(row) {
  return Object.freeze({
    capability: row.capability,
    status: row.status,
    reason: row.reason ?? null,
    lastCheckedAt: new Date(row.last_checked_at).toISOString(),
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
  });
}

export function createPostgresMicrosoft365CapabilityHealthRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  return Object.freeze({
    async listByTenantIdAndIntegrationId(tenantId, integrationId) {
      requireUuid(tenantId, 'MICROSOFT365_HEALTH_TENANT_INVALID');
      requireUuid(integrationId, 'MICROSOFT365_HEALTH_INTEGRATION_INVALID');
      const result = await pool.query({
        name: 'microsoft365-capability-health-list',
        text: `
          SELECT capability, status, reason, last_checked_at, last_success_at
          FROM microsoft365_capability_health
          WHERE tenant_id = $1 AND integration_id = $2
          ORDER BY capability
        `,
        values: [tenantId, integrationId],
      });
      return Object.freeze(result.rows.map(mapRow));
    },

    async record({
      tenantId,
      integrationId,
      capability,
      status,
      reason = null,
      checkedAt,
      successful = false,
    }) {
      requireUuid(tenantId, 'MICROSOFT365_HEALTH_TENANT_INVALID');
      requireUuid(integrationId, 'MICROSOFT365_HEALTH_INTEGRATION_INVALID');
      const normalizedCapability = requireCapability(capability);
      const normalizedStatus = requireStatus(status);
      const normalizedReason = requireReason(reason);
      requireDate(checkedAt, 'MICROSOFT365_HEALTH_CHECKED_AT_INVALID');
      if (typeof successful !== 'boolean') throw new TypeError('MICROSOFT365_HEALTH_SUCCESS_INVALID');
      if (successful && normalizedStatus !== 'healthy') {
        throw new TypeError('MICROSOFT365_HEALTH_SUCCESS_STATUS_INVALID');
      }

      const result = await pool.query({
        name: 'microsoft365-capability-health-record',
        text: `
          INSERT INTO microsoft365_capability_health (
            tenant_id, integration_id, capability, status, reason, last_checked_at, last_success_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6::timestamptz,
            CASE WHEN $7::boolean THEN $6::timestamptz ELSE NULL END
          )
          ON CONFLICT (tenant_id, integration_id, capability)
          DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            last_checked_at = EXCLUDED.last_checked_at,
            last_success_at = CASE
              WHEN $7::boolean THEN EXCLUDED.last_checked_at
              ELSE microsoft365_capability_health.last_success_at
            END
          RETURNING capability, status, reason, last_checked_at, last_success_at
        `,
        values: [
          tenantId,
          integrationId,
          normalizedCapability,
          normalizedStatus,
          normalizedReason,
          checkedAt,
          successful,
        ],
      });
      return mapRow(result.rows[0]);
    },
  });
}
