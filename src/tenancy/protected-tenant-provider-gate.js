import { isInternalUuid } from '../domain/identifiers.js';
import { ProtectedTenantRuntimeError,requireProtectedTenantMode } from './protected-tenant-runtime.js';

// A concrete adapter fixes mode at composition. The repository owns the current
// registry/generation locks for the complete callback; a cached preflight read
// cannot implement this port. Provider timeouts remain with the bounded adapter.
export function createProtectedTenantProviderGate({ repository,environment,securityEpoch,mode }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)
    || !['real','synthetic'].includes(mode) || environment==='prod' && mode==='synthetic'
    || typeof repository?.withCurrentTenantRuntime!=='function') {
    throw new TypeError('PROTECTED_PROVIDER_GATE_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async run(tenantId,operation) {
      if (!isInternalUuid(tenantId) || typeof operation!=='function') throw new ProtectedTenantRuntimeError();
      const context=Object.freeze({ environment,securityEpoch,tenantId });let invoked=false;
      return repository.withCurrentTenantRuntime(context,async value=>{
        if (invoked) throw new ProtectedTenantRuntimeError();
        invoked=true;const runtime=requireProtectedTenantMode(context,value,mode);
        return operation(runtime);
      });
    },
  });
}
