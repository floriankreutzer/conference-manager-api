import { withPostgresTransaction } from './transaction.js';

const REQUIRED_CAPABILITIES = Object.freeze([
  'microsoft.directory',
  'microsoft.calendar',
]);

function check(checkId, category, passed, observedAt, reasonCode) {
  return Object.freeze({
    checkId,
    category,
    state: passed === null ? 'unknown' : passed ? 'pass' : 'fail',
    reasonCode: passed === false ? reasonCode : null,
    observedAt,
    freshUntil: observedAt === null
      ? null
      : new Date(Date.parse(observedAt) + (15 * 60 * 1000)).toISOString(),
  });
}

function connectionState(status) {
  if (!status || status === 'pending') return 'not_configured';
  return status === 'revoked' ? 'disconnected' : status;
}

function permissionState(value) {
  return value === 'unverified' || value === null ? 'unknown' : value;
}

function incidentScope(status, reason) {
  if (!status || ['not_configured', 'permission_missing', 'revoked'].includes(status)) return 'tenant';
  if (typeof reason === 'string' && /^(provider_|graph_|microsoft_)/.test(reason)) return 'provider';
  return ['degraded', 'unavailable'].includes(status) ? 'unknown' : 'tenant';
}

function readinessState(checks) {
  if (checks.some((item) => item.state === 'fail')) return 'blocked';
  if (checks.some((item) => item.state === 'unknown')) return 'unknown';
  return 'ready';
}

function blockerCodes(checks) {
  return Object.freeze(checks
    .filter((item) => item.state !== 'pass')
    .map((item) => item.reasonCode ?? `${item.checkId}.unknown`)
    .sort());
}

async function loadSource(client, tenantId) {
  const tenant = await client.query({
    name: 'platform-projection-tenant-source',
    text: `
      SELECT tenant.id, tenant.status, tenant.lifecycle_revision, tenant.entitlement_revision,
             binding.status AS binding_status,
             invitation.id AS invitation_id, invitation.consumed_at, invitation.revoked_at,
             integration.id AS integration_id, integration.status AS connection_status,
             integration.places_permission_status, integration.calendars_permission_status,
             integration.last_verified_at
      FROM tenants tenant
      LEFT JOIN tenant_identity_bindings binding
        ON binding.tenant_id = tenant.id AND binding.status = 'active'
      LEFT JOIN LATERAL (
        SELECT id, consumed_at, revoked_at FROM tenant_onboarding_invitations
        WHERE tenant_id = tenant.id ORDER BY created_at DESC LIMIT 1
      ) invitation ON true
      LEFT JOIN integrations integration
        ON integration.tenant_id = tenant.id AND integration.provider = 'microsoft365'
      WHERE tenant.id = $1
    `,
    values: [tenantId],
  });
  if (!tenant.rows[0]) return null;
  const [entitlements, mappings, health] = await Promise.all([
    client.query({
      name: 'platform-projection-entitlement-source',
      text: `SELECT capability_id, enabled FROM tenant_entitlements
             WHERE tenant_id = $1 ORDER BY capability_id`,
      values: [tenantId],
    }),
    client.query({
      name: 'platform-projection-mapping-source',
      text: `SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE provider_status = 'active')::integer AS active,
             count(*) FILTER (WHERE provider_status = 'missing')::integer AS missing
             FROM microsoft365_room_mappings WHERE tenant_id = $1`,
      values: [tenantId],
    }),
    client.query({
      name: 'platform-projection-health-source',
      text: `SELECT capability, status, reason, last_checked_at, last_success_at
             FROM microsoft365_capability_health WHERE tenant_id = $1 ORDER BY capability`,
      values: [tenantId],
    }),
  ]);
  return Object.freeze({
    tenant: tenant.rows[0],
    entitlements: entitlements.rows,
    mappings: mappings.rows[0],
    health: health.rows,
  });
}

async function storeProjection(client, source, observedAt) {
  const { tenant, entitlements, mappings, health } = source;
  const enabled = new Set(entitlements.filter((item) => item.enabled).map((item) => item.capability_id));
  const freeBusy = health.find((item) => item.capability === 'free_busy');
  const identityActive = tenant.binding_status === 'active';
  const connected = tenant.connection_status === 'connected';
  const placesGranted = tenant.places_permission_status === 'granted';
  const calendarsGranted = tenant.calendars_permission_status === 'granted';
  const mappingActive = Number(mappings.active) > 0 && Number(mappings.missing) === 0;
  const checks = Object.freeze([
    check('tenant.identity.active', 'identity', identityActive, observedAt, 'tenant.identity.inactive'),
    check('microsoft.connection.connected', 'microsoft_connection', connected,
      tenant.last_verified_at?.toISOString() ?? observedAt, 'microsoft.connection.not_connected'),
    check('microsoft.permission.places', 'permissions', placesGranted,
      tenant.last_verified_at?.toISOString() ?? observedAt, 'microsoft.permission.places_missing'),
    check('microsoft.permission.calendars', 'permissions', calendarsGranted,
      tenant.last_verified_at?.toISOString() ?? observedAt, 'microsoft.permission.calendars_missing'),
    check('microsoft.room_mapping.active', 'room_mapping', mappingActive,
      observedAt, 'microsoft.room_mapping.missing'),
    check('microsoft.free_busy.healthy', 'capability_health',
      freeBusy ? freeBusy.status === 'healthy' : null,
      freeBusy?.last_checked_at?.toISOString() ?? null, 'microsoft.free_busy.unhealthy'),
    check('entitlement.microsoft_directory', 'entitlement', enabled.has('microsoft.directory'),
      observedAt, 'entitlement.microsoft_directory.missing'),
    check('entitlement.microsoft_calendar', 'entitlement', enabled.has('microsoft.calendar'),
      observedAt, 'entitlement.microsoft_calendar.missing'),
  ]);
  const missingRequired = REQUIRED_CAPABILITIES.filter((item) => !enabled.has(item)).length;
  const onboardingState = identityActive
    ? 'complete'
    : tenant.invitation_id === null
      ? 'not_started'
      : tenant.consumed_at !== null ? 'claimed' : 'invited';
  await client.query({
    name: 'platform-projection-readiness-upsert',
    text: `
      INSERT INTO platform_tenant_readiness_snapshots (
        tenant_id, source_lifecycle_revision, source_entitlement_revision,
        onboarding_state, readiness_state, blocker_codes, checks,
        enabled_entitlement_count, missing_required_entitlement_count,
        evaluated_at, revision, invalidated_at, invalidation_reason, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 1, NULL, NULL, $10)
      ON CONFLICT (tenant_id) DO UPDATE SET
        source_lifecycle_revision = EXCLUDED.source_lifecycle_revision,
        source_entitlement_revision = EXCLUDED.source_entitlement_revision,
        onboarding_state = EXCLUDED.onboarding_state,
        readiness_state = EXCLUDED.readiness_state,
        blocker_codes = EXCLUDED.blocker_codes,
        checks = EXCLUDED.checks,
        enabled_entitlement_count = EXCLUDED.enabled_entitlement_count,
        missing_required_entitlement_count = EXCLUDED.missing_required_entitlement_count,
        evaluated_at = EXCLUDED.evaluated_at,
        revision = platform_tenant_readiness_snapshots.revision + 1,
        invalidated_at = NULL, invalidation_reason = NULL, updated_at = EXCLUDED.updated_at
    `,
    values: [tenant.id, tenant.lifecycle_revision, tenant.entitlement_revision,
      onboardingState, readinessState(checks), blockerCodes(checks), JSON.stringify(checks),
      enabled.size, missingRequired, observedAt],
  });
  await client.query({
    name: 'platform-projection-microsoft-upsert',
    text: `
      INSERT INTO platform_microsoft_fleet_snapshots (
        tenant_id, source_lifecycle_revision, connection_state, places_permission,
        calendars_permission, active_mapping_count, missing_mapping_count,
        total_mapping_count, observed_at, revision, invalidated_at,
        invalidation_reason, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, NULL, NULL, $9)
      ON CONFLICT (tenant_id) DO UPDATE SET
        source_lifecycle_revision = EXCLUDED.source_lifecycle_revision,
        connection_state = EXCLUDED.connection_state,
        places_permission = EXCLUDED.places_permission,
        calendars_permission = EXCLUDED.calendars_permission,
        active_mapping_count = EXCLUDED.active_mapping_count,
        missing_mapping_count = EXCLUDED.missing_mapping_count,
        total_mapping_count = EXCLUDED.total_mapping_count,
        observed_at = EXCLUDED.observed_at,
        revision = platform_microsoft_fleet_snapshots.revision + 1,
        invalidated_at = NULL, invalidation_reason = NULL, updated_at = EXCLUDED.updated_at
    `,
    values: [tenant.id, tenant.lifecycle_revision, connectionState(tenant.connection_status),
      permissionState(tenant.places_permission_status), permissionState(tenant.calendars_permission_status),
      mappings.active, mappings.missing, mappings.total, observedAt],
  });
  await client.query({
    name: 'platform-projection-microsoft-capabilities-replace',
    text: 'DELETE FROM platform_microsoft_fleet_capabilities WHERE tenant_id = $1',
    values: [tenant.id],
  });
  for (const item of health) {
    await client.query({
      name: 'platform-projection-microsoft-capability-insert',
      text: `INSERT INTO platform_microsoft_fleet_capabilities (
        tenant_id, capability, status, reason_code, checked_at,
        last_success_at, fresh_until, incident_scope
      ) VALUES ($1, $2, $3, $4, $5, $6, $5::timestamptz + INTERVAL '15 minutes', $7)`,
      values: [tenant.id, item.capability, item.status, item.reason,
        item.last_checked_at, item.last_success_at, incidentScope(item.status, item.reason)],
    });
  }
}

export function createPostgresPlatformProjectionRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  return Object.freeze({
    async refreshBatch({ limit = 25 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('PLATFORM_PROJECTION_BATCH_LIMIT_INVALID');
      }
      return withPostgresTransaction(pool, async (client) => {
        const candidates = await client.query({
          name: 'platform-projection-refresh-candidates',
          text: `
            SELECT tenant.id FROM tenants tenant
            LEFT JOIN platform_tenant_readiness_snapshots snapshot ON snapshot.tenant_id = tenant.id
            ORDER BY snapshot.updated_at ASC NULLS FIRST, tenant.id ASC
            LIMIT $1 FOR UPDATE OF tenant SKIP LOCKED
          `,
          values: [limit],
        });
        const clock = await client.query({
          name: 'platform-projection-refresh-clock',
          text: 'SELECT date_trunc(\'milliseconds\', clock_timestamp()) AS observed_at',
        });
        const observedAt = clock.rows[0].observed_at.toISOString();
        for (const candidate of candidates.rows) {
          const source = await loadSource(client, candidate.id);
          if (source) await storeProjection(client, source, observedAt);
        }
        return Object.freeze({ refreshedCount: candidates.rowCount, observedAt });
      });
    },
  });
}
