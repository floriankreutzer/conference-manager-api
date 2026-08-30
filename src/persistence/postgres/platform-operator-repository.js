import { isInternalUuid } from '../../domain/identifiers.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  normalizePlatformAuditEvent,
} from '../../platform/audit/event.js';
import { permissionsForPlatformRoles } from '../../platform/identity/policy.js';
import { withPostgresTransaction } from './transaction.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const MAX_TARGET_SCOPE_SIZE = 500;

function mapOperator(row, tenantIds) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    status: row.status,
    roles: Object.freeze([...row.roles]),
    securityVersion: Number(row.security_version),
    scopeMode: row.scope_mode,
    providerIdentity: Object.freeze({
      provider: row.provider,
      tenantReference: row.provider_tenant_reference,
      subjectReference: row.provider_subject_reference,
    }),
    ...(tenantIds ? { tenantIds: Object.freeze([...tenantIds]) } : {}),
  });
}

function requireApprovalRecord(record, action) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('PLATFORM_OPERATOR_CHANGE_INVALID');
  }
  const commonKeys = [
    'actorOperatorId',
    'actorSecurityVersion',
    'approverOperatorId',
    'approverSecurityVersion',
    'correlationId',
  ];
  const actionKeys = action === 'create'
    ? ['id', 'providerIdentity', 'roles', 'scopeMode', 'tenantIds']
    : action === 'access_changed'
      ? ['expectedSecurityVersion', 'operatorId', 'roles', 'scopeMode', 'tenantIds']
      : ['expectedSecurityVersion', 'operatorId'];
  if (Object.keys(record).sort().join(',') !== [...commonKeys, ...actionKeys].sort().join(',')) {
    throw new TypeError('PLATFORM_OPERATOR_CHANGE_INVALID');
  }
  if (
    !isInternalUuid(record.actorOperatorId)
    || !Number.isSafeInteger(record.actorSecurityVersion)
    || record.actorSecurityVersion < 1
    || !isInternalUuid(record.approverOperatorId)
    || !Number.isSafeInteger(record.approverSecurityVersion)
    || record.approverSecurityVersion < 1
    || record.actorOperatorId === record.approverOperatorId
    || !isInternalUuid(record.correlationId)
  ) throw new TypeError('PLATFORM_OPERATOR_APPROVAL_INVALID');
  if (action !== 'create' && (
    !isInternalUuid(record.operatorId)
    || !Number.isSafeInteger(record.expectedSecurityVersion)
    || record.expectedSecurityVersion < 1
  )) throw new TypeError('PLATFORM_OPERATOR_TARGET_INVALID');
  if (action === 'create' && (
    !isInternalUuid(record.id)
    || !record.providerIdentity
    || Object.keys(record.providerIdentity).sort().join(',')
      !== 'provider,subjectReference,tenantReference'
    || !PROVIDER_PATTERN.test(record.providerIdentity.provider || '')
    || !REFERENCE_PATTERN.test(record.providerIdentity.tenantReference || '')
    || !REFERENCE_PATTERN.test(record.providerIdentity.subjectReference || '')
  )) throw new TypeError('PLATFORM_OPERATOR_IDENTITY_INVALID');
  if (action !== 'disabled') {
    permissionsForPlatformRoles(record.roles);
    if (!['all', 'allowlist'].includes(record.scopeMode)) {
      throw new TypeError('PLATFORM_OPERATOR_SCOPE_INVALID');
    }
    if (
      !Array.isArray(record.tenantIds)
      || record.tenantIds.length > MAX_TARGET_SCOPE_SIZE
      || record.tenantIds.some((tenantId) => !isInternalUuid(tenantId))
      || new Set(record.tenantIds).size !== record.tenantIds.length
      || record.tenantIds.some((tenantId, index) => index > 0 && tenantId <= record.tenantIds[index - 1])
      || (record.scopeMode === 'all' && record.tenantIds.length !== 0)
    ) throw new TypeError('PLATFORM_OPERATOR_SCOPE_INVALID');
  }
  return record;
}

function requireEventFactory(value) {
  if (typeof value !== 'function') throw new TypeError('PLATFORM_AUDIT_EVENT_FACTORY_REQUIRED');
  return value;
}

function requireOperatorEvents(value, record, targetOperatorId) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('PLATFORM_OPERATOR_AUDIT_EVENTS_INVALID');
  }
  const events = value.map(normalizePlatformAuditEvent);
  const expectedActors = [record.actorOperatorId, record.approverOperatorId].sort();
  const actualActors = events.map((event) => event.operatorId).sort();
  if (
    actualActors.some((operatorId, index) => operatorId !== expectedActors[index])
    || events.some((event) => (
      event.action !== PLATFORM_AUDIT_ACTION.OPERATOR_CHANGED
      || event.outcome !== PLATFORM_AUDIT_OUTCOME.SUCCESS
      || event.assuranceLevel !== 'step_up'
      || event.targetTenantId !== null
      || event.targetType !== 'platform_operator'
      || event.targetId !== targetOperatorId
    ))
  ) throw new TypeError('PLATFORM_OPERATOR_AUDIT_EVENTS_INVALID');
  return events;
}

async function lockApprovalPair(client, record) {
  const result = await client.query({
    name: 'platform-operator-change-approval-lock',
    text: `
      SELECT id, security_version, scope_mode
      FROM platform_operators
      WHERE status = 'active'
        AND platform_permissions_for_roles(roles)
          @> ARRAY['platform:operator:manage']::TEXT[]
        AND (
          (id = $1 AND security_version = $2)
          OR (id = $3 AND security_version = $4)
        )
      ORDER BY id
      FOR UPDATE
    `,
    values: [
      record.actorOperatorId,
      record.actorSecurityVersion,
      record.approverOperatorId,
      record.approverSecurityVersion,
    ],
  });
  return result.rowCount === 2 ? result.rows : null;
}

async function approvalPairCoversScope(client, administrators, scopeMode, tenantIds) {
  if (scopeMode === 'all') return administrators.every((entry) => entry.scope_mode === 'all');
  for (const administrator of administrators) {
    if (administrator.scope_mode === 'all' || tenantIds.length === 0) continue;
    const result = await client.query({
      name: 'platform-operator-change-approval-scope',
      text: `
        SELECT count(*)::integer AS count
        FROM platform_operator_tenant_scopes
        WHERE operator_id = $1 AND tenant_id = ANY($2::uuid[])
      `,
      values: [administrator.id, tenantIds],
    });
    if (result.rows[0].count !== tenantIds.length) return false;
  }
  return true;
}

async function loadWithClient(client, operatorId) {
  const operator = await client.query({
    name: 'platform-operator-load-for-change',
    text: `
      SELECT id, status, roles, security_version, scope_mode, provider,
        provider_tenant_reference, provider_subject_reference
      FROM platform_operators
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
    `,
    values: [operatorId],
  });
  if (operator.rowCount !== 1) return null;
  const scopes = await client.query({
    name: 'platform-operator-load-scopes-for-change',
    text: `
      SELECT tenant_id
      FROM platform_operator_tenant_scopes
      WHERE operator_id = $1
      ORDER BY tenant_id
    `,
    values: [operatorId],
  });
  return mapOperator(operator.rows[0], scopes.rows.map((row) => row.tenant_id));
}

async function revokeOperatorAuthority(client, record, targetOperatorId) {
  const sessions = await client.query({
    name: 'platform-operator-change-revoke-sessions',
    text: `
      UPDATE platform_sessions
      SET revoked_at = clock_timestamp()
      WHERE operator_id = $1 AND revoked_at IS NULL
    `,
    values: [targetOperatorId],
  });
  const transactions = await client.query({
    name: 'platform-operator-change-delete-oidc-transactions',
    text: 'DELETE FROM platform_oidc_auth_transactions WHERE expected_operator_id = $1',
    values: [targetOperatorId],
  });
  const grants = await client.query({
    name: 'platform-operator-change-revoke-grants',
    text: `
      UPDATE platform_break_glass_grants
      SET revoked_at = clock_timestamp(),
        revoked_by_operator_id = $2,
        revocation_approver_operator_id = $3,
        revocation_approver_security_version = $4,
        revocation_reason = 'Operator access changed under approved lifecycle procedure',
        revocation_approval_reference = $5
      WHERE (operator_id = $1 OR approver_operator_id = $1)
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING id
    `,
    values: [
      targetOperatorId,
      record.actorOperatorId,
      record.approverOperatorId,
      record.approverSecurityVersion,
      `operator-change:${record.correlationId}`,
    ],
  });
  if (grants.rowCount > 0) {
    await client.query({
      name: 'platform-operator-change-revoked-grant-alerts',
      text: `
        INSERT INTO platform_break_glass_alert_outbox (grant_id, event_type, created_at)
        SELECT grant_id, 'revoked', clock_timestamp()
        FROM unnest($1::uuid[]) AS grant_id
      `,
      values: [grants.rows.map((row) => row.id)],
    });
  }
  return Object.freeze({
    sessionsRevoked: sessions.rowCount,
    transactionsRevoked: transactions.rowCount,
    grantsRevoked: grants.rowCount,
  });
}

async function appendOperatorEvents(client, auditRepository, eventFactory, record, result) {
  const events = requireOperatorEvents(eventFactory(result), record, result.operator.id);
  for (const event of events) await auditRepository.appendWithClient(client, event);
}

async function enqueueChangeAlert(client, operatorId, action, correlationId) {
  await client.query({
    name: 'platform-operator-change-alert-enqueue',
    text: `
      INSERT INTO platform_operator_change_alert_outbox (
        operator_id, change_type, correlation_id, created_at
      ) VALUES ($1, $2, $3, clock_timestamp())
    `,
    values: [operatorId, action, correlationId],
  });
}

export function createPostgresPlatformOperatorRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async findActiveByProviderIdentity({ provider, tenantReference, subjectReference }) {
      const result = await pool.query({
        name: 'platform-operator-find-active-identity',
        text: `
          SELECT id, status, roles, security_version, scope_mode, provider,
            provider_tenant_reference, provider_subject_reference
          FROM platform_operators
          WHERE provider = $1
            AND provider_tenant_reference = $2
            AND provider_subject_reference = $3
            AND status = 'active'
          LIMIT 1
        `,
        values: [provider, tenantReference, subjectReference],
      });
      return mapOperator(result.rows[0]);
    },

    async isTenantAllowed({ operatorId, tenantId, securityVersion, client = pool }) {
      const result = await client.query({
        name: 'platform-operator-target-authorize',
        text: `
          SELECT 1
          FROM platform_operators o
          WHERE o.id = $1
            AND o.status = 'active'
            AND o.security_version = $3
            AND (
              o.scope_mode = 'all'
              OR (o.scope_mode = 'allowlist' AND EXISTS (
                SELECT 1
                FROM platform_operator_tenant_scopes scope
                WHERE scope.operator_id = o.id AND scope.tenant_id = $2
              ))
            )
          LIMIT 1
        `,
        values: [operatorId, tenantId, securityVersion],
      });
      return result.rowCount === 1;
    },

    async loadTargetScope({ operatorId, securityVersion, client = pool }) {
      const result = await client.query({
        name: 'platform-operator-target-scope-reference',
        text: `
          SELECT scope_mode
          FROM platform_operators
          WHERE id = $1 AND status = 'active' AND security_version = $2
          LIMIT 1
        `,
        values: [operatorId, securityVersion],
      });
      if (result.rowCount !== 1) return null;
      return Object.freeze({ mode: result.rows[0].scope_mode, operatorId, securityVersion });
    },

    async createApproved(recordValue, eventFactoryValue) {
      const record = requireApprovalRecord(recordValue, 'create');
      const eventFactory = requireEventFactory(eventFactoryValue);
      return withPostgresTransaction(pool, async (client) => {
        const administrators = await lockApprovalPair(client, record);
        if (!administrators || !await approvalPairCoversScope(
          client, administrators, record.scopeMode, record.tenantIds,
        )) return null;
        const inserted = await client.query({
          name: 'platform-operator-approved-create',
          text: `
            INSERT INTO platform_operators (
              id, provider, provider_tenant_reference, provider_subject_reference,
              status, scope_mode, roles
            ) VALUES ($1, $2, $3, $4, 'active', $5, $6::text[])
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          values: [
            record.id, record.providerIdentity.provider, record.providerIdentity.tenantReference,
            record.providerIdentity.subjectReference, record.scopeMode, record.roles,
          ],
        });
        if (inserted.rowCount !== 1) return null;
        if (record.tenantIds.length > 0) {
          await client.query({
            name: 'platform-operator-approved-create-scopes',
            text: `
              INSERT INTO platform_operator_tenant_scopes (operator_id, tenant_id)
              SELECT $1, tenant_id FROM unnest($2::uuid[]) AS tenant_id
            `,
            values: [record.id, record.tenantIds],
          });
        }
        const operator = await loadWithClient(client, record.id);
        const result = Object.freeze({
          action: 'created', operator, previous: null,
          sessionsRevoked: 0, transactionsRevoked: 0, grantsRevoked: 0,
        });
        await appendOperatorEvents(client, auditRepository, eventFactory, record, result);
        await enqueueChangeAlert(client, record.id, 'created', record.correlationId);
        return result;
      }, { isolationLevel: 'SERIALIZABLE' });
    },

    async changeAccessApproved(recordValue, eventFactoryValue) {
      const record = requireApprovalRecord(recordValue, 'access_changed');
      const eventFactory = requireEventFactory(eventFactoryValue);
      return withPostgresTransaction(pool, async (client) => {
        const administrators = await lockApprovalPair(client, record);
        if (!administrators || !await approvalPairCoversScope(
          client, administrators, record.scopeMode, record.tenantIds,
        )) return null;
        const previous = await loadWithClient(client, record.operatorId);
        if (!previous || previous.status !== 'active'
          || previous.securityVersion !== record.expectedSecurityVersion) return null;
        const sameRoles = JSON.stringify(previous.roles) === JSON.stringify(record.roles);
        const sameScope = previous.scopeMode === record.scopeMode
          && JSON.stringify(previous.tenantIds) === JSON.stringify(record.tenantIds);
        if (sameRoles && sameScope) return null;
        if (!sameRoles || previous.scopeMode !== record.scopeMode) {
          await client.query({
            name: 'platform-operator-approved-access-update',
            text: `
              UPDATE platform_operators
              SET roles = $2::text[], scope_mode = $3
              WHERE id = $1
            `,
            values: [record.operatorId, record.roles, record.scopeMode],
          });
        }
        if (!sameScope) {
          await client.query({
            name: 'platform-operator-approved-scope-delete',
            text: 'DELETE FROM platform_operator_tenant_scopes WHERE operator_id = $1',
            values: [record.operatorId],
          });
          if (record.tenantIds.length > 0) {
            await client.query({
              name: 'platform-operator-approved-scope-insert',
              text: `
                INSERT INTO platform_operator_tenant_scopes (operator_id, tenant_id)
                SELECT $1, tenant_id FROM unnest($2::uuid[]) AS tenant_id
              `,
              values: [record.operatorId, record.tenantIds],
            });
          }
        }
        const revoked = await revokeOperatorAuthority(client, record, record.operatorId);
        const operator = await loadWithClient(client, record.operatorId);
        const result = Object.freeze({ action: 'access_changed', operator, previous, ...revoked });
        await appendOperatorEvents(client, auditRepository, eventFactory, record, result);
        await enqueueChangeAlert(client, record.operatorId, 'access_changed', record.correlationId);
        return result;
      }, { isolationLevel: 'SERIALIZABLE' });
    },

    async disableApproved(recordValue, eventFactoryValue) {
      const record = requireApprovalRecord(recordValue, 'disabled');
      const eventFactory = requireEventFactory(eventFactoryValue);
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockApprovalPair(client, record)) return null;
        const previous = await loadWithClient(client, record.operatorId);
        if (!previous || previous.status !== 'active'
          || previous.securityVersion !== record.expectedSecurityVersion) return null;
        await client.query({
          name: 'platform-operator-approved-disable',
          text: "UPDATE platform_operators SET status = 'disabled' WHERE id = $1",
          values: [record.operatorId],
        });
        const revoked = await revokeOperatorAuthority(client, record, record.operatorId);
        const operator = await loadWithClient(client, record.operatorId);
        const result = Object.freeze({ action: 'disabled', operator, previous, ...revoked });
        await appendOperatorEvents(client, auditRepository, eventFactory, record, result);
        await enqueueChangeAlert(client, record.operatorId, 'disabled', record.correlationId);
        return result;
      }, { isolationLevel: 'SERIALIZABLE' });
    },
  });
}
