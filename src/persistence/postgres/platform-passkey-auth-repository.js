import { isInternalUuid } from '../../domain/identifiers.js';
import { permissionsForPlatformRoles } from '../../platform/identity/policy.js';
import { PLATFORM_AUDIT_ACTION, normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';

const ENVIRONMENTS = new Set(['dev', 'int', 'prod']);
const HASH = /^[0-9a-f]{64}$/;

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new TypeError('PLATFORM_PASSKEY_TRANSACTION_INVALID');
  }
}

function bytes(value, length) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').length === length
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function binding(value) {
  if (!isInternalUuid(value.operatorId) || !ENVIRONMENTS.has(value.environment)
    || !Number.isSafeInteger(value.securityEpoch) || value.securityEpoch < 1
    || !Number.isSafeInteger(value.operatorSecurityVersion) || value.operatorSecurityVersion < 1
    || !['login', 'step_up'].includes(value.purpose)
    || (value.purpose === 'login' && (value.expectedSessionId !== null || value.operationHash !== null))
    || (value.purpose === 'step_up'
      && (!isInternalUuid(value.expectedSessionId) || !HASH.test(value.operationHash || '')))) {
    throw new TypeError('PLATFORM_PASSKEY_BINDING_INVALID');
  }
}

const BINDING_FIELDS = ['operatorId', 'operatorSecurityVersion', 'environment', 'securityEpoch',
  'purpose', 'expectedSessionId', 'operationHash'];

async function lockAuthority(client, value) {
  const result = await client.query({
    name: 'platform-passkey-operator-lock',
    text: `SELECT id, roles, security_version FROM platform_operators
      WHERE id = $1 AND status = 'active' AND security_version = $2 FOR SHARE`,
    values: [value.operatorId, value.operatorSecurityVersion],
  });
  if (result.rowCount !== 1) return null;
  if (value.purpose === 'step_up') {
    const session = await client.query({
      name: 'platform-passkey-session-lock',
      text: `SELECT id FROM platform_sessions WHERE id = $1 AND operator_id = $2
        AND principal_version = $3 AND security_epoch = $4
        AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
      values: [value.expectedSessionId, value.operatorId, value.operatorSecurityVersion, value.securityEpoch],
    });
    if (session.rowCount !== 1) return null;
  }
  return result.rows[0];
}

function auditEvent(operator, ceremony, verified) {
  return normalizePlatformAuditEvent({
    operatorId: verified ? operator.id : null,
    roles: verified ? operator.roles : [],
    permissions: verified ? permissionsForPlatformRoles(operator.roles) : [],
    assuranceLevel: verified ? (ceremony.purpose === 'step_up' ? 'step_up' : 'mfa') : 'unverified',
    targetTenantId: null,
    action: verified ? PLATFORM_AUDIT_ACTION.AUTHENTICATION_SUCCEEDED : PLATFORM_AUDIT_ACTION.AUTHENTICATION_FAILED,
    targetType: 'platform_passkey_authentication',
    targetId: ceremony.id,
    previousState: null,
    newState: null,
    occurredAt: ceremony.database_time.toISOString(),
    correlationId: ceremony.correlation_id,
    outcome: verified ? 'success' : 'denied',
    metadata: { method: 'application_passkey', purpose: ceremony.purpose },
    retentionClass: 'security',
  });
}

export function createPostgresPlatformPasskeyAuthRepository(pool, { auditRepository, verifier } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  if (typeof verifier?.verifyAuthentication !== 'function') throw new TypeError('PLATFORM_PASSKEY_VERIFIER_REQUIRED');

  return Object.freeze({
    async create(value) {
      exact(value, [...BINDING_FIELDS, 'id', 'stateHash', 'browserHash', 'challenge', 'correlationId', 'ttlSeconds']);
      binding(value);
      if (!isInternalUuid(value.id) || !isInternalUuid(value.correlationId)
        || !HASH.test(value.stateHash || '') || !HASH.test(value.browserHash || '')
        || !bytes(value.challenge, 32) || !Number.isInteger(value.ttlSeconds)
        || value.ttlSeconds < 60 || value.ttlSeconds > 300) throw new TypeError('PLATFORM_PASSKEY_TRANSACTION_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockAuthority(client, value)) return false;
        // Serialize creation for one operator without blocking independent operators.
        await client.query({ name: 'platform-passkey-creation-lock',
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 714533))', values: [value.operatorId] });
        await client.query({ name: 'platform-passkey-expired-cleanup',
          text: 'DELETE FROM platform_passkey_auth_transactions WHERE operator_id = $1 AND expires_at <= clock_timestamp()',
          values: [value.operatorId] });
        const result = await client.query({
          name: 'platform-passkey-auth-create',
          text: `WITH database_time AS (SELECT clock_timestamp() AS now)
            INSERT INTO platform_passkey_auth_transactions
              (id, state_hash, browser_hash, challenge, operator_id, operator_security_version,
               environment, security_epoch, purpose, expected_session_id, operation_hash,
               correlation_id, created_at, expires_at)
            SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now,now + ($13::integer * INTERVAL '1 second')
            FROM database_time WHERE (SELECT count(*) FROM platform_passkey_auth_transactions
              WHERE operator_id = $5 AND expires_at > now) < 5
            RETURNING id`,
          values: [value.id, value.stateHash, value.browserHash, value.challenge, value.operatorId,
            value.operatorSecurityVersion, value.environment, value.securityEpoch, value.purpose,
            value.expectedSessionId, value.operationHash, value.correlationId, value.ttlSeconds],
        });
        return result.rowCount === 1;
      });
    },

    async authenticate(value, onVerified) {
      exact(value, [...BINDING_FIELDS, 'stateHash', 'browserHash', 'response']);
      binding(value);
      if (!HASH.test(value.stateHash || '') || !HASH.test(value.browserHash || '')
        || typeof onVerified !== 'function') throw new TypeError('PLATFORM_PASSKEY_TRANSACTION_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const operator = await lockAuthority(client, value);
        if (!operator) return null;
        const pending = await client.query({
          name: 'platform-passkey-auth-lock',
          text: `SELECT *, clock_timestamp() AS database_time FROM platform_passkey_auth_transactions
            WHERE state_hash = $1 AND browser_hash = $2 AND operator_id = $3
              AND operator_security_version = $4 AND environment = $5 AND security_epoch = $6
              AND purpose = $7 AND expected_session_id IS NOT DISTINCT FROM $8::uuid
              AND operation_hash IS NOT DISTINCT FROM $9::text
              AND consumed_at IS NULL AND attempts < 5 AND expires_at > clock_timestamp() FOR UPDATE`,
          values: [value.stateHash, value.browserHash, value.operatorId, value.operatorSecurityVersion,
            value.environment, value.securityEpoch, value.purpose, value.expectedSessionId, value.operationHash],
        });
        const ceremony = pending.rows[0];
        if (!ceremony) return null;
        await client.query({ name: 'platform-passkey-attempt',
          text: 'UPDATE platform_passkey_auth_transactions SET attempts = attempts + 1 WHERE id = $1',
          values: [ceremony.id] });
        // Only a positively bounded credential ID is allowed to reach SQL. The verifier
        // validates the complete response before it can produce cryptographic evidence.
        const credentialId = value.response?.id;
        let stored;
        if (typeof credentialId === 'string' && credentialId.length <= 1366
          && /^[A-Za-z0-9_-]+$/.test(credentialId)) {
          stored = (await client.query({
            name: 'platform-passkey-credential-lock',
            text: `SELECT * FROM platform_passkey_credentials WHERE operator_id = $1
              AND environment = $2 AND credential_id = $3 AND revoked_at IS NULL FOR UPDATE`,
            values: [value.operatorId, value.environment, credentialId],
          })).rows[0];
        }
        let proof = null;
        if (stored) {
          try {
            proof = await verifier.verifyAuthentication({ response: value.response,
              expectedChallenge: ceremony.challenge, expectedOperatorId: value.operatorId,
              credential: { id: stored.credential_id, publicKey: stored.public_key,
                counter: Number(stored.signature_counter), backupEligible: stored.backup_eligible,
                operatorId: stored.operator_id, environment: stored.environment, userHandle: stored.user_handle } });
          } catch (error) {
            if (error?.code !== 'PLATFORM_PASSKEY_REJECTED') throw error;
          }
        }
        if (!proof) {
          await auditRepository.appendWithClient(client, auditEvent(operator, ceremony, false));
          return null;
        }
        if (proof.credentialId !== stored.credential_id || !Number.isInteger(proof.newCounter)
          || proof.newCounter < 0 || proof.newCounter > 4294967295
          || ((Number(stored.signature_counter) > 0 || proof.newCounter > 0)
            && proof.newCounter <= Number(stored.signature_counter))
          || proof.backupEligible !== stored.backup_eligible || typeof proof.backedUp !== 'boolean'
          || (proof.backedUp && !proof.backupEligible)) throw new Error('PLATFORM_PASSKEY_PROOF_INVALID');
        const consumed = await client.query({ name: 'platform-passkey-auth-consume',
          text: `UPDATE platform_passkey_auth_transactions SET consumed_at = clock_timestamp()
            WHERE id = $1 AND expires_at > clock_timestamp() RETURNING consumed_at`, values: [ceremony.id] });
        if (consumed.rowCount !== 1) return null;
        if (!await lockAuthority(client, value)) throw new Error('PLATFORM_PASSKEY_AUTHORITY_EXPIRED');
        await client.query({ name: 'platform-passkey-counter-update',
          text: `UPDATE platform_passkey_credentials SET signature_counter = $2, backed_up = $3,
            last_used_at = clock_timestamp() WHERE id = $1`, values: [stored.id, proof.newCounter, proof.backedUp] });
        const event = auditEvent(operator, { ...ceremony, database_time: consumed.rows[0].consumed_at }, true);
        await auditRepository.appendWithClient(client, event);
        // Existing session repositories reuse this transaction via AsyncLocalStorage.
        // A failed audit/session write rolls back redemption and counter together.
        const result = await onVerified(Object.freeze({ operatorId: operator.id,
          securityVersion: Number(operator.security_version), purpose: ceremony.purpose,
          expectedSessionId: value.expectedSessionId, operationHash: value.operationHash,
          authenticatedAt: consumed.rows[0].consumed_at.toISOString(), correlationId: ceremony.correlation_id }));
        if (result === null || result === undefined) throw new Error('PLATFORM_PASSKEY_MUTATION_REQUIRED');
        return result;
      });
    },
  });
}
