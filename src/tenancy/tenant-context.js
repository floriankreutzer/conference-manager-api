import { isInternalUuid } from '../domain/identifiers.js';
import {
  isTenantBusinessActive,
  isTenantSessionAvailable,
  normalizeTenant,
} from './tenant.js';
import {
  TenantRepositoryContractError,
  TenantUnavailableError,
} from './errors.js';

function assertPrincipalTenant(principal) {
  if (!principal || typeof principal !== 'object' || !isInternalUuid(principal.tenantId)) {
    throw new TenantUnavailableError();
  }
}

export function createTenantContextGuard({ loadTenant = async () => null } = {}) {
  if (typeof loadTenant !== 'function') throw new TypeError('TENANT_LOADER_INVALID');

  async function resolve(principal) {
    assertPrincipalTenant(principal);
    const rawTenant = await loadTenant(principal.tenantId);
    if (rawTenant === null || rawTenant === undefined) throw new TenantUnavailableError();

    let tenant;
    try {
      tenant = normalizeTenant(rawTenant);
    } catch {
      throw new TenantRepositoryContractError();
    }
    if (tenant.id !== principal.tenantId) throw new TenantRepositoryContractError();

    return Object.freeze({
      tenantId: tenant.id,
      status: tenant.status,
      tenant,
    });
  }

  return Object.freeze({
    async requireKnown(principal) {
      const context = await resolve(principal);
      if (!isTenantSessionAvailable(context.tenant)) throw new TenantUnavailableError();
      return context;
    },
    async requireActive(principal) {
      const context = await resolve(principal);
      if (!isTenantBusinessActive(context.tenant)) throw new TenantUnavailableError();
      return context;
    },
  });
}
