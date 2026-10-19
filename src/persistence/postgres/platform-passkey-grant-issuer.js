import { createPlatformPasskeyEnrollmentGrant } from '../../platform/identity/passkey-enrollment-grant.js';
import { normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';
import { insertPlatformPasskeyEnrollmentGrant } from './platform-passkey-grant-write.js';

const ROLE = /^[a-z][a-z0-9_]{2,62}$/;
function reject() { throw new Error('PLATFORM_PASSKEY_OFFLINE_ISSUANCE_REJECTED'); }

// Offline control-plane port only. It must never be wired into HTTP or either
// Demo composition. The protected connection's actual catalog ownership is the
// independent authority; a Microsoft login, request field or role claim is not.
export function createPostgresPlatformPasskeyGrantIssuer(pool, { auditRepository, expectedOfflineRole } = {}) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  if (!ROLE.test(expectedOfflineRole || '')) throw new TypeError('PLATFORM_PASSKEY_OFFLINE_ROLE_REQUIRED');
  return Object.freeze({
    async issueOffline(value) {
      // Validate the complete closed request before acquiring a connection.
      const checked = createPlatformPasskeyEnrollmentGrant({ ...value, issuedFromSessionId: null });
      if (!['bootstrap', 'recovery'].includes(checked.record.kind) || Object.hasOwn(value, 'issuedFromSessionId')) reject();
      return withPostgresTransaction(pool, async client => {
        const authority = await client.query({ name: 'platform-passkey-offline-catalog-authority',
          text: `SELECT current_user AS active_role, session_user AS authenticated_role,
            pg_get_userbyid(relowner) AS owner_role FROM pg_class
            WHERE oid = 'public.platform_passkey_enrollment_grants'::regclass` });
        const actor = authority.rows[0];
        if (!actor || ['active_role', 'authenticated_role', 'owner_role'].some(name => actor[name] !== expectedOfflineRole)) reject();
        const request = checked.record;
        const operators = await client.query({ name: 'platform-passkey-offline-operator-lock',
          text: `SELECT id,security_version FROM platform_operators
            WHERE id = $1 AND status = 'active' AND security_version = $2 AND provider = $3
              AND lower(provider_tenant_reference) = $4 AND lower(provider_subject_reference) = $5 FOR UPDATE`,
          values: [request.operatorId, request.operatorSecurityVersion, request.providerIdentity.provider,
            request.providerIdentity.tenantReference, request.providerIdentity.subjectReference] });
        if (operators.rowCount !== 1) reject();
        const history = await client.query({ name: 'platform-passkey-offline-history',
          text: `SELECT count(*)::integer AS total FROM platform_passkey_credentials
            WHERE operator_id = $1 AND environment = $2`, values: [request.operatorId, request.environment] });
        if ((request.kind === 'bootstrap') !== (history.rows[0].total === 0)) reject();
        let revokedKeys = 0;
        if (request.kind === 'recovery') {
          const revoked = await client.query({ name: 'platform-passkey-recovery-revoke-keys',
            text: `UPDATE platform_passkey_credentials SET revoked_at = clock_timestamp()
              WHERE operator_id = $1 AND environment = $2 AND revoked_at IS NULL RETURNING id`,
            values: [request.operatorId, request.environment] });
          revokedKeys = revoked.rowCount;
          await client.query({ name: 'platform-passkey-recovery-revoke-sessions',
            text: 'UPDATE platform_sessions SET revoked_at = clock_timestamp() WHERE operator_id = $1 AND revoked_at IS NULL',
            values: [request.operatorId] });
        }
        const revokedGrants = await client.query({ name: 'platform-passkey-offline-revoke-grants',
          text: `UPDATE platform_passkey_enrollment_grants SET revoked_at = clock_timestamp()
            WHERE operator_id = $1 AND environment = $2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
          values: [request.operatorId, request.environment] });
        const current = await client.query({ name: 'platform-passkey-offline-current-version',
          text: 'SELECT security_version FROM platform_operators WHERE id = $1', values: [request.operatorId] });
        const version = Number(current.rows[0]?.security_version) + (request.kind === 'recovery' ? 1 : 0);
        if (!Number.isSafeInteger(version) || version < 1) reject();
        // Recovery issuance adds a final managed version bump in the insert
        // trigger, even when all historical credentials were already revoked.
        const issued = createPlatformPasskeyEnrollmentGrant({ ...value, operatorSecurityVersion: version, issuedFromSessionId: null });
        const record = issued.record;
        const persisted = await insertPlatformPasskeyEnrollmentGrant(client, record, expectedOfflineRole);
        await auditRepository.appendWithClient(client, normalizePlatformAuditEvent({
          operatorId: null, roles: [], permissions: [], assuranceLevel: 'offline_owner',
          targetTenantId: null, action: 'platform.operator.changed', targetType: 'platform_passkey_grant', targetId: record.id,
          previousState: null, newState: { kind: record.kind, environment: record.environment, securityEpoch: record.securityEpoch,
            operatorSecurityVersion: record.operatorSecurityVersion },
          occurredAt: persisted.created_at.toISOString(), correlationId: record.correlationId, outcome: 'success',
          metadata: { operation: 'passkey_grant_issued', approvalReference: record.approvalReference,
            issuerRole: expectedOfflineRole, revokedKeys, revokedGrants: revokedGrants.rowCount }, retentionClass: 'recovery',
        }));
        return Object.freeze({ grant: issued.grant, expiresAt: persisted.expires_at.toISOString(),
          operatorSecurityVersion: record.operatorSecurityVersion });
      });
    },
  });
}
