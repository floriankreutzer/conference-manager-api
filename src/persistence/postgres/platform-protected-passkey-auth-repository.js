import { createPostgresPlatformPasskeyAuthRepository } from './platform-passkey-auth-repository.js';
import { createPostgresProtectedPasskeyProofRetention } from './platform-protected-passkey-proof-retention.js';

// The optional transaction scope remains owned by the root (shared real work or
// stamped exclusive synthetic work). Retention itself cannot be caller replaced.
export function createPostgresProtectedPlatformPasskeyAuthRepository(pool,configuration={}) {
  const { environment,securityEpoch }=configuration;
  const expiredProofRetention=createPostgresProtectedPasskeyProofRetention(pool,{ environment,securityEpoch });
  return createPostgresPlatformPasskeyAuthRepository(pool,{ ...configuration,expiredProofRetention });
}
