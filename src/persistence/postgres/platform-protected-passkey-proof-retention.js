import { isInternalUuid } from '../../domain/identifiers.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

// All protected passkey instances share this retained-proof rule, including login
// and ordinary real-customer operations. An expired challenge is still evidence
// while a handoff references it; its expiry is not Customer session expiry.
export function createPostgresProtectedPasskeyProofRetention(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_PASSKEY_RETENTION_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  return Object.freeze({
    async deleteExpiredWithClient(client,operatorId) {
      requireProtectedRuntimeSharedExecutionScope(pool,scope);
      if (!isPostgresTransactionActive(pool,client) || !isInternalUuid(operatorId)) {
        throw new TypeError('PROTECTED_PASSKEY_RETENTION_TRANSACTION_REQUIRED');
      }
      return client.query({ name: 'protected-passkey-expired-unreferenced-cleanup',text: `DELETE
        FROM platform_passkey_auth_transactions proof WHERE proof.operator_id=$1 AND proof.expires_at<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM synthetic_customer_handoffs custody WHERE custody.approval_proof_id=proof.id)`,
      values: [operatorId.toLowerCase()] });
    },
  });
}
