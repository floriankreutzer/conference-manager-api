import { isInternalUuid } from '../../domain/identifiers.js';
import {
  createPlatformBreakGlassAuthorizationContext,
  normalizePlatformBreakGlassConsumption,
} from '../../platform/identity/break-glass.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  normalizePlatformAuditEvent,
} from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';

function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapGrant(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    operatorId: row.operator_id,
    approverOperatorId: row.approver_operator_id,
    targetTenantId: row.target_tenant_id,
    permission: row.permission,
    reason: row.reason,
    approvalReference: row.approval_reference,
    issuedAt: instant(row.issued_at),
    expiresAt: instant(row.expires_at),
    consumedAt: row.consumed_at === null ? null : instant(row.consumed_at),
  });
}

function requireEventFactory(value) {
  if (typeof value !== 'function') throw new TypeError('PLATFORM_AUDIT_EVENT_FACTORY_REQUIRED');
  return value;
}

function requireMutation(value) {
  if (typeof value !== 'function') throw new TypeError('PLATFORM_BREAK_GLASS_MUTATION_REQUIRED');
  return value;
}

function requireIssueRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.keys(record).sort().join(',')
      !== [
        'approvalReference',
        'approverOperatorId',
        'approverSecurityVersion',
        'id',
        'operatorId',
        'operatorSecurityVersion',
        'permission',
        'reason',
        'targetTenantId',
        'tokenHash',
        'ttlSeconds',
      ].join(',')
    || !isInternalUuid(record.approverOperatorId)
    || !Number.isSafeInteger(record.approverSecurityVersion)
    || record.approverSecurityVersion < 1
  ) throw new TypeError('PLATFORM_BREAK_GLASS_RECORD_INVALID');
  return record;
}

function requireRevokeRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.keys(record).sort().join(',')
      !== 'approvalReference,approverOperatorId,approverSecurityVersion,grantId,operatorId,operatorSecurityVersion,reason,targetTenantId'
    || !isInternalUuid(record.grantId)
    || !isInternalUuid(record.operatorId)
    || !Number.isSafeInteger(record.operatorSecurityVersion)
    || record.operatorSecurityVersion < 1
    || !isInternalUuid(record.approverOperatorId)
    || !Number.isSafeInteger(record.approverSecurityVersion)
    || record.approverSecurityVersion < 1
    || record.operatorId === record.approverOperatorId
    || !isInternalUuid(record.targetTenantId)
  ) throw new TypeError('PLATFORM_BREAK_GLASS_REVOCATION_INVALID');
  return record;
}

function requireBreakGlassEvent(eventValue, {
  action,
  outcome,
  operatorId,
  targetTenantId,
  targetId,
  assuranceLevel,
  reasonCode,
}) {
  const event = normalizePlatformAuditEvent(eventValue);
  if (
    event.action !== action
    || event.outcome !== outcome
    || event.operatorId !== operatorId
    || event.targetTenantId !== targetTenantId
    || event.targetType !== 'platform_break_glass_grant'
    || event.targetId !== targetId
    || event.assuranceLevel !== assuranceLevel
    || (reasonCode !== undefined && (
      event.metadata.reasonCode !== reasonCode
      || Object.keys(event.metadata).join(',') !== 'reasonCode'
    ))
  ) throw new TypeError('PLATFORM_BREAK_GLASS_AUDIT_EVENT_INVALID');
  return event;
}

export function createPostgresPlatformBreakGlassRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }

  async function consumeWithClient(client, consumption) {
    const result = await client.query({
      name: 'platform-break-glass-consume',
      text: `
        UPDATE platform_break_glass_grants grant_record
        SET consumed_at = clock_timestamp()
        FROM platform_operators operator, platform_operators approver
        WHERE grant_record.token_hash = $1
          AND grant_record.operator_id = $2
          AND grant_record.operator_security_version = $3
          AND grant_record.target_tenant_id = $4
          AND grant_record.permission = $5
          AND grant_record.consumed_at IS NULL
          AND grant_record.revoked_at IS NULL
          AND grant_record.expires_at > clock_timestamp()
          AND operator.id = grant_record.operator_id
          AND operator.status = 'active'
          AND operator.security_version = grant_record.operator_security_version
          AND operator.security_version = $3
          AND (
            operator.scope_mode = 'all'
            OR EXISTS (
              SELECT 1
              FROM platform_operator_tenant_scopes scope
              WHERE scope.operator_id = operator.id
                AND scope.tenant_id = grant_record.target_tenant_id
            )
          )
          AND approver.id = grant_record.approver_operator_id
          AND approver.id <> operator.id
          AND approver.status = 'active'
          AND approver.security_version = grant_record.approver_security_version
          AND platform_permissions_for_roles(approver.roles)
            @> ARRAY['platform:break-glass:manage']::TEXT[]
          AND (
            approver.scope_mode = 'all'
            OR EXISTS (
              SELECT 1
              FROM platform_operator_tenant_scopes approver_scope
              WHERE approver_scope.operator_id = approver.id
                AND approver_scope.tenant_id = grant_record.target_tenant_id
            )
          )
        RETURNING grant_record.id, grant_record.operator_id,
          grant_record.approver_operator_id, grant_record.target_tenant_id,
          grant_record.permission, grant_record.reason, grant_record.approval_reference,
          grant_record.issued_at, grant_record.expires_at, grant_record.consumed_at
      `,
      values: [
        consumption.tokenHash,
        consumption.operatorId,
        consumption.operatorSecurityVersion,
        consumption.targetTenantId,
        consumption.permission,
      ],
    });
    return result.rowCount === 1 ? mapGrant(result.rows[0]) : null;
  }

  return Object.freeze({
    async issue(recordValue, eventFactoryValue) {
      const record = requireIssueRecord(recordValue);
      const eventFactory = requireEventFactory(eventFactoryValue);
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-break-glass-issue',
          text: `
            WITH database_time AS (SELECT clock_timestamp() AS issued_at)
            INSERT INTO platform_break_glass_grants (
              id, token_hash, operator_id, operator_security_version,
              approver_operator_id, approver_security_version,
              target_tenant_id, permission, reason,
              approval_reference, issued_at, expires_at
            )
            SELECT $1, $2, operator.id, operator.security_version, approver.id,
              approver.security_version, $7, $8, $9, $10, database_time.issued_at,
              database_time.issued_at + ($11::integer * INTERVAL '1 second')
            FROM database_time
            JOIN platform_operators operator
              ON operator.id = $3
              AND operator.status = 'active'
              AND operator.security_version = $4
              AND platform_permissions_for_roles(operator.roles)
                @> ARRAY['platform:break-glass:manage']::TEXT[]
              AND (
                operator.scope_mode = 'all'
                OR EXISTS (
                  SELECT 1
                  FROM platform_operator_tenant_scopes scope
                  WHERE scope.operator_id = operator.id AND scope.tenant_id = $7
                )
              )
            JOIN platform_operators approver
              ON approver.id = $5
              AND approver.id <> operator.id
              AND approver.status = 'active'
              AND approver.security_version = $6
              AND platform_permissions_for_roles(approver.roles)
                @> ARRAY['platform:break-glass:manage']::TEXT[]
              AND (
                approver.scope_mode = 'all'
                OR EXISTS (
                  SELECT 1
                  FROM platform_operator_tenant_scopes approver_scope
                  WHERE approver_scope.operator_id = approver.id
                    AND approver_scope.tenant_id = $7
                )
              )
            RETURNING id, operator_id, approver_operator_id, target_tenant_id,
              permission, reason, approval_reference, issued_at, expires_at, consumed_at
          `,
          values: [
            record.id,
            record.tokenHash,
            record.operatorId,
            record.operatorSecurityVersion,
            record.approverOperatorId,
            record.approverSecurityVersion,
            record.targetTenantId,
            record.permission,
            record.reason,
            record.approvalReference,
            record.ttlSeconds,
          ],
        });
        if (result.rowCount !== 1) return null;
        const grant = mapGrant(result.rows[0]);
        const event = requireBreakGlassEvent(eventFactory(grant), {
          action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_GRANTED,
          outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
          operatorId: record.operatorId,
          targetTenantId: grant.targetTenantId,
          targetId: grant.id,
          assuranceLevel: 'step_up',
        });
        await auditRepository.appendWithClient(client, event, {
          expectedTargetTenantId: grant.targetTenantId,
        });
        await client.query({
          name: 'platform-break-glass-issued-alert-enqueue',
          text: `
            INSERT INTO platform_break_glass_alert_outbox (grant_id, event_type, created_at)
            VALUES ($1, 'issued', clock_timestamp())
          `,
          values: [grant.id],
        });
        return grant;
      }, { isolationLevel: 'SERIALIZABLE' });
    },

    async revoke(recordValue, eventFactoryValue) {
      const record = requireRevokeRecord(recordValue);
      const eventFactory = requireEventFactory(eventFactoryValue);
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-break-glass-revoke',
          text: `
            UPDATE platform_break_glass_grants grant_record
            SET revoked_at = clock_timestamp(),
              revoked_by_operator_id = operator.id,
              revocation_approver_operator_id = approver.id,
              revocation_approver_security_version = approver.security_version,
              revocation_reason = $7,
              revocation_approval_reference = $8
            FROM platform_operators operator, platform_operators approver
            WHERE grant_record.id = $1
              AND grant_record.target_tenant_id = $2
              AND grant_record.consumed_at IS NULL
              AND grant_record.revoked_at IS NULL
              AND operator.id = $3
              AND operator.status = 'active'
              AND operator.security_version = $4
              AND platform_permissions_for_roles(operator.roles)
                @> ARRAY['platform:break-glass:manage']::TEXT[]
              AND (
                operator.scope_mode = 'all'
                OR EXISTS (
                  SELECT 1
                  FROM platform_operator_tenant_scopes scope
                  WHERE scope.operator_id = operator.id
                    AND scope.tenant_id = grant_record.target_tenant_id
                )
              )
              AND approver.id = $5
              AND approver.id <> operator.id
              AND approver.status = 'active'
              AND approver.security_version = $6
              AND platform_permissions_for_roles(approver.roles)
                @> ARRAY['platform:break-glass:manage']::TEXT[]
              AND (
                approver.scope_mode = 'all'
                OR EXISTS (
                  SELECT 1
                  FROM platform_operator_tenant_scopes approver_scope
                  WHERE approver_scope.operator_id = approver.id
                    AND approver_scope.tenant_id = grant_record.target_tenant_id
                )
              )
            RETURNING grant_record.id, grant_record.operator_id,
              grant_record.approver_operator_id, grant_record.target_tenant_id,
              grant_record.permission, grant_record.reason, grant_record.approval_reference,
              grant_record.issued_at, grant_record.expires_at, grant_record.consumed_at
          `,
          values: [
            record.grantId,
            record.targetTenantId,
            record.operatorId,
            record.operatorSecurityVersion,
            record.approverOperatorId,
            record.approverSecurityVersion,
            record.reason,
            record.approvalReference,
          ],
        });
        if (result.rowCount !== 1) return null;
        const grant = mapGrant(result.rows[0]);
        const event = requireBreakGlassEvent(eventFactory(grant), {
          action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_REVOKED,
          outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
          operatorId: record.operatorId,
          targetTenantId: grant.targetTenantId,
          targetId: grant.id,
          assuranceLevel: 'step_up',
        });
        await auditRepository.appendWithClient(client, event, {
          expectedTargetTenantId: grant.targetTenantId,
        });
        await client.query({
          name: 'platform-break-glass-revoked-alert-enqueue',
          text: `
            INSERT INTO platform_break_glass_alert_outbox (grant_id, event_type, created_at)
            VALUES ($1, 'revoked', clock_timestamp())
          `,
          values: [grant.id],
        });
        return grant;
      }, { isolationLevel: 'SERIALIZABLE' });
    },

    async executeAuthorizedMutation({
      consumption: consumptionValue,
      eventFactory: eventFactoryValue,
      deniedEventFactory: deniedEventFactoryValue,
      mutation: mutationValue,
    } = {}) {
      const consumption = normalizePlatformBreakGlassConsumption(consumptionValue);
      const eventFactory = requireEventFactory(eventFactoryValue);
      const deniedEventFactory = requireEventFactory(deniedEventFactoryValue);
      const mutation = requireMutation(mutationValue);
      return withPostgresTransaction(pool, async (client) => {
        const grant = await consumeWithClient(client, consumption);
        if (!grant) {
          const denial = requireBreakGlassEvent(deniedEventFactory(), {
            action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_DENIED,
            outcome: PLATFORM_AUDIT_OUTCOME.DENIED,
            operatorId: consumption.operatorId,
            targetTenantId: consumption.targetTenantId,
            targetId: 'attempt',
            assuranceLevel: 'step_up',
            reasonCode: 'grant_rejected',
          });
          await auditRepository.appendWithClient(client, denial, {
            expectedTargetTenantId: consumption.targetTenantId,
          });
          await client.query({
            name: 'platform-break-glass-denied-alert-enqueue',
            text: `
              INSERT INTO platform_security_alert_outbox (
                event_type, operator_id, target_tenant_id, correlation_id,
                reason_code, created_at
              )
              VALUES ('break_glass_denied', $1, $2, $3, 'grant_rejected', clock_timestamp())
            `,
            values: [
              consumption.operatorId,
              consumption.targetTenantId,
              denial.correlationId,
            ],
          });
          return null;
        }
        const authorization = createPlatformBreakGlassAuthorizationContext(grant);
        const result = await mutation(Object.freeze({ client, authorization }));
        const event = requireBreakGlassEvent(eventFactory(grant), {
          action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_USED,
          outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
          operatorId: consumption.operatorId,
          targetTenantId: grant.targetTenantId,
          targetId: grant.id,
          assuranceLevel: 'break_glass',
        });
        await auditRepository.appendWithClient(client, event, {
          expectedTargetTenantId: grant.targetTenantId,
        });
        await client.query({
          name: 'platform-break-glass-used-alert-enqueue',
          text: `
            INSERT INTO platform_break_glass_alert_outbox (grant_id, event_type, created_at)
            VALUES ($1, 'used', clock_timestamp())
          `,
          values: [grant.id],
        });
        return Object.freeze({ executed: true, result });
      }, { isolationLevel: 'SERIALIZABLE' });
    },
  });
}
