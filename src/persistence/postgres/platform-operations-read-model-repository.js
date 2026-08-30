import { withPostgresTransaction } from './transaction.js';
import {
  createPlatformOperationCursorCodec,
  platformScopeSql,
  requirePlatformFleetScope,
  requirePlatformOperatorId,
} from './platform-operations-query.js';

const FLEET_SCOPE_SQL = platformScopeSql('tenant', 1);

function instant(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function operatorSecurityVersion(authorization) {
  const value = authorization?.principal?.securityVersion;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('PLATFORM_OPERATION_AUTHORIZATION_INVALID');
  return value;
}

async function requireTarget(client, authorization, tenantId) {
  const result = await client.query({
    name: 'platform-read-model-authorize-target',
    text: `
      SELECT 1
      FROM platform_operators operator
      WHERE operator.id = $1
        AND operator.status = 'active'
        AND operator.security_version = $2
        AND (
          operator.scope_mode = 'all'
          OR EXISTS (
            SELECT 1 FROM platform_operator_tenant_scopes target_scope
            WHERE target_scope.operator_id = operator.id AND target_scope.tenant_id = $3
          )
        )
      LIMIT 1
      FOR SHARE
    `,
    values: [requirePlatformOperatorId(authorization), operatorSecurityVersion(authorization), tenantId],
  });
  if (result.rowCount !== 1) {
    const error = new Error('PLATFORM_TENANT_TARGET_DENIED');
    error.name = 'PlatformAuthorizationError';
    error.code = error.message;
    throw error;
  }
}

function requirePlatformAuditRepository(repository) {
  if (!repository || typeof repository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }
}

async function appendAccessEvidence(client, evidence, tenantId, platformAuditRepository) {
  if (
    !evidence
    || typeof evidence !== 'object'
    || Array.isArray(evidence)
    || Object.keys(evidence).join(',') !== 'platformAuditEvent'
  ) throw new TypeError('PLATFORM_OPERATION_EVIDENCE_INVALID');
  const event = await platformAuditRepository.appendWithClient(
    client,
    evidence.platformAuditEvent,
    { expectedTargetTenantId: tenantId },
  );
  if (!event || event.targetTenantId !== tenantId) throw new Error('PLATFORM_AUDIT_APPEND_FAILED');
}

function readinessRow(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    displayName: row.display_name,
    lifecycleStatus: row.lifecycle_status,
    lifecycleRevision: Number(row.lifecycle_revision),
    onboardingState: row.onboarding_state,
    checks: Object.freeze(row.checks),
    enabledEntitlementCount: Number(row.enabled_entitlement_count),
    missingRequiredEntitlementCount: Number(row.missing_required_entitlement_count),
    evidence: Object.freeze((row.evidence ?? []).map((item) => Object.freeze({
      kind: item.kind,
      state: item.state,
      release: item.release,
      verifiedAt: item.verifiedAt,
      validUntil: item.validUntil,
    }))),
  });
}

function healthRow(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    displayName: row.display_name,
    lifecycleStatus: row.lifecycle_status,
    lifecycleRevision: Number(row.lifecycle_revision),
    connectionState: row.connection_state,
    placesPermission: row.places_permission,
    calendarsPermission: row.calendars_permission,
    activeMappingCount: Number(row.active_mapping_count),
    missingMappingCount: Number(row.missing_mapping_count),
    totalMappingCount: Number(row.total_mapping_count),
    capabilities: Object.freeze((row.capabilities ?? []).map((item) => Object.freeze({
      capability: item.capability,
      status: item.status,
      reasonCode: item.reasonCode,
      checkedAt: item.checkedAt,
      lastSuccessAt: item.lastSuccessAt,
      freshUntil: item.freshUntil,
      incidentScope: item.incidentScope,
    }))),
  });
}

function pageCursor({ query, authorization, cursorCodec, kind, filters }) {
  const scope = requirePlatformFleetScope(authorization);
  const cursor = query.cursor === null
    ? null
    : cursorCodec.decode(query.cursor, { kind, scope, filters });
  const tenantId = cursor?.position?.tenantId ?? null;
  if (tenantId !== null && (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/.test(tenantId))) {
    throw new TypeError('PLATFORM_OPERATION_CURSOR_INVALID');
  }
  return Object.freeze({ scope, cursor, tenantId });
}

async function snapshotClock(pool, name) {
  const result = await pool.query({ name, text: 'SELECT clock_timestamp() AS snapshot_at' });
  return instant(result.rows[0].snapshot_at);
}

export function createPostgresPlatformReadinessSnapshotRepository(pool, { cursorSecret } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  const cursorCodec = createPlatformOperationCursorCodec({ secret: cursorSecret });
  return Object.freeze({
    async list({ query, authorization }) {
      const filters = Object.freeze({
        lifecycleStatus: query.lifecycleStatus,
        readinessState: query.readinessState,
        blockerCode: query.blockerCode,
      });
      const { scope, cursor, tenantId } = pageCursor({
        query,
        authorization,
        cursorCodec,
        kind: 'fleet_readiness',
        filters,
      });
      const snapshotAt = cursor?.snapshotAt ?? await snapshotClock(pool, 'platform-readiness-page-clock');
      const result = await pool.query({
        name: 'platform-readiness-fleet-page',
        text: `
          WITH authorized_tenants AS MATERIALIZED (
            SELECT tenant.* FROM tenants tenant WHERE ${FLEET_SCOPE_SQL}
          )
          SELECT tenant.id AS tenant_id, tenant.display_name,
            tenant.status AS lifecycle_status, tenant.lifecycle_revision,
            snapshot.onboarding_state, snapshot.readiness_state, snapshot.blocker_codes,
            snapshot.checks, snapshot.enabled_entitlement_count,
            snapshot.missing_required_entitlement_count,
            COALESCE(evidence.items, '[]'::jsonb) AS evidence
          FROM authorized_tenants tenant
          JOIN platform_tenant_readiness_snapshots snapshot ON snapshot.tenant_id = tenant.id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
              'kind', entry.kind,
              'state', entry.state,
              'release', entry.release,
              'verifiedAt', CASE WHEN entry.verified_at IS NULL THEN NULL ELSE to_char(
                entry.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END,
              'validUntil', CASE WHEN entry.valid_until IS NULL THEN NULL ELSE to_char(
                entry.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END
            ) ORDER BY entry.kind) AS items
            FROM (
              SELECT DISTINCT ON (candidate.kind) candidate.*
              FROM platform_tenant_readiness_evidence candidate
              WHERE candidate.tenant_id = tenant.id
                AND candidate.recorded_at <= $4
              ORDER BY candidate.kind, candidate.revision DESC
            ) entry
          ) evidence ON true
          WHERE snapshot.updated_at <= $4
            AND ($5::varchar IS NULL OR tenant.status = $5)
            AND ($6::varchar IS NULL OR snapshot.readiness_state = $6)
            AND ($7::varchar IS NULL OR $7 = ANY(snapshot.blocker_codes))
            AND ($8::uuid IS NULL OR tenant.id > $8)
          ORDER BY tenant.id ASC
          LIMIT $9
        `,
        values: [
          scope.operatorId,
          scope.securityVersion,
          scope.mode,
          snapshotAt,
          query.lifecycleStatus,
          query.readinessState,
          query.blockerCode,
          tenantId,
          query.limit + 1,
        ],
      });
      const hasMore = result.rows.length > query.limit;
      const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      return Object.freeze({
        items: Object.freeze(rows.map(readinessRow)),
        snapshotAt,
        nextCursor: hasMore
          ? cursorCodec.encode({
            kind: 'fleet_readiness',
            scope,
            snapshotAt,
            filters,
            position: { tenantId: rows.at(-1).tenant_id },
          })
          : null,
      });
    },
  });
}

export function createPostgresPlatformMicrosoftHealthSnapshotRepository(pool, { cursorSecret } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  const cursorCodec = createPlatformOperationCursorCodec({ secret: cursorSecret });
  return Object.freeze({
    async list({ query, authorization }) {
      const filters = Object.freeze({
        lifecycleStatus: query.lifecycleStatus,
        capability: query.capability,
        healthStatus: query.healthStatus,
        incidentScope: query.incidentScope,
      });
      const { scope, cursor, tenantId } = pageCursor({
        query,
        authorization,
        cursorCodec,
        kind: 'microsoft_health',
        filters,
      });
      const snapshotAt = cursor?.snapshotAt ?? await snapshotClock(pool, 'platform-health-page-clock');
      const result = await pool.query({
        name: 'platform-microsoft-health-fleet-page',
        text: `
          WITH authorized_tenants AS MATERIALIZED (
            SELECT tenant.* FROM tenants tenant WHERE ${FLEET_SCOPE_SQL}
          )
          SELECT tenant.id AS tenant_id, tenant.display_name,
            tenant.status AS lifecycle_status, tenant.lifecycle_revision,
            snapshot.connection_state, snapshot.places_permission,
            snapshot.calendars_permission, snapshot.active_mapping_count,
            snapshot.missing_mapping_count, snapshot.total_mapping_count,
            COALESCE(capability.items, '[]'::jsonb) AS capabilities
          FROM authorized_tenants tenant
          JOIN platform_microsoft_fleet_snapshots snapshot ON snapshot.tenant_id = tenant.id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
              'capability', entry.capability,
              'status', entry.status,
              'reasonCode', entry.reason_code,
              'checkedAt', CASE WHEN entry.checked_at IS NULL THEN NULL ELSE to_char(
                entry.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END,
              'lastSuccessAt', CASE WHEN entry.last_success_at IS NULL THEN NULL ELSE to_char(
                entry.last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END,
              'freshUntil', CASE WHEN entry.fresh_until IS NULL THEN NULL ELSE to_char(
                entry.fresh_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) END,
              'incidentScope', entry.incident_scope
            ) ORDER BY entry.capability) AS items
            FROM platform_microsoft_fleet_capabilities entry
            WHERE entry.tenant_id = tenant.id
          ) capability ON true
          WHERE snapshot.updated_at <= $4
            AND ($5::varchar IS NULL OR tenant.status = $5)
            AND (
              $6::varchar IS NULL
              OR EXISTS (
                SELECT 1 FROM platform_microsoft_fleet_capabilities filter_capability
                WHERE filter_capability.tenant_id = tenant.id
                  AND filter_capability.capability = $6
                  AND ($7::varchar IS NULL OR filter_capability.status = $7)
                  AND ($8::varchar IS NULL OR filter_capability.incident_scope = $8)
              )
            )
            AND (
              $6::varchar IS NOT NULL
              OR $7::varchar IS NULL
              OR EXISTS (
                SELECT 1 FROM platform_microsoft_fleet_capabilities filter_status
                WHERE filter_status.tenant_id = tenant.id AND filter_status.status = $7
                  AND ($8::varchar IS NULL OR filter_status.incident_scope = $8)
              )
            )
            AND (
              ($6::varchar IS NOT NULL OR $7::varchar IS NOT NULL)
              OR $8::varchar IS NULL
              OR EXISTS (
                SELECT 1 FROM platform_microsoft_fleet_capabilities filter_incident
                WHERE filter_incident.tenant_id = tenant.id AND filter_incident.incident_scope = $8
              )
            )
            AND ($9::uuid IS NULL OR tenant.id > $9)
          ORDER BY tenant.id ASC
          LIMIT $10
        `,
        values: [
          scope.operatorId,
          scope.securityVersion,
          scope.mode,
          snapshotAt,
          query.lifecycleStatus,
          query.capability,
          query.healthStatus,
          query.incidentScope,
          tenantId,
          query.limit + 1,
        ],
      });
      const hasMore = result.rows.length > query.limit;
      const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      return Object.freeze({
        items: Object.freeze(rows.map(healthRow)),
        snapshotAt,
        nextCursor: hasMore
          ? cursorCodec.encode({
            kind: 'microsoft_health',
            scope,
            snapshotAt,
            filters,
            position: { tenantId: rows.at(-1).tenant_id },
          })
          : null,
      });
    },
  });
}

export function createPostgresPlatformDiagnosticRepository(pool, { platformAuditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  requirePlatformAuditRepository(platformAuditRepository);
  return Object.freeze({
    async readSummaryAndRecordAccess({ tenantId, authorization, evidence }) {
      return withPostgresTransaction(pool, async (client) => {
        await requireTarget(client, authorization, tenantId);
        const result = await client.query({
          name: 'platform-diagnostic-tenant-summary',
          text: `
            SELECT tenant.id AS tenant_id, tenant.display_name,
              tenant.status AS lifecycle_status, tenant.lifecycle_revision,
              tenant.entitlement_revision,
              readiness.readiness_state, readiness.blocker_codes AS readiness_blocker_codes,
              readiness.evaluated_at AS readiness_evaluated_at,
              readiness.enabled_entitlement_count,
              microsoft.connection_state,
              CASE
                WHEN bool_or(capability.status IN ('unavailable', 'revoked', 'permission_missing')) THEN 'unavailable'
                WHEN bool_or(capability.status = 'degraded') THEN 'degraded'
                WHEN bool_and(capability.status = 'healthy') THEN 'healthy'
                ELSE 'unknown'
              END AS health_state,
              CASE
                WHEN max(capability.checked_at) IS NULL OR max(capability.fresh_until) IS NULL THEN 'unknown'
                WHEN min(capability.fresh_until) <= clock_timestamp() THEN 'stale'
                ELSE 'fresh'
              END AS health_freshness,
              max(capability.checked_at) AS health_last_checked_at,
              microsoft.active_mapping_count, microsoft.missing_mapping_count,
              microsoft.total_mapping_count,
              COALESCE(runtime.api_version, runtime.frontend_version, runtime.deployment_reference) AS deployed_release,
              runtime.observed_at AS deployment_observed_at
            FROM tenants tenant
            JOIN platform_tenant_readiness_snapshots readiness ON readiness.tenant_id = tenant.id
            JOIN platform_microsoft_fleet_snapshots microsoft ON microsoft.tenant_id = tenant.id
            LEFT JOIN platform_microsoft_fleet_capabilities capability ON capability.tenant_id = tenant.id
            JOIN platform_runtime_tenant_mappings runtime_mapping ON runtime_mapping.tenant_id = tenant.id
            JOIN platform_runtime_deployments runtime
              ON runtime.id = runtime_mapping.deployment_id AND runtime.record_state = 'approved'
            WHERE tenant.id = $1
            GROUP BY tenant.id, readiness.tenant_id, microsoft.tenant_id,
              runtime.id, runtime_mapping.tenant_id
          `,
          values: [tenantId],
        });
        if (result.rowCount !== 1) return null;
        const failures = await client.query({
          name: 'platform-diagnostic-recent-failures',
          text: `
            SELECT category, occurred_at
            FROM platform_diagnostic_events
            WHERE tenant_id = $1 AND outcome = 'failure'
              AND category IS NOT NULL
            ORDER BY occurred_at DESC, id DESC
            LIMIT 20
          `,
          values: [tenantId],
        });
        await appendAccessEvidence(client, evidence, tenantId, platformAuditRepository);
        const row = result.rows[0];
        return Object.freeze({
          tenantId: row.tenant_id,
          displayName: row.display_name,
          lifecycleStatus: row.lifecycle_status,
          lifecycleRevision: Number(row.lifecycle_revision),
          readinessState: row.readiness_state,
          readinessBlockerCodes: Object.freeze([...row.readiness_blocker_codes]),
          readinessEvaluatedAt: instant(row.readiness_evaluated_at),
          entitlementRevision: Number(row.entitlement_revision),
          enabledEntitlementCount: Number(row.enabled_entitlement_count),
          connectionState: row.connection_state,
          healthState: row.health_state,
          healthFreshness: row.health_freshness,
          healthLastCheckedAt: instant(row.health_last_checked_at),
          activeMappingCount: Number(row.active_mapping_count),
          missingMappingCount: Number(row.missing_mapping_count),
          totalMappingCount: Number(row.total_mapping_count),
          deployedRelease: row.deployed_release,
          deploymentObservedAt: instant(row.deployment_observed_at),
          recentFailures: Object.freeze(failures.rows.map((failure) => Object.freeze({
            category: failure.category,
            occurredAt: instant(failure.occurred_at),
          }))),
        });
      }, { isolationLevel: 'REPEATABLE READ' });
    },

    async queryTenantCorrelationAndRecordAccess({
      tenantId,
      lookupCorrelationId,
      from,
      to,
      limit,
      authorization,
      evidence,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await requireTarget(client, authorization, tenantId);
        const result = await client.query({
          name: 'platform-diagnostic-correlation-query',
          text: `
            SELECT source, occurred_at, action, outcome, category, target_type
            FROM platform_diagnostic_events
            WHERE tenant_id = $1 AND correlation_id = $2
              AND occurred_at >= $3 AND occurred_at < $4
            ORDER BY occurred_at ASC, source ASC, id ASC
            LIMIT $5
          `,
          values: [tenantId, lookupCorrelationId, from, to, limit],
        });
        await appendAccessEvidence(client, evidence, tenantId, platformAuditRepository);
        return Object.freeze(result.rows.map((row) => Object.freeze({
          source: row.source,
          occurredAt: instant(row.occurred_at),
          action: row.action,
          outcome: row.outcome,
          category: row.category,
          targetType: row.target_type,
        })));
      }, { isolationLevel: 'REPEATABLE READ' });
    },
  });
}
