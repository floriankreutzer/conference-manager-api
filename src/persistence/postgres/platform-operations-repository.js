import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';
import {
  createPlatformOperationCursorCodec,
  platformScopeSql,
  requirePlatformFleetScope,
  requirePlatformOperatorId,
} from './platform-operations-query.js';

const DIRECTORY_SCOPE_SQL = platformScopeSql('tenant', 1);

function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function receiptRow(row) {
  if (!row) return null;
  return Object.freeze({ requestDigest: row.request_digest, result: row.result });
}

function operatorSecurityVersion(authorization) {
  const value = authorization?.principal?.securityVersion;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('PLATFORM_OPERATION_AUTHORIZATION_INVALID');
  }
  return value;
}

export async function lockPlatformOperationReceipt(
  client,
  { operatorId, operation, tenantId, idempotencyKey },
) {
  await client.query({
    name: 'platform-operation-receipt-advisory-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [`${operatorId}:${operation}:${tenantId ?? 'global'}:${idempotencyKey}`],
  });
}

export async function findPlatformOperationReceipt(
  client,
  { operatorId, operation, tenantId, idempotencyKey },
) {
  const result = await client.query({
    name: 'platform-operation-receipt-find',
    text: `
      SELECT request_digest, result
      FROM platform_operation_receipts
      WHERE operator_id = $1
        AND operation = $2
        AND target_tenant_id IS NOT DISTINCT FROM $3::uuid
        AND idempotency_key = $4
      LIMIT 1
    `,
    values: [operatorId, operation, tenantId, idempotencyKey],
  });
  return receiptRow(result.rows[0]);
}

export async function storePlatformOperationReceipt(client, {
  operatorId,
  operation,
  tenantId,
  idempotencyKey,
  requestDigest,
  result,
  occurredAt,
}) {
  await client.query({
    name: 'platform-operation-receipt-insert',
    text: `
      INSERT INTO platform_operation_receipts (
        operator_id, operation, target_tenant_id, idempotency_key,
        request_digest, result, created_at, retain_until
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7,
        platform_add_utc_months($7::timestamptz, 24))
    `,
    values: [
      operatorId,
      operation,
      tenantId,
      idempotencyKey,
      requestDigest,
      JSON.stringify(result),
      occurredAt,
    ],
  });
}

export async function requireCurrentPlatformMutationAuthorization(
  client,
  authorization,
  tenantId,
  { creation = false } = {},
) {
  const operatorId = requirePlatformOperatorId(authorization);
  const securityVersion = operatorSecurityVersion(authorization);
  const principal = authorization.principal;
  const permission = authorization.permission;
  const result = await client.query({
    name: creation ? 'platform-operation-authorize-creation' : 'platform-operation-authorize-target',
    text: `
      SELECT 1
      FROM platform_operators operator
      JOIN platform_sessions session
        ON session.id = $5
       AND session.operator_id = operator.id
      WHERE operator.id = $1
        AND operator.status = 'active'
        AND operator.security_version = $2
        AND operator.roles = $6::text[]
        AND session.revoked_at IS NULL
        AND session.expires_at > clock_timestamp()
        AND session.principal_version = operator.security_version
        AND session.security_epoch = $7
        AND session.roles = operator.roles
        AND session.permissions = $8::text[]
        AND $9 = ANY(session.permissions)
        AND session.assurance_level = $10
        AND session.authenticated_at = $11
        AND (
          $10 <> 'step_up'
          OR session.step_up_expires_at > clock_timestamp()
        )
        AND (
          ($3::boolean = true AND operator.scope_mode = 'all')
          OR (
            $3::boolean = false
            AND (
              operator.scope_mode = 'all'
              OR EXISTS (
                SELECT 1
                FROM platform_operator_tenant_scopes target_scope
                WHERE target_scope.operator_id = operator.id
                  AND target_scope.tenant_id = $4
              )
            )
          )
        )
      LIMIT 1
      FOR SHARE
    `,
    values: [
      operatorId,
      securityVersion,
      creation,
      tenantId,
      principal.session.id,
      principal.roles,
      principal.session.securityEpoch,
      principal.permissions,
      permission,
      principal.assurance.level,
      principal.assurance.authenticatedAt,
    ],
  });
  if (result.rowCount !== 1) {
    const error = new Error(creation ? 'PLATFORM_TENANT_CREATION_DENIED' : 'PLATFORM_TENANT_TARGET_DENIED');
    error.name = 'PlatformAuthorizationError';
    error.code = error.message;
    throw error;
  }
  return operatorId;
}

function requireAuditRepositories(tenantAuditRepository, platformAuditRepository) {
  if (!tenantAuditRepository || typeof tenantAuditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
  if (!platformAuditRepository || typeof platformAuditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }
}

export async function appendPlatformMutationEvidence(
  client,
  evidence,
  tenantId,
  { tenantAuditRepository, platformAuditRepository },
) {
  if (
    !evidence
    || typeof evidence !== 'object'
    || Array.isArray(evidence)
    || Object.keys(evidence).sort().join(',') !== 'platformAuditEvent,tenantAuditEvent'
  ) throw new TypeError('PLATFORM_OPERATION_EVIDENCE_INVALID');
  const tenantAudit = await tenantAuditRepository.appendWithClient(client, evidence.tenantAuditEvent);
  if (!tenantAudit || tenantAudit.tenantId !== tenantId) throw new Error('TENANT_AUDIT_APPEND_FAILED');
  const platformAudit = await platformAuditRepository.appendWithClient(
    client,
    evidence.platformAuditEvent,
    { expectedTargetTenantId: tenantId },
  );
  if (!platformAudit || platformAudit.targetTenantId !== tenantId) throw new Error('PLATFORM_AUDIT_APPEND_FAILED');
}

function directoryRow(row) {
  const invitationState = row.invitation_id === null
    ? 'none'
    : row.consumed_at !== null
      ? 'consumed'
      : row.revoked_at !== null
        ? 'revoked'
        : Date.parse(instant(row.invitation_expires_at)) <= Date.parse(instant(row.snapshot_at))
          ? 'expired'
          : 'open';
  const identityState = row.binding_status === 'active'
    ? 'active'
    : row.binding_status === 'unbound'
      ? 'unbound'
      : 'pending';
  const onboardingState = identityState === 'active'
    ? ['ready', 'active', 'suspended', 'archived'].includes(row.lifecycle_status) ? 'complete' : 'claimed'
    : row.claim_pending === true
      ? 'claim_pending'
      : row.invitation_id === null ? 'not_started' : 'invited';
  return Object.freeze({
    tenantId: row.tenant_id,
    displayName: row.display_name,
    lifecycleStatus: row.lifecycle_status,
    lifecycleRevision: Number(row.lifecycle_revision),
    onboardingState,
    identityState,
    invitationId: row.invitation_id,
    invitationState,
    invitationRevision: row.invitation_id === null ? null : Number(row.invitation_revision),
    invitationExpiresAt: row.invitation_id === null ? null : instant(row.invitation_expires_at),
    updatedAt: instant(row.tenant_updated_at),
  });
}

function invitationRow(row, now = Date.now()) {
  if (!row) return null;
  const state = row.consumed_at !== null
    ? 'consumed'
    : row.revoked_at !== null
      ? 'revoked'
      : Date.parse(instant(row.expires_at)) <= now ? 'expired' : 'open';
  return Object.freeze({
    tenantId: row.tenant_id,
    invitationId: row.id,
    state,
    revision: Number(row.revision),
    expiresAt: instant(row.expires_at),
  });
}

function packageRow(row, { includeTemplate = false } = {}) {
  if (!row) return null;
  return Object.freeze({
    packageId: row.package_id,
    revision: Number(row.revision),
    name: row.name,
    description: row.description,
    status: row.status,
    ...(includeTemplate ? { proposals: Object.freeze(row.proposals) } : {}),
  });
}

export function createPostgresPlatformOperationReceiptRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  return Object.freeze({
    async find({ authorization, operation, tenantId, idempotencyKey }) {
      return findPlatformOperationReceipt(pool, {
        operatorId: requirePlatformOperatorId(authorization),
        operation,
        tenantId,
        idempotencyKey,
      });
    },
  });
}

export function createPostgresPlatformTenantOperationsRepository(pool, {
  tenantAuditRepository,
  platformAuditRepository,
  onboardingRepository,
  tenantLifecycleRepository,
  cursorSecret,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  requireAuditRepositories(tenantAuditRepository, platformAuditRepository);
  if (
    !onboardingRepository
    || typeof onboardingRepository.findInvitationByTenantId !== 'function'
    || typeof onboardingRepository.createTenantInvitationWithClient !== 'function'
    || typeof onboardingRepository.revokeInvitationWithClient !== 'function'
    || typeof onboardingRepository.reissueInvitationWithClient !== 'function'
  ) throw new TypeError('TENANT_ONBOARDING_REPOSITORY_REQUIRED');
  if (
    !tenantLifecycleRepository
    || typeof tenantLifecycleRepository.findLifecycleById !== 'function'
    || typeof tenantLifecycleRepository.changeStatusWithClient !== 'function'
  ) throw new TypeError('TENANT_LIFECYCLE_REPOSITORY_REQUIRED');
  const cursorCodec = createPlatformOperationCursorCodec({ secret: cursorSecret });
  const audit = { tenantAuditRepository, platformAuditRepository };

  async function mutateReceipt(values, work, { creation = false } = {}) {
    return withPostgresTransaction(pool, async (client) => {
      const operatorId = requirePlatformOperatorId(values.authorization);
      await lockPlatformOperationReceipt(client, { operatorId, ...values });
      const replay = await findPlatformOperationReceipt(client, { operatorId, ...values });
      if (replay) {
        return replay.requestDigest === values.requestDigest
          ? Object.freeze({ outcome: 'idempotent', ...replay.result })
          : Object.freeze({ outcome: 'idempotency_conflict' });
      }
      await requireCurrentPlatformMutationAuthorization(
        client,
        values.authorization,
        values.tenantId,
        { creation },
      );
      return work(client, operatorId);
    });
  }

  return Object.freeze({
    directoryReader: Object.freeze({
      async list({ query, authorization }) {
        const scope = requirePlatformFleetScope(authorization);
        const filters = Object.freeze({
          lifecycleStatus: query.lifecycleStatus,
          search: query.search === null ? null : query.search.toLowerCase(),
        });
        const cursor = query.cursor === null
          ? null
          : cursorCodec.decode(query.cursor, { kind: 'tenant_directory', scope, filters });
        const snapshotAt = cursor?.snapshotAt ?? (await pool.query({
          name: 'platform-directory-snapshot-clock',
          text: 'SELECT clock_timestamp() AS snapshot_at',
        })).rows[0].snapshot_at.toISOString();
        const afterTenantId = cursor?.position?.tenantId ?? null;
        if (afterTenantId !== null && !isInternalUuid(afterTenantId)) {
          throw new TypeError('PLATFORM_OPERATION_CURSOR_INVALID');
        }
        const page = await pool.query({
          name: 'platform-tenant-directory-page',
          text: `
            WITH authorized_tenants AS MATERIALIZED (
              SELECT tenant.*
              FROM tenants tenant
              WHERE ${DIRECTORY_SCOPE_SQL}
            )
            SELECT
              tenant.id AS tenant_id,
              tenant.display_name,
              tenant.status AS lifecycle_status,
              tenant.lifecycle_revision,
              tenant.updated_at AS tenant_updated_at,
              invitation.id AS invitation_id,
              invitation.revision AS invitation_revision,
              invitation.expires_at AS invitation_expires_at,
              invitation.consumed_at,
              invitation.revoked_at,
              binding.status AS binding_status,
              EXISTS (
                SELECT 1 FROM tenant_claim_transactions claim
                WHERE claim.invitation_id = invitation.id AND claim.expires_at > $4
              ) AS claim_pending,
              $4::timestamptz AS snapshot_at
            FROM authorized_tenants tenant
            LEFT JOIN LATERAL (
              SELECT id, revision, expires_at, consumed_at, revoked_at
              FROM tenant_onboarding_invitations
              WHERE tenant_id = tenant.id AND created_at <= $4
              ORDER BY created_at DESC, id DESC
              LIMIT 1
            ) invitation ON true
            LEFT JOIN LATERAL (
              SELECT status
              FROM tenant_identity_bindings
              WHERE tenant_id = tenant.id AND updated_at <= $4
              ORDER BY (status = 'active') DESC, updated_at DESC, id DESC
              LIMIT 1
            ) binding ON true
            WHERE tenant.updated_at <= $4
              AND ($5::varchar IS NULL OR tenant.status = $5)
              AND ($6::varchar IS NULL OR tenant.display_name ILIKE ('%' || $6 || '%'))
              AND ($7::uuid IS NULL OR tenant.id > $7)
            ORDER BY tenant.id ASC
            LIMIT $8
          `,
          values: [
            scope.operatorId,
            scope.securityVersion,
            scope.mode,
            snapshotAt,
            query.lifecycleStatus,
            query.search,
            afterTenantId,
            query.limit + 1,
          ],
        });
        const hasMore = page.rows.length > query.limit;
        const rows = hasMore ? page.rows.slice(0, query.limit) : page.rows;
        return Object.freeze({
          items: Object.freeze(rows.map(directoryRow)),
          snapshotAt,
          nextCursor: hasMore
            ? cursorCodec.encode({
              kind: 'tenant_directory',
              scope,
              snapshotAt,
              filters,
              position: { tenantId: rows.at(-1).tenant_id },
            })
            : null,
        });
      },
    }),

    invitationReader: Object.freeze({
      async findById(tenantId, invitationId) {
        const invitation = await onboardingRepository.findInvitationByTenantId(tenantId, invitationId);
        if (!invitation) return null;
        return invitationRow({
          id: invitation.invitationId,
          tenant_id: invitation.tenantId,
          revision: invitation.revision,
          expires_at: invitation.expiresAt,
          consumed_at: invitation.consumedAt,
          revoked_at: invitation.revokedAt,
        });
      },
    }),

    invitationTransactions: Object.freeze({
      async create(values) {
        try {
          return await mutateReceipt(values, async (client, operatorId) => {
            const created = await onboardingRepository.createTenantInvitationWithClient(client, {
              tenantId: values.tenantId,
              displayName: values.displayName,
              invitationId: values.invitationId,
              tokenHash: values.tokenHash,
              createdAt: new Date(values.occurredAt),
              expiresAt: new Date(values.expiresAt),
            });
            if (!created) return Object.freeze({ outcome: 'identifier_conflict' });
            await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
            const result = Object.freeze({
              tenant: created.tenant,
              invitation: Object.freeze({
                invitationId: created.invitation.invitationId,
                state: 'open',
                revision: created.invitation.revision,
                expiresAt: created.invitation.expiresAt,
              }),
            });
            await storePlatformOperationReceipt(client, { operatorId, ...values, result });
            return Object.freeze({ outcome: 'updated', ...result });
          }, { creation: true });
        } catch (error) {
          if (
            error?.code === '23505'
            && [
              'tenants_pkey',
              'tenant_onboarding_invitations_pkey',
              'tenant_onboarding_invitations_token_hash_key',
            ].includes(error.constraint)
          ) return Object.freeze({ outcome: 'identifier_conflict' });
          throw error;
        }
      },

      revoke(values) {
        return mutateReceipt(values, async (client, operatorId) => {
          const updated = await onboardingRepository.revokeInvitationWithClient(client, {
            tenantId: values.tenantId,
            invitationId: values.invitationId,
            expectedRevision: values.expectedRevision,
            changedAt: new Date(values.occurredAt),
          });
          if (!updated) return Object.freeze({ outcome: 'stale' });
          await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
          const result = Object.freeze({
            invitation: Object.freeze({
              invitationId: updated.invitationId,
              state: 'revoked',
              revision: updated.revision,
              expiresAt: updated.expiresAt,
            }),
          });
          await storePlatformOperationReceipt(client, { operatorId, ...values, result });
          return Object.freeze({ outcome: 'updated', ...result });
        });
      },

      reissue(values) {
        return mutateReceipt(values, async (client, operatorId) => {
          const inserted = await onboardingRepository.reissueInvitationWithClient(client, {
            tenantId: values.tenantId,
            invitationId: values.invitationId,
            expectedRevision: values.expectedRevision,
            newInvitationId: values.newInvitationId,
            tokenHash: values.tokenHash,
            changedAt: new Date(values.occurredAt),
            expiresAt: new Date(values.expiresAt),
          });
          if (!inserted) return Object.freeze({ outcome: 'stale' });
          await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
          const result = Object.freeze({
            invitation: Object.freeze({
              invitationId: inserted.invitationId,
              state: 'open',
              revision: inserted.revision,
              expiresAt: inserted.expiresAt,
            }),
          });
          await storePlatformOperationReceipt(client, { operatorId, ...values, result });
          return Object.freeze({ outcome: 'updated', ...result });
        });
      },
    }),

    lifecycleReader: Object.freeze({
      async findCurrent(tenantId) {
        return tenantLifecycleRepository.findLifecycleById(tenantId);
      },
    }),

    lifecycleTransactions: Object.freeze({
      compareAndSet(values) {
        return mutateReceipt(values, async (client, operatorId) => {
          const changed = await tenantLifecycleRepository.changeStatusWithClient(client, {
            tenantId: values.tenantId,
            expectedStatus: values.expectedStatus,
            expectedRevision: values.expectedRevision,
            targetStatus: values.targetStatus,
            changedAt: new Date(values.occurredAt),
            requireReady: ['ready', 'active'].includes(values.targetStatus),
          });
          if (changed.outcome !== 'updated') return changed;
          await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
          const result = Object.freeze({
            tenant: Object.freeze({
              tenantId: changed.tenant.id,
              status: changed.tenant.status,
              revision: changed.revision,
              changedAt: changed.tenant.updatedAt,
            }),
          });
          await storePlatformOperationReceipt(client, { operatorId, ...values, result });
          return Object.freeze({ outcome: 'updated', ...result });
        });
      },
    }),
  });
}

export function createPostgresPlatformEntitlementOperationsRepository(pool, {
  tenantAuditRepository,
  platformAuditRepository,
  entitlementRepository,
  cursorSecret,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  requireAuditRepositories(tenantAuditRepository, platformAuditRepository);
  if (
    !entitlementRepository
    || typeof entitlementRepository.findTenantState !== 'function'
    || typeof entitlementRepository.applyChangesWithClient !== 'function'
  ) throw new TypeError('ENTITLEMENT_REPOSITORY_REQUIRED');
  const cursorCodec = createPlatformOperationCursorCodec({ secret: cursorSecret });
  const audit = { tenantAuditRepository, platformAuditRepository };

  return Object.freeze({
    packageReader: Object.freeze({
      async list({ query, authorization }) {
        const scope = requirePlatformFleetScope(authorization);
        const filters = Object.freeze({});
        const cursor = query.cursor === null
          ? null
          : cursorCodec.decode(query.cursor, { kind: 'entitlement_packages', scope, filters });
        const snapshotAt = cursor?.snapshotAt ?? (await pool.query({
          name: 'platform-package-snapshot-clock',
          text: 'SELECT clock_timestamp() AS snapshot_at',
        })).rows[0].snapshot_at.toISOString();
        const afterPackageId = cursor?.position?.packageId ?? null;
        const page = await pool.query({
          name: 'platform-entitlement-package-page',
          text: `
            SELECT package.package_id, package.revision, package.name,
              package.description, package.status
            FROM platform_entitlement_packages package
            WHERE package.updated_at <= $4
              AND ($5::varchar IS NULL OR package.package_id > $5)
              AND EXISTS (
                SELECT 1 FROM platform_operators operator
                WHERE operator.id = $1 AND operator.status = 'active'
                  AND operator.security_version = $2 AND operator.scope_mode = $3
              )
            ORDER BY package.package_id ASC
            LIMIT $6
          `,
          values: [
            scope.operatorId,
            scope.securityVersion,
            scope.mode,
            snapshotAt,
            afterPackageId,
            query.limit + 1,
          ],
        });
        const hasMore = page.rows.length > query.limit;
        const rows = hasMore ? page.rows.slice(0, query.limit) : page.rows;
        return Object.freeze({
          items: Object.freeze(rows.map((row) => packageRow(row))),
          snapshotAt,
          nextCursor: hasMore
            ? cursorCodec.encode({
              kind: 'entitlement_packages',
              scope,
              snapshotAt,
              filters,
              position: { packageId: rows.at(-1).package_id },
            })
            : null,
        });
      },
      async findById(packageId) {
        const result = await pool.query({
          name: 'platform-entitlement-package-find',
          text: `
            SELECT package_id, revision, name, description, status, proposals
            FROM platform_entitlement_packages
            WHERE package_id = $1
            LIMIT 1
          `,
          values: [packageId],
        });
        return packageRow(result.rows[0], { includeTemplate: true });
      },
    }),

    entitlementReader: Object.freeze({
      async findTenantState(tenantId) {
        return withPostgresTransaction(pool, async (client) => {
          return entitlementRepository.findTenantState(tenantId, { client });
        }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
      },
    }),

    entitlementTransactions: Object.freeze({
      apply(values) {
        return withPostgresTransaction(pool, async (client) => {
          const operatorId = requirePlatformOperatorId(values.authorization);
          await lockPlatformOperationReceipt(client, { operatorId, ...values });
          const replay = await findPlatformOperationReceipt(client, { operatorId, ...values });
          if (replay) {
            return replay.requestDigest === values.requestDigest
              ? Object.freeze({ outcome: 'idempotent', ...replay.result })
              : Object.freeze({ outcome: 'idempotency_conflict' });
          }
          await requireCurrentPlatformMutationAuthorization(
            client,
            values.authorization,
            values.tenantId,
          );
          if (values.packageId !== null) {
            const packageResult = await client.query({
              name: 'platform-entitlement-lock-package',
              text: `
                SELECT revision, status
                FROM platform_entitlement_packages
                WHERE package_id = $1 FOR SHARE
              `,
              values: [values.packageId],
            });
            if (
              packageResult.rowCount !== 1
              || packageResult.rows[0].status !== 'active'
              || Number(packageResult.rows[0].revision) !== values.expectedPackageRevision
            ) return Object.freeze({ outcome: 'package_stale' });
          }
          const applied = await entitlementRepository.applyChangesWithClient(client, {
            tenantId: values.tenantId,
            expectedRevision: values.expectedEntitlementRevision,
            expectedStatus: values.expectedTenantStatus,
            changes: values.changes,
            changedAt: new Date(values.occurredAt),
          });
          if (applied.outcome !== 'updated') return Object.freeze({ outcome: 'stale' });
          const revision = applied.state.revision;
          await client.query({
            name: 'platform-entitlement-history-append',
            text: `
              INSERT INTO platform_entitlement_change_history (
                tenant_id, entitlement_revision, capability_id, previous_enabled,
                enabled, effective_at, operator_id, package_id, package_revision,
                correlation_id, reason
              )
              SELECT $1, $2, change.capability_id, change.previous_enabled,
                change.enabled, $3, $4, $5, $6, $7, $8
              FROM jsonb_to_recordset($9::jsonb) AS change(
                capability_id varchar, previous_enabled boolean, enabled boolean
              )
            `,
            values: [
              values.tenantId,
              revision,
              values.occurredAt,
              operatorId,
              values.packageId,
              values.expectedPackageRevision,
              values.correlationId,
              values.reason,
              JSON.stringify(applied.previous.map((change) => ({
                capability_id: change.capabilityId,
                previous_enabled: change.previousEnabled,
                enabled: change.enabled,
              }))),
            ],
          });
          await appendPlatformMutationEvidence(client, values.evidence, values.tenantId, audit);
          const result = Object.freeze({
            entitlements: applied.state,
          });
          await storePlatformOperationReceipt(client, { operatorId, ...values, result });
          return Object.freeze({ outcome: 'updated', ...result });
        });
      },
    }),
  });
}
