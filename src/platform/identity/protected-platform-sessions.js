import { createProtectedSessionNamespace } from '../../domain/protected-session-namespace.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { createPlatformSessionService } from './session-service.js';
import { normalizePlatformPrincipal,normalizeTrustedPlatformIdentity } from './principal.js';

function requirePlatformProvider(identity) {
  if (identity.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER) {
    throw new TypeError('PROTECTED_PLATFORM_SESSION_PROVIDER_DENIED');
  }
  return identity;
}

// Only the server composition selects deployment and UUID epoch. The existing
// integer Platform epoch, provider mapping and current operator checks remain
// independent requirements. This factory does not grant a passkey or operation.
export function createProtectedPlatformSessions({ environment,protectedSecurityEpoch,repository,publicOrigin,csrfSecret,
  securityEpoch,sessionTtlSeconds,stepUpTtlSeconds,authenticationMaxAgeSeconds,clock,tokenFactory,idFactory }={}) {
  const securityNamespace=createProtectedSessionNamespace({ environment,securityEpoch: protectedSecurityEpoch });
  const base=createPlatformSessionService({ repository,publicOrigin,csrfSecret,securityEpoch,securityNamespace,
    sessionTtlSeconds,stepUpTtlSeconds,authenticationMaxAgeSeconds,clock,tokenFactory,idFactory });
  return Object.freeze({ ...base,
    issue(identity,options) { return base.issue(requirePlatformProvider(normalizeTrustedPlatformIdentity(identity)),options); },
    rotate(principal,identity,options) {
      return base.rotate(requirePlatformProvider(normalizePlatformPrincipal(principal)),
        requirePlatformProvider(normalizeTrustedPlatformIdentity(identity)),options);
    },
    async resolvePrincipal(request) {
      const principal=await base.resolvePrincipal(request);
      return principal?.providerIdentity.provider===PLATFORM_ENTRA_PROVIDER ? principal : null;
    },
  });
}
