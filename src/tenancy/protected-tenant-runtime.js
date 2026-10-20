import { isInternalUuid } from '../domain/identifiers.js';

const ENVIRONMENTS=new Set(['dev','int','prod']);
const SLOTS=new Set(['northwind','contoso','fabrikam']);
const KEYS=['environment','generationId','generationState','mode','operatorId','securityEpoch','slot','tenantId'];

export class ProtectedTenantRuntimeError extends Error {
  constructor() { super('PROTECTED_TENANT_RUNTIME_DENIED');this.name='ProtectedTenantRuntimeError'; }
}

function deny() { throw new ProtectedTenantRuntimeError(); }

// Classification is supplied by the authoritative registry, never a request,
// Microsoft directory, display name or fixture ID. It grants no session/role.
export function requireProtectedTenantRuntime({ environment,tenantId,securityEpoch }={},value) {
  if (!ENVIRONMENTS.has(environment) || !isInternalUuid(tenantId) || !isInternalUuid(securityEpoch)
    || !value || typeof value!=='object'
    || Array.isArray(value) || Object.keys(value).sort().join(',')!==KEYS.join(',')
    || value.environment!==environment || value.tenantId!==tenantId || value.securityEpoch!==securityEpoch) deny();
  if (value.mode==='real') {
    if (['generationId','generationState','operatorId','slot'].some(key=>value[key]!==null)) deny();
  } else if (value.mode==='synthetic') {
    if (environment==='prod' || !isInternalUuid(value.generationId) || !isInternalUuid(value.operatorId)
      || !SLOTS.has(value.slot) || value.generationState!=='active') deny();
  } else deny();
  return Object.freeze({ environment,tenantId,mode: value.mode,securityEpoch: value.securityEpoch,
    generationId: value.generationId,generationState: value.generationState,operatorId: value.operatorId,slot: value.slot });
}

// Each concrete provider adapter fixes its own mode at composition. A synthetic
// Tenant can never reach the real Microsoft365/email/catering branch; missing
// real configuration cannot fall back to a simulated connected provider.
export function requireProtectedTenantMode(context,value,expectedMode) {
  if (expectedMode!=='real' && expectedMode!=='synthetic') deny();
  const runtime=requireProtectedTenantRuntime(context,value);
  if (runtime.mode!==expectedMode) deny();
  return runtime;
}
