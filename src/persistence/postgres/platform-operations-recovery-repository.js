import { randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './transaction.js';
import {
  appendPlatformMutationEvidence,
  findPlatformOperationReceipt,
  lockPlatformOperationReceipt,
  requireCurrentPlatformMutationAuthorization,
  storePlatformOperationReceipt,
} from './platform-operations-repository.js';
import { requirePlatformOperatorId } from './platform-operations-query.js';
import { createPlatformOperationCursorCodec } from './platform-operations-query.js';

const ENTRA_IDENTITY_PROVIDER = 'microsoft_entra';

function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function contextRow(row) {
  if (!row) return null;
  return Object.freeze({
    contextId: row.id,
    operation: row.operation,
    tenantId: row.tenant_id,
    targetId: row.target_id,
    stateBinding: Object.freeze(row.state_binding),
    expiresAt: instant(row.expires_at),
    used: row.used_at !== null,
  });
}

function requireRepositories(tenantAuditRepository, platformAuditRepository) {
  if (!tenantAuditRepository || typeof tenantAuditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
  if (!platformAuditRepository || typeof platformAuditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }
}

function stateEquals(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function createPostgresPlatformRecoveryRepository(pool, {
  tenantAuditRepository,
  platformAuditRepository,
  onboardingRepository,
  tenantLifecycleRepository,
  cursorSecret,
  idFactory = randomUUID,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  requireRepositories(tenantAuditRepository, platformAuditRepository);
  if (!onboardingRepository || typeof onboardingRepository.unbindActiveWithClient !== 'function') {
    throw new TypeError('ONBOARDING_REPOSITORY_REQUIRED');
  }
  if (
    !tenantLifecycleRepository
    || typeof tenantLifecycleRepository.changeStatusWithClient !== 'function'
  ) throw new TypeError('TENANT_LIFECYCLE_REPOSITORY_REQUIRED');
  if (typeof idFactory !== 'function') throw new TypeError('ID_FACTORY_REQUIRED');
  const cursorCodec = createPlatformOperationCursorCodec({ secret: cursorSecret });
  const audit = { tenantAuditRepository, platformAuditRepository };

  async function findContext(client, { operatorId, contextId, lock = false }) {
    const result = await client.query({
      name: lock ? 'platform-recovery-context-lock' : 'platform-recovery-context-find',
      text: `
        SELECT id, operation, tenant_id, target_id, state_binding, expires_at, used_at
        FROM platform_recovery_contexts
        WHERE id = $1 AND operator_id = $2
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}
      `,
      values: [contextId, operatorId],
    });
    return contextRow(result.rows[0]);
  }

  async function execute(values, work) {
    return withPostgresTransaction(pool, async (client) => {
      const operatorId = requirePlatformOperatorId(values.authorization);
      await lockPlatformOperationReceipt(client, { operatorId, ...values });
      const replay = await findPlatformOperationReceipt(client, { operatorId, ...values });
      if (replay) {
        return replay.requestDigest === values.requestDigest
          ? Object.freeze({ outcome: 'idempotent', result: replay.result })
          : Object.freeze({ outcome: 'idempotency_conflict' });
      }
      await requireCurrentPlatformMutationAuthorization(client, values.authorization, values.tenantId);
      const context = await findContext(client, { operatorId, contextId: values.contextId, lock: true });
      if (!context) return Object.freeze({ outcome: 'not_found' });
      if (context.used) return Object.freeze({ outcome: 'used' });
      if (Date.parse(context.expiresAt) <= Date.parse(values.occurredAt)) {
        return Object.freeze({ outcome: 'expired' });
      }
      if (
        context.operation !== values.operation
        || context.tenantId !== values.tenantId
        || context.targetId !== values.targetId
      ) return Object.freeze({ outcome: 'wrong_action' });
      if (!stateEquals(context.stateBinding, values.expectedStateBinding)) {
        return Object.freeze({ outcome: 'stale' });
      }
      const result = await work(client, context, operatorId);
      if (!result || typeof result !== 'object' || result.outcome !== 'updated') return result;
      const consumed = await client.query({
        name: 'platform-recovery-context-consume',
        text: `
          UPDATE platform_recovery_contexts
          SET used_at = $2
          WHERE id = $1 AND used_at IS NULL AND expires_at > $2
        `,
        values: [context.contextId, values.occurredAt],
      });
      if (consumed.rowCount !== 1) return Object.freeze({ outcome: 'used' });
      await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
      await storePlatformOperationReceipt(client, {
        operatorId,
        operation: values.operation,
        tenantId: values.tenantId,
        idempotencyKey: values.idempotencyKey,
        requestDigest: values.requestDigest,
        result: result.result,
        occurredAt: values.occurredAt,
      });
      return result;
    });
  }

  const recoveryInspector = Object.freeze({
    async lastTenantAdmin({ tenantId, targetUserId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-last-admin',
        text: `
          SELECT tenant.lifecycle_revision AS tenant_revision,
                 target.security_version AS user_revision,
                 CASE WHEN target.active THEN 'active' ELSE 'disabled' END AS user_state,
                 CASE WHEN identity.user_id IS NULL THEN 'missing' ELSE 'active' END AS identity_state,
                 (SELECT count(*)::integer FROM tenant_user_roles
                  WHERE tenant_id = tenant.id AND role = 'tenant_admin') AS admin_count
          FROM tenants tenant
          JOIN users target ON target.tenant_id = tenant.id AND target.id = $2
          LEFT JOIN user_identity_bindings identity
            ON identity.tenant_id = target.tenant_id AND identity.user_id = target.id
          WHERE tenant.id = $1
          LIMIT 1
        `,
        values: [tenantId, targetUserId],
      });
      const row = result.rows[0];
      return Object.freeze({
        eligible: Boolean(row && row.user_state === 'active' && row.identity_state === 'active'),
        tenantRevision: Number(row?.tenant_revision ?? 1),
        userRevision: Number(row?.user_revision ?? 1),
        userState: row?.user_state ?? 'disabled',
        identityState: row?.identity_state ?? 'missing',
        currentTenantAdminCount: Number(row?.admin_count ?? 0),
        impactCodes: Object.freeze(['tenant_admin.restored', 'sessions.revoked']),
      });
    },

    async microsoftReconsent({ tenantId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-microsoft-reconsent',
        text: `
          SELECT integration.connection_version, integration.status,
                 EXISTS (SELECT 1 FROM tenant_user_roles
                         WHERE tenant_id = $1 AND role = 'tenant_admin') AS customer_admin_available
          FROM integrations integration
          WHERE integration.tenant_id = $1 AND integration.provider = 'microsoft365'
          LIMIT 1
        `,
        values: [tenantId],
      });
      const row = result.rows[0];
      const state = row?.status === 'pending' ? 'not_configured' : row?.status ?? 'not_configured';
      return Object.freeze({
        eligible: Boolean(row),
        connectionRevision: Number(row?.connection_version ?? 1),
        connectionState: state,
        customerAdminAvailable: row?.customer_admin_available === true,
        impactCodes: Object.freeze(['customer_consent.required']),
      });
    },

    async roomMappingRepair({ tenantId, mappingId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-room-mapping',
        text: `
          SELECT mapping.revision AS mapping_revision,
                 integration.connection_version AS connection_revision,
                 count(observation.external_room_id)::integer AS candidate_count
          FROM microsoft365_room_mappings mapping
          JOIN integrations integration
            ON integration.tenant_id = mapping.tenant_id AND integration.id = mapping.integration_id
          LEFT JOIN microsoft365_room_discovery_observations observation
            ON observation.tenant_id = mapping.tenant_id
           AND observation.integration_id = mapping.integration_id
           AND observation.connection_version = integration.connection_version
           AND observation.fresh_until > clock_timestamp()
           AND observation.provider_status = 'active'
           AND (observation.external_room_id = mapping.external_room_id
                OR lower(observation.resource_address) = lower(mapping.resource_address))
          WHERE mapping.tenant_id = $1 AND mapping.id = $2
          GROUP BY mapping.revision, integration.connection_version
        `,
        values: [tenantId, mappingId],
      });
      const row = result.rows[0];
      const count = Number(row?.candidate_count ?? 0);
      return Object.freeze({
        eligible: Boolean(row && count === 1),
        mappingRevision: Number(row?.mapping_revision ?? 1),
        connectionRevision: Number(row?.connection_revision ?? 1),
        candidateCount: count,
        deterministic: count === 1,
        impactCodes: Object.freeze(['room_mapping.repaired']),
      });
    },

    async identityUnbind({ tenantId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-identity-unbind',
        text: `
          SELECT binding.revision AS binding_revision,
                 tenant.lifecycle_revision, tenant.status AS lifecycle_status,
                 (SELECT count(*)::integer FROM booking_provider_references reference
                  WHERE reference.tenant_id = tenant.id
                    AND reference.state <> 'cancelled')
                   AS nonterminal_count,
                 (SELECT count(*)::integer FROM sessions session
                  WHERE session.tenant_id = tenant.id AND session.revoked_at IS NULL
                    AND session.expires_at > clock_timestamp()) AS active_session_count
          FROM tenants tenant
          JOIN tenant_identity_bindings binding
            ON binding.tenant_id = tenant.id AND binding.status = 'active'
          WHERE tenant.id = $1
          LIMIT 1
        `,
        values: [tenantId],
      });
      const row = result.rows[0];
      const references = Number(row?.nonterminal_count ?? 0);
      return Object.freeze({
        eligible: Boolean(row && ['pending', 'onboarding'].includes(row.lifecycle_status) && references === 0),
        bindingRevision: Number(row?.binding_revision ?? 1),
        lifecycleRevision: Number(row?.lifecycle_revision ?? 1),
        lifecycleStatus: row?.lifecycle_status ?? 'pending',
        nonTerminalReferenceCount: references,
        activeCustomerSessionCount: Number(row?.active_session_count ?? 0),
        impactCodes: Object.freeze(['identity.unbound', 'sessions.revoked']),
      });
    },

    async tenantSessionRevocation({ tenantId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-tenant-sessions',
        text: `
          SELECT tenant.customer_session_revision,
                 count(session.id) FILTER (WHERE session.revoked_at IS NULL
                   AND session.expires_at > clock_timestamp())::integer AS active_session_count
          FROM tenants tenant LEFT JOIN sessions session ON session.tenant_id = tenant.id
          WHERE tenant.id = $1 GROUP BY tenant.customer_session_revision
        `,
        values: [tenantId],
      });
      const row = result.rows[0];
      return Object.freeze({
        eligible: Boolean(row),
        securityRevision: Number(row?.customer_session_revision ?? 1),
        activeSessionCount: Number(row?.active_session_count ?? 0),
        impactCodes: Object.freeze(['sessions.revoked']),
      });
    },

    async userSessionRevocation({ tenantId, targetUserId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-user-sessions',
        text: `
          SELECT tenant.customer_session_revision, target.security_version,
                 count(session.id) FILTER (WHERE session.revoked_at IS NULL
                   AND session.expires_at > clock_timestamp())::integer AS active_session_count
          FROM tenants tenant JOIN users target ON target.tenant_id = tenant.id AND target.id = $2
          LEFT JOIN sessions session ON session.tenant_id = target.tenant_id AND session.user_id = target.id
          WHERE tenant.id = $1 GROUP BY tenant.customer_session_revision, target.security_version
        `,
        values: [tenantId, targetUserId],
      });
      const row = result.rows[0];
      return Object.freeze({
        eligible: Boolean(row),
        securityRevision: Number(row?.customer_session_revision ?? 1),
        userRevision: Number(row?.security_version ?? 1),
        activeSessionCount: Number(row?.active_session_count ?? 0),
        impactCodes: Object.freeze(['sessions.revoked']),
      });
    },

    async tenantLifecycle({ tenantId }) {
      const result = await pool.query({
        name: 'platform-recovery-inspect-lifecycle',
        text: 'SELECT lifecycle_revision, status FROM tenants WHERE id = $1 LIMIT 1',
        values: [tenantId],
      });
      const row = result.rows[0];
      return Object.freeze({
        eligible: Boolean(row),
        lifecycleRevision: Number(row?.lifecycle_revision ?? 1),
        lifecycleStatus: row?.status ?? 'pending',
        impactCodes: Object.freeze(['tenant.lifecycle_changed']),
      });
    },
  });

  const recoveryContextReader = Object.freeze({
    async findForExecution({ authorization, contextId }) {
      return findContext(pool, { operatorId: requirePlatformOperatorId(authorization), contextId });
    },
  });

  const recoveryTargetReader = Object.freeze({
    async list({ tenantId, operation, limit, cursor, authorization, evidence }) {
      const principal = authorization.principal;
      const scope = Object.freeze({
        operatorId: requirePlatformOperatorId(authorization),
        securityVersion: principal.securityVersion,
        mode: principal.targetScope.mode,
      });
      const filters = Object.freeze({ tenantId, operation });
      const decoded = cursor === null
        ? null
        : cursorCodec.decode(cursor, { kind: 'recovery_targets', scope, filters });
      const snapshotAt = decoded?.snapshotAt ?? (await pool.query({
        name: 'platform-recovery-target-clock',
        text: 'SELECT date_trunc(\'milliseconds\', clock_timestamp()) AS snapshot_at',
      })).rows[0].snapshot_at.toISOString();
      const afterId = decoded?.position?.id ?? null;
      let result;
      if (operation === 'last-tenant-admin' || operation === 'user-session-revocation') {
        result = await pool.query({
          name: 'platform-recovery-user-targets',
          text: `
            SELECT target.id,
                   CASE WHEN target.active THEN 'active' ELSE 'disabled' END AS user_state,
                   EXISTS (SELECT 1 FROM user_identity_bindings identity
                           WHERE identity.tenant_id = target.tenant_id
                             AND identity.user_id = target.id) AS identity_active,
                   EXISTS (SELECT 1 FROM tenant_user_roles role
                           WHERE role.tenant_id = target.tenant_id AND role.user_id = target.id
                             AND role.role = 'tenant_admin') AS already_admin,
                   (SELECT count(*)::integer FROM tenant_user_roles role
                    WHERE role.tenant_id = target.tenant_id AND role.role = 'tenant_admin') AS admin_count,
                   (SELECT count(*)::integer FROM sessions session
                    WHERE session.tenant_id = target.tenant_id AND session.user_id = target.id
                      AND session.revoked_at IS NULL AND session.expires_at > $3) AS active_sessions
            FROM users target
            WHERE target.tenant_id = $1 AND target.updated_at <= $3
              AND ($2::uuid IS NULL OR target.id > $2)
              AND EXISTS (
                SELECT 1 FROM platform_operators operator
                WHERE operator.id = $4 AND operator.status = 'active'
                  AND operator.security_version = $5
                  AND (operator.scope_mode = 'all' OR EXISTS (
                    SELECT 1 FROM platform_operator_tenant_scopes target_scope
                    WHERE target_scope.operator_id = operator.id AND target_scope.tenant_id = $1
                  ))
              )
            ORDER BY target.id LIMIT $6
          `,
          values: [tenantId, afterId, snapshotAt, scope.operatorId, scope.securityVersion, limit + 1],
        });
      } else if (operation === 'room-mapping-repair') {
        result = await pool.query({
          name: 'platform-recovery-mapping-targets',
          text: `
            SELECT mapping.id, mapping.provider_status, integration.status AS connection_state,
                   integration.places_permission_status,
                   count(observation.external_room_id)::integer AS candidate_count
            FROM microsoft365_room_mappings mapping
            JOIN integrations integration
              ON integration.tenant_id = mapping.tenant_id AND integration.id = mapping.integration_id
            LEFT JOIN microsoft365_room_discovery_observations observation
              ON observation.tenant_id = mapping.tenant_id
             AND observation.integration_id = mapping.integration_id
             AND observation.connection_version = integration.connection_version
             AND observation.fresh_until > $3 AND observation.provider_status = 'active'
             AND (observation.external_room_id = mapping.external_room_id
                  OR lower(observation.resource_address) = lower(mapping.resource_address))
            WHERE mapping.tenant_id = $1 AND mapping.updated_at <= $3
              AND ($2::uuid IS NULL OR mapping.id > $2)
              AND EXISTS (
                SELECT 1 FROM platform_operators operator
                WHERE operator.id = $4 AND operator.status = 'active'
                  AND operator.security_version = $5
                  AND (operator.scope_mode = 'all' OR EXISTS (
                    SELECT 1 FROM platform_operator_tenant_scopes target_scope
                    WHERE target_scope.operator_id = operator.id AND target_scope.tenant_id = $1
                  ))
              )
            GROUP BY mapping.id, mapping.provider_status, integration.status,
              integration.places_permission_status
            ORDER BY mapping.id LIMIT $6
          `,
          values: [tenantId, afterId, snapshotAt, scope.operatorId, scope.securityVersion, limit + 1],
        });
      } else {
        throw new TypeError('PLATFORM_RECOVERY_TARGET_OPERATION_INVALID');
      }
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const items = rows.map((row) => operation === 'room-mapping-repair'
        ? Object.freeze({
          mappingId: row.id,
          eligible: Number(row.candidate_count) === 1,
          mappingState: row.provider_status,
          connectionState: row.connection_state,
          placesPermission: row.places_permission_status,
          candidateCount: Number(row.candidate_count),
        })
        : Object.freeze({
          targetUserId: row.id,
          eligible: operation === 'last-tenant-admin'
            ? row.user_state === 'active' && row.identity_active && !row.already_admin
              && Number(row.admin_count) === 0
            : Number(row.active_sessions) > 0,
          userState: row.user_state,
          activeSessionCount: Number(row.active_sessions),
          ...(operation === 'last-tenant-admin' ? {
            identityState: row.identity_active ? 'active' : 'missing',
            alreadyTenantAdmin: row.already_admin,
            currentTenantAdminCount: Number(row.admin_count),
          } : {}),
        }));
      if (
        !evidence
        || typeof evidence !== 'object'
        || Object.keys(evidence).join(',') !== 'platformAuditEvent'
      ) throw new TypeError('PLATFORM_OPERATION_EVIDENCE_INVALID');
      const appended = await platformAuditRepository.append(
        evidence.platformAuditEvent,
        { expectedTargetTenantId: tenantId },
      );
      if (!appended || appended.targetTenantId !== tenantId) {
        throw new Error('PLATFORM_AUDIT_APPEND_FAILED');
      }
      return Object.freeze({
        items: Object.freeze(items),
        snapshotAt,
        nextCursor: hasMore
          ? cursorCodec.encode({
            kind: 'recovery_targets', scope, snapshotAt, filters,
            position: { id: rows.at(-1).id },
          })
          : null,
      });
    },
  });

  const recoveryContextTransactions = Object.freeze({
    async issue(values) {
      return withPostgresTransaction(pool, async (client) => {
        const operatorId = await requireCurrentPlatformMutationAuthorization(
          client,
          values.authorization,
          values.tenantId,
        );
        const contextId = idFactory();
        const principal = values.authorization.principal;
        await client.query({
          name: 'platform-recovery-context-issue',
          text: `
            INSERT INTO platform_recovery_contexts (
              id, operator_id, platform_session_id, break_glass_grant_id,
              operator_security_version, security_epoch, assurance_level, authenticated_at,
              operation, tenant_id, target_id, state_binding, impact_codes, correlation_id,
              issued_at, expires_at, retain_until
            ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                      $12, $13, $14, $15, platform_add_utc_months($15::timestamptz, 24))
          `,
          values: [
            contextId, operatorId, principal.session.id, principal.securityVersion,
            principal.session.securityEpoch, principal.assurance.level,
            principal.assurance.authenticatedAt, values.operation, values.tenantId,
            values.targetId, JSON.stringify(values.stateBinding), values.impactCodes,
            values.correlationId, values.occurredAt, values.expiresAt,
          ],
        });
        const appended = await platformAuditRepository.appendWithClient(
          client,
          values.evidence.platformAuditEvent,
          { expectedTargetTenantId: values.tenantId },
        );
        if (!appended || appended.targetTenantId !== values.tenantId) {
          throw new Error('PLATFORM_AUDIT_APPEND_FAILED');
        }
        return Object.freeze({ contextId, expiresAt: values.expiresAt });
      });
    },

    executeLastTenantAdmin(values) {
      return execute(values, async (client) => {
        const current = await client.query({
          name: 'platform-recovery-lock-last-admin',
          text: `
            SELECT tenant.lifecycle_revision, target.security_version, target.active,
                   EXISTS (SELECT 1 FROM user_identity_bindings identity
                           WHERE identity.tenant_id = target.tenant_id
                             AND identity.user_id = target.id) AS identity_active,
                   (SELECT count(*)::integer FROM tenant_user_roles role
                    WHERE role.tenant_id = tenant.id AND role.role = 'tenant_admin') AS admin_count
            FROM tenants tenant
            JOIN users target ON target.tenant_id = tenant.id AND target.id = $2
            WHERE tenant.id = $1 FOR UPDATE OF tenant, target
          `,
          values: [values.tenantId, values.targetId],
        });
        const row = current.rows[0];
        if (
          !row
          || Number(row.lifecycle_revision) !== values.expectedStateBinding.tenantRevision
          || Number(row.security_version) !== values.expectedStateBinding.userRevision
          || row.active !== true
          || row.identity_active !== true
          || Number(row.admin_count) !== 0
        ) return Object.freeze({ outcome: 'stale' });
        await client.query({
          name: 'platform-recovery-restore-last-admin-role',
          text: `INSERT INTO tenant_user_roles (tenant_id, user_id, role, created_at, updated_at)
                 VALUES ($1, $2, 'tenant_admin', $3, $3)`,
          values: [values.tenantId, values.targetId, values.occurredAt],
        });
        const revoked = await client.query({
          name: 'platform-recovery-revoke-restored-admin-sessions',
          text: `UPDATE sessions SET revoked_at = $3 WHERE tenant_id = $1 AND user_id = $2
                 AND revoked_at IS NULL AND expires_at > $3`,
          values: [values.tenantId, values.targetId, values.occurredAt],
        });
        const user = await client.query({
          name: 'platform-recovery-bump-restored-admin-version',
          text: `UPDATE users SET security_version = security_version + 1, updated_at = $3
                 WHERE tenant_id = $1 AND id = $2 RETURNING security_version`,
          values: [values.tenantId, values.targetId, values.occurredAt],
        });
        await client.query({
          name: 'platform-recovery-bump-tenant-session-revision-after-admin',
          text: `UPDATE tenants SET customer_session_revision = customer_session_revision + 1,
                 updated_at = $2 WHERE id = $1`,
          values: [values.tenantId, values.occurredAt],
        });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'tenant_admin_recovered',
          tenantRevision: Number(row.lifecycle_revision),
          userRevision: Number(user.rows[0].security_version),
          revokedSessionCount: revoked.rowCount,
        }) });
      });
    },

    executeMicrosoftReconsent(values) {
      return execute(values, async (client, _context, operatorId) => {
        const integration = await client.query({
          name: 'platform-recovery-lock-microsoft-reconsent',
          text: `SELECT id, connection_version FROM integrations
                 WHERE tenant_id = $1 AND provider = 'microsoft365' LIMIT 1 FOR UPDATE`,
          values: [values.tenantId],
        });
        if (
          !integration.rows[0]
          || Number(integration.rows[0].connection_version)
            !== values.expectedStateBinding.connectionRevision
        ) return Object.freeze({ outcome: 'stale' });
        const handoffId = idFactory();
        const handoff = await client.query({
          name: 'platform-recovery-create-microsoft-reconsent-handoff',
          text: `
            INSERT INTO platform_microsoft_reconsent_handoffs (
              id, recovery_context_id, tenant_id, integration_id, operator_id,
              created_at, expires_at, retain_until
            ) VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + INTERVAL '24 hours',
                      platform_add_utc_months($6::timestamptz + INTERVAL '24 hours', 24))
            RETURNING expires_at
          `,
          values: [handoffId, values.contextId, values.tenantId,
            integration.rows[0].id, operatorId, values.occurredAt],
        });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'customer_action_required',
          handoffId,
          expiresAt: instant(handoff.rows[0].expires_at),
        }) });
      });
    },

    executeRoomMappingRepair(values) {
      return execute(values, async (client) => {
        const candidates = await client.query({
          name: 'platform-recovery-lock-room-mapping-candidate',
          text: `
            SELECT mapping.revision AS mapping_revision, observation.external_room_id,
                   observation.resource_address, observation.provider_display_name,
                   observation.provider_capacity, observation.observed_at
            FROM microsoft365_room_mappings mapping
            JOIN integrations integration
              ON integration.tenant_id = mapping.tenant_id AND integration.id = mapping.integration_id
             AND integration.connection_version = $3
            JOIN microsoft365_room_discovery_observations observation
              ON observation.tenant_id = mapping.tenant_id
             AND observation.integration_id = mapping.integration_id
             AND observation.connection_version = integration.connection_version
             AND observation.fresh_until > $4
             AND observation.provider_status = 'active'
             AND (observation.external_room_id = mapping.external_room_id
                  OR lower(observation.resource_address) = lower(mapping.resource_address))
            WHERE mapping.tenant_id = $1 AND mapping.id = $2
              AND mapping.revision = $5
            FOR UPDATE OF mapping
          `,
          values: [values.tenantId, values.targetId,
            values.expectedStateBinding.connectionRevision, values.occurredAt,
            values.expectedStateBinding.mappingRevision],
        });
        if (candidates.rowCount !== 1) {
          return Object.freeze({ outcome: candidates.rowCount > 1 ? 'ambiguous' : 'stale' });
        }
        const candidate = candidates.rows[0];
        const updated = await client.query({
          name: 'platform-recovery-apply-room-mapping-candidate',
          text: `
            UPDATE microsoft365_room_mappings
            SET external_room_id = $3, resource_address = $4, provider_display_name = $5,
                provider_capacity = $6, provider_status = 'active', last_seen_at = $7,
                updated_at = $8, revision = revision + 1
            WHERE tenant_id = $1 AND id = $2 AND revision = $9 RETURNING revision
          `,
          values: [values.tenantId, values.targetId, candidate.external_room_id,
            candidate.resource_address, candidate.provider_display_name,
            candidate.provider_capacity, candidate.observed_at, values.occurredAt,
            values.expectedStateBinding.mappingRevision],
        });
        if (updated.rowCount !== 1) return Object.freeze({ outcome: 'stale' });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'repaired', mappingRevision: Number(updated.rows[0].revision),
        }) });
      });
    },

    executeIdentityUnbind(values) {
      return execute(values, async (client) => {
        const result = await onboardingRepository.unbindActiveWithClient(client, {
          tenantId: values.tenantId,
          provider: ENTRA_IDENTITY_PROVIDER,
          changedAt: new Date(values.occurredAt),
          expectedBindingRevision: values.expectedStateBinding.bindingRevision,
          expectedLifecycleRevision: values.expectedStateBinding.lifecycleRevision,
          expectedLifecycleStatus: values.expectedStateBinding.lifecycleStatus,
        });
        if (!result) return Object.freeze({ outcome: 'stale' });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'unbound',
          bindingRevision: result.bindingRevision,
          revokedSessionCount: result.revokedSessionCount,
        }) });
      });
    },

    executeTenantSessionRevocation(values) {
      return execute(values, async (client) => {
        const current = await client.query({
          name: 'platform-recovery-lock-tenant-sessions',
          text: 'SELECT customer_session_revision FROM tenants WHERE id = $1 FOR UPDATE',
          values: [values.tenantId],
        });
        if (Number(current.rows[0]?.customer_session_revision) !== values.expectedStateBinding.securityRevision) {
          return Object.freeze({ outcome: 'stale' });
        }
        const revoked = await client.query({
          name: 'platform-recovery-revoke-tenant-sessions',
          text: `UPDATE sessions SET revoked_at = $2 WHERE tenant_id = $1
                 AND revoked_at IS NULL AND expires_at > $2`,
          values: [values.tenantId, values.occurredAt],
        });
        const updated = await client.query({
          name: 'platform-recovery-increment-tenant-session-revision',
          text: `UPDATE tenants SET customer_session_revision = customer_session_revision + 1,
                 updated_at = $2 WHERE id = $1 RETURNING customer_session_revision`,
          values: [values.tenantId, values.occurredAt],
        });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'revoked',
          revokedSessionCount: revoked.rowCount,
          securityRevision: Number(updated.rows[0].customer_session_revision),
        }) });
      });
    },

    executeUserSessionRevocation(values) {
      return execute(values, async (client) => {
        const current = await client.query({
          name: 'platform-recovery-lock-user-sessions',
          text: `SELECT security_version FROM users
                 WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          values: [values.tenantId, values.targetId],
        });
        if (Number(current.rows[0]?.security_version) !== values.expectedStateBinding.userRevision) {
          return Object.freeze({ outcome: 'stale' });
        }
        const revoked = await client.query({
          name: 'platform-recovery-revoke-user-sessions',
          text: `UPDATE sessions SET revoked_at = $3 WHERE tenant_id = $1 AND user_id = $2
                 AND revoked_at IS NULL AND expires_at > $3`,
          values: [values.tenantId, values.targetId, values.occurredAt],
        });
        const updated = await client.query({
          name: 'platform-recovery-increment-user-security-version',
          text: `UPDATE users SET security_version = security_version + 1, updated_at = $3
                 WHERE tenant_id = $1 AND id = $2 RETURNING security_version`,
          values: [values.tenantId, values.targetId, values.occurredAt],
        });
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          status: 'revoked',
          revokedSessionCount: revoked.rowCount,
          securityRevision: Number(updated.rows[0].security_version),
        }) });
      });
    },

    executeTenantLifecycle(values) {
      return execute(values, async (client) => {
        const changed = await tenantLifecycleRepository.changeStatusWithClient(client, {
          tenantId: values.tenantId,
          expectedStatus: values.expectedStateBinding.lifecycleStatus,
          expectedRevision: values.expectedStateBinding.lifecycleRevision,
          targetStatus: values.targetStatus,
          changedAt: new Date(values.occurredAt),
        });
        if (changed.outcome !== 'updated') return changed;
        return Object.freeze({ outcome: 'updated', result: Object.freeze({
          tenantId: values.tenantId,
          status: changed.tenant.status,
          revision: changed.revision,
          changedAt: changed.tenant.updatedAt,
        }) });
      });
    },
  });

  return Object.freeze({
    recoveryInspector,
    recoveryContextReader,
    recoveryContextTransactions,
    recoveryTargetReader,
  });
}
