import {
  createTenantReadinessCheck,
  createTenantReadinessPolicy,
  TENANT_ACTIVATION_CAPABILITIES,
  TENANT_READINESS_CHECK,
} from '../../tenancy/tenant-readiness-policy.js';
import { withPostgresTransaction } from './transaction.js';
import { subscribePlatformProjectionNotifications } from './platform-projection-notifications.js';

const readinessPolicy = createTenantReadinessPolicy();

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
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      passed: identityActive,
      observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.MICROSOFT_CONNECTED,
      passed: connected,
      observedAt: tenant.last_verified_at?.toISOString() ?? observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.PLACES_PERMISSION,
      passed: placesGranted,
      observedAt: tenant.last_verified_at?.toISOString() ?? observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.CALENDARS_PERMISSION,
      passed: calendarsGranted,
      observedAt: tenant.last_verified_at?.toISOString() ?? observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.ROOM_MAPPING_ACTIVE,
      passed: mappingActive,
      observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
      passed: freeBusy ? freeBusy.status === 'healthy' : null,
      observedAt: freeBusy?.last_checked_at?.toISOString() ?? null,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.DIRECTORY_ENTITLED,
      passed: enabled.has(TENANT_ACTIVATION_CAPABILITIES[0]),
      observedAt,
    }),
    createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.CALENDAR_ENTITLED,
      passed: enabled.has(TENANT_ACTIVATION_CAPABILITIES[1]),
      observedAt,
    }),
  ]);
  const readiness = readinessPolicy.evaluateSnapshot({
    lifecycleStatus: tenant.status,
    checks,
    asOfMs: Date.parse(observedAt),
  });
  const missingRequired = TENANT_ACTIVATION_CAPABILITIES
    .filter((item) => !enabled.has(item)).length;
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
        invalidated_at = NULL, invalidation_reason = NULL,
        updated_at = GREATEST(EXCLUDED.updated_at, platform_tenant_readiness_snapshots.updated_at)
    `,
    values: [tenant.id, tenant.lifecycle_revision, tenant.entitlement_revision,
      onboardingState, readiness.state, readiness.blockerCodes, JSON.stringify(checks),
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
        invalidated_at = NULL, invalidation_reason = NULL,
        updated_at = GREATEST(EXCLUDED.updated_at, platform_microsoft_fleet_snapshots.updated_at)
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

export async function refreshPlatformProjectionBatchWithClient(
  client,
  { limit = 25, observedAt } = {},
) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('PLATFORM_PROJECTION_BATCH_LIMIT_INVALID');
  }
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
  let selectedObservedAt = observedAt;
  if (selectedObservedAt === undefined) {
    const clock = await client.query({
      name: 'platform-projection-refresh-clock',
      text: 'SELECT date_trunc(\'milliseconds\', clock_timestamp()) AS observed_at',
    });
    selectedObservedAt = clock.rows[0].observed_at.toISOString();
  } else {
    const observedAtEpoch = typeof selectedObservedAt === 'string'
      ? Date.parse(selectedObservedAt)
      : Number.NaN;
    if (
      !Number.isFinite(observedAtEpoch)
      || new Date(observedAtEpoch).toISOString() !== selectedObservedAt
    ) throw new TypeError('PLATFORM_PROJECTION_OBSERVED_AT_INVALID');
  }
  for (const candidate of candidates.rows) {
    const source = await loadSource(client, candidate.id);
    if (source) await storeProjection(client, source, selectedObservedAt);
  }
  return Object.freeze({
    refreshedCount: candidates.rowCount,
    observedAt: selectedObservedAt,
  });
}

export function createPostgresPlatformProjectionRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  return Object.freeze({
    subscribe: (onWake, onDisconnect) => subscribePlatformProjectionNotifications(pool, onWake, onDisconnect),
    async consumeBatch({ limit = 25 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('PLATFORM_PROJECTION_BATCH_LIMIT_INVALID');
      }
      return withPostgresTransaction(pool, async (client) => {
        // Tenant -> outbox -> projection lock order matches authoritative Tenant writes.
        // Non-Tenant writes can wait for outbox custody; source reads never lock their rows.
        const candidates = await client.query({
          name: 'platform-projection-outbox-candidates',
          text: `SELECT tenant.id FROM platform_projection_outbox event
            JOIN tenants tenant ON tenant.id = event.tenant_id
            WHERE event.state = 'pending' AND event.available_at <= clock_timestamp()
            ORDER BY event.available_at, event.tenant_id
            LIMIT $1 FOR UPDATE OF tenant SKIP LOCKED`,
          values: [limit],
        });
        const result = { refreshedCount: 0, retryCount: 0, poisonCount: 0 };
        const deadline = performance.now() + 25_000;
        for (const { id } of candidates.rows) {
          if (performance.now() >= deadline) break;
          const custody = await client.query({
            name: 'platform-projection-outbox-lock',
            text: `SELECT source_version, attempts FROM platform_projection_outbox
              WHERE tenant_id = $1 AND state = 'pending' AND available_at <= clock_timestamp()
              FOR UPDATE SKIP LOCKED`,
            values: [id],
          });
          if (custody.rowCount !== 1) continue;
          const event = custody.rows[0];
          await client.query('SAVEPOINT platform_projection_event');
          try {
            const source = await loadSource(client, id);
            if (!source) throw new Error('PLATFORM_PROJECTION_SOURCE_MISSING');
            const clock = await client.query({
              name: 'platform-projection-outbox-clock',
              text: "SELECT date_trunc('milliseconds', clock_timestamp()) AS observed_at",
            });
            await storeProjection(client, source, clock.rows[0].observed_at.toISOString());
            await client.query({
              name: 'platform-projection-outbox-acknowledge',
              text: 'DELETE FROM platform_projection_outbox WHERE tenant_id = $1 AND source_version = $2',
              values: [id, event.source_version],
            });
            await client.query('RELEASE SAVEPOINT platform_projection_event');
            result.refreshedCount += 1;
          } catch {
            // Roll back every partial projection write, but retain and classify durable intent.
            await client.query('ROLLBACK TO SAVEPOINT platform_projection_event');
            await client.query('RELEASE SAVEPOINT platform_projection_event');
            const attempts = Math.min(Number(event.attempts) + 1, 5);
            await client.query({
              name: 'platform-projection-outbox-retry',
              text: `UPDATE platform_projection_outbox SET attempts = $2,
                state = CASE WHEN $2 = 5 THEN 'poison' ELSE 'pending' END,
                available_at = clock_timestamp() + make_interval(secs => $3),
                last_failure = 'projection_failed' WHERE tenant_id = $1 AND source_version = $4`,
              values: [id, attempts, Math.min(30 * (2 ** (attempts - 1)), 480), event.source_version],
            });
            if (attempts === 5) result.poisonCount += 1;
            else result.retryCount += 1;
          }
        }
        return Object.freeze(result);
      });
    },
    async refreshBatch({ limit = 25 } = {}) {
      return withPostgresTransaction(
        pool,
        (client) => refreshPlatformProjectionBatchWithClient(client, { limit }),
      );
    },
  });
}
