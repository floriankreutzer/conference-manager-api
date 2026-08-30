import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function hash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new TypeError(code);
  return value;
}

function normalizeTransaction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PLATFORM_OIDC_TRANSACTION_INVALID');
  }
  if (!['login', 'step_up'].includes(value.purpose)) throw new TypeError('PLATFORM_OIDC_PURPOSE_INVALID');
  if (!CONTEXT_PATTERN.test(value.authenticationContext || '')) {
    throw new TypeError('PLATFORM_OIDC_AUTHENTICATION_CONTEXT_INVALID');
  }
  if (!Number.isSafeInteger(value.securityEpoch) || value.securityEpoch < 1) {
    throw new TypeError('PLATFORM_OIDC_SECURITY_EPOCH_INVALID');
  }
  if (!Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 120 || value.ttlSeconds > 600) {
    throw new TypeError('PLATFORM_OIDC_TTL_INVALID');
  }
  if (!isInternalUuid(value.correlationId)) throw new TypeError('PLATFORM_OIDC_CORRELATION_ID_INVALID');
  const stepUpBinding = isInternalUuid(value.expectedOperatorId)
    && isInternalUuid(value.expectedSessionId)
    && Number.isSafeInteger(value.expectedSecurityVersion)
    && value.expectedSecurityVersion >= 1;
  if (value.purpose === 'step_up' && !stepUpBinding) {
    throw new TypeError('PLATFORM_OIDC_STEP_UP_BINDING_INVALID');
  }
  if (
    value.purpose === 'login'
    && [value.expectedOperatorId, value.expectedSessionId, value.expectedSecurityVersion]
      .some((entry) => entry !== null)
  ) throw new TypeError('PLATFORM_OIDC_LOGIN_BINDING_INVALID');
  return Object.freeze({
    stateHash: hash(value.stateHash, 'PLATFORM_OIDC_STATE_HASH_INVALID'),
    nonceHash: hash(value.nonceHash, 'PLATFORM_OIDC_NONCE_HASH_INVALID'),
    purpose: value.purpose,
    expectedOperatorId: value.expectedOperatorId,
    expectedSessionId: value.expectedSessionId,
    expectedSecurityVersion: value.expectedSecurityVersion,
    securityEpoch: value.securityEpoch,
    authenticationContext: value.authenticationContext,
    correlationId: value.correlationId,
    ttlSeconds: value.ttlSeconds,
  });
}

export function createPostgresPlatformOidcTransactionRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  return Object.freeze({
    async create(value) {
      const record = normalizeTransaction(value);
      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          name: 'platform-oidc-delete-expired',
          text: 'DELETE FROM platform_oidc_auth_transactions WHERE expires_at <= clock_timestamp()',
        });
        await client.query({
          name: 'platform-oidc-create',
          text: `
            WITH database_time AS (SELECT clock_timestamp() AS created_at)
            INSERT INTO platform_oidc_auth_transactions (
              state_hash, nonce_hash, purpose, expected_operator_id,
              expected_session_id, expected_security_version, security_epoch,
              authentication_context, correlation_id, created_at, expires_at
            )
            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, database_time.created_at,
              database_time.created_at + ($10::integer * INTERVAL '1 second')
            FROM database_time
          `,
          values: [
            record.stateHash, record.nonceHash, record.purpose, record.expectedOperatorId,
            record.expectedSessionId, record.expectedSecurityVersion, record.securityEpoch,
            record.authenticationContext, record.correlationId, record.ttlSeconds,
          ],
        });
      });
    },

    async consume({ stateHash, securityEpoch }) {
      hash(stateHash, 'PLATFORM_OIDC_STATE_HASH_INVALID');
      if (!Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
        throw new TypeError('PLATFORM_OIDC_SECURITY_EPOCH_INVALID');
      }
      const result = await pool.query({
        name: 'platform-oidc-consume',
        text: `
          DELETE FROM platform_oidc_auth_transactions
          WHERE state_hash = $1
            AND security_epoch = $2
            AND expires_at > clock_timestamp()
          RETURNING nonce_hash, purpose, expected_operator_id, expected_session_id,
            expected_security_version, security_epoch, authentication_context
            , correlation_id
        `,
        values: [stateHash, securityEpoch],
      });
      const row = result.rows[0];
      if (!row) return null;
      if (
        !['login', 'step_up'].includes(row.purpose)
        || !CONTEXT_PATTERN.test(row.authentication_context || '')
        || !isInternalUuid(row.correlation_id)
      ) throw new Error('PLATFORM_OIDC_PERSISTED_TRANSACTION_INVALID');
      return Object.freeze({
        nonceHash: hash(row.nonce_hash, 'PLATFORM_OIDC_NONCE_HASH_INVALID'),
        purpose: row.purpose,
        expectedOperatorId: row.expected_operator_id,
        expectedSessionId: row.expected_session_id,
        expectedSecurityVersion: row.expected_security_version === null
          ? null
          : Number(row.expected_security_version),
        securityEpoch: Number(row.security_epoch),
        authenticationContext: row.authentication_context,
        correlationId: row.correlation_id,
      });
    },
  });
}
