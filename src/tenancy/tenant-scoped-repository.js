import { isInternalUuid } from '../domain/identifiers.js';
import {
  TenantInputError,
  TenantRepositoryContractError,
  TenantUnavailableError,
} from './errors.js';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRED_ADAPTER_METHODS = [
  'findByTenantIdAndId',
  'listByTenantId',
  'insertForTenant',
  'updateByTenantIdAndId',
  'deleteByTenantIdAndId',
];

function tenantIdFrom(context) {
  if (!context || typeof context !== 'object' || !isInternalUuid(context.tenantId)) {
    throw new TenantUnavailableError();
  }
  return context.tenantId;
}

function assertResourceId(resourceId) {
  if (typeof resourceId !== 'string' || !RESOURCE_ID_PATTERN.test(resourceId)) {
    throw new TenantInputError();
  }
}

function mutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantInputError();
  }
  if (Object.hasOwn(value, 'tenantId')) throw new TenantInputError();
  return Object.freeze({ ...value });
}

function assertOwned(resource, tenantId) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new TenantRepositoryContractError();
  }
  if (!isInternalUuid(resource.tenantId) || resource.tenantId !== tenantId) {
    throw new TenantRepositoryContractError();
  }
  return resource;
}

export function createTenantScopedRepository(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('TENANT_ADAPTER_INVALID');
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') throw new TypeError('TENANT_ADAPTER_INVALID');
  }

  return Object.freeze({
    async get(context, resourceId) {
      const tenantId = tenantIdFrom(context);
      assertResourceId(resourceId);
      const resource = await adapter.findByTenantIdAndId(tenantId, resourceId);
      return resource === null || resource === undefined ? null : assertOwned(resource, tenantId);
    },
    async list(context) {
      const tenantId = tenantIdFrom(context);
      const resources = await adapter.listByTenantId(tenantId);
      if (!Array.isArray(resources)) throw new TenantRepositoryContractError();
      return Object.freeze(resources.map((resource) => assertOwned(resource, tenantId)));
    },
    async create(context, value) {
      const tenantId = tenantIdFrom(context);
      const resource = await adapter.insertForTenant(tenantId, mutation(value));
      return assertOwned(resource, tenantId);
    },
    async update(context, resourceId, value) {
      const tenantId = tenantIdFrom(context);
      assertResourceId(resourceId);
      const resource = await adapter.updateByTenantIdAndId(tenantId, resourceId, mutation(value));
      return resource === null || resource === undefined ? null : assertOwned(resource, tenantId);
    },
    async delete(context, resourceId) {
      const tenantId = tenantIdFrom(context);
      assertResourceId(resourceId);
      const deleted = await adapter.deleteByTenantIdAndId(tenantId, resourceId);
      if (deleted !== true && deleted !== false) throw new TenantRepositoryContractError();
      return deleted;
    },
  });
}
