import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';

export function createProtectedCatalogueMediaService({ repository,authorizationPolicy }={}) {
  if (typeof repository?.list!=='function' || typeof repository?.find!=='function'
    || typeof authorizationPolicy?.requireTenantPermission!=='function') {
    throw new TypeError('PROTECTED_CATALOGUE_MEDIA_SERVICE_CONFIGURATION_INVALID');
  }
  function authorize({ principal,tenantContext }) {
    if (!principal || principal.tenantId!==tenantContext?.tenantId) throw new AuthorizationDeniedError('AUTHORIZATION_DENIED');
    authorizationPolicy.requireTenantPermission(principal,tenantContext,PERMISSION.REQUEST_READ);
    let includeInactive=false;
    try {
      authorizationPolicy.requireTenantPermission(principal,tenantContext,PERMISSION.TENANT_CATALOGUE_MANAGE);
      includeInactive=true;
    } catch (error) { if (!(error instanceof AuthorizationDeniedError)) throw error; }
    return { principal,tenantId: tenantContext.tenantId,includeInactive };
  }
  return Object.freeze({
    list(context) { return repository.list(authorize(context)); },
    find(context,assetId) { return repository.find({ ...authorize(context),assetId }); },
  });
}
