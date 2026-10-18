import { PlatformHttpError } from '../../src/platform/http/errors.js';
import { serializeClearedPlatformEntraTransactionCookie } from '../../src/platform/identity/entra-transaction-cookie.js';

// Explicit unavailable identity boundary for the synthetic target only. It never
// accepts an identity, issues a session, persists an OIDC flow or contacts a provider.
// Normal session/principal/role/CSRF handlers stay in the canonical composition.
export function createLoadPlatformAuthentication() {
  async function unavailable() { throw new PlatformHttpError(503, 'PLATFORM_IDENTITY_UNAVAILABLE'); }
  return Object.freeze({ start: unavailable, complete: unavailable, clearCookie: serializeClearedPlatformEntraTransactionCookie });
}
