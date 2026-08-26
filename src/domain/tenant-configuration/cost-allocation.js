import {
  boundedInteger,
  boundedText,
  exactObject,
  nullableBoundedText,
  requireConfigurationSnapshot,
  safeIdentifier,
  TenantConfigurationInputError,
} from './protocol.js';

const COST_CENTER_LIMIT = 2_000;

export const DEFAULT_COST_ALLOCATION_CONFIGURATION = Object.freeze({
  policy: Object.freeze({
    required: false,
    maximumAllocations: 10,
    defaultCostCenterId: null,
  }),
  costCenters: Object.freeze([]),
});

function retainedIds(current, proposed) {
  const proposedIds = new Set(proposed.map((entry) => entry.id));
  if (current.some((entry) => !proposedIds.has(entry.id))) {
    throw new TenantConfigurationInputError('TENANT_COST_CENTER_ARCHIVE_REQUIRED');
  }
}

export function normalizeCostAllocationConfiguration(value, currentSnapshot = null) {
  exactObject(value, ['policy', 'costCenters']);
  const policy = exactObject(
    value.policy,
    ['required', 'maximumAllocations', 'defaultCostCenterId'],
  );
  if (typeof policy.required !== 'boolean') {
    throw new TenantConfigurationInputError('TENANT_COST_ALLOCATION_POLICY_INVALID');
  }
  if (!Array.isArray(value.costCenters) || value.costCenters.length > COST_CENTER_LIMIT) {
    throw new TenantConfigurationInputError('TENANT_COST_CENTERS_INVALID');
  }
  const ids = new Set();
  const costCenters = Object.freeze(value.costCenters.map((candidate) => {
    const costCenter = exactObject(candidate, ['id', 'name', 'active']);
    const id = safeIdentifier(costCenter.id, 'TENANT_COST_CENTER_ID_INVALID');
    if (ids.has(id)) throw new TenantConfigurationInputError('TENANT_COST_CENTER_ID_DUPLICATE');
    ids.add(id);
    if (typeof costCenter.active !== 'boolean') {
      throw new TenantConfigurationInputError('TENANT_COST_CENTER_ACTIVE_INVALID');
    }
    return Object.freeze({
      id,
      name: boundedText(costCenter.name, {
        minimum: 1,
        maximum: 160,
        code: 'TENANT_COST_CENTER_NAME_INVALID',
      }),
      active: costCenter.active,
    });
  }));
  const defaultCostCenterId = nullableBoundedText(policy.defaultCostCenterId, {
    minimum: 1,
    maximum: 128,
    code: 'TENANT_DEFAULT_COST_CENTER_INVALID',
  });
  if (
    defaultCostCenterId !== null
    && !costCenters.some((entry) => entry.id === defaultCostCenterId && entry.active)
  ) {
    throw new TenantConfigurationInputError('TENANT_DEFAULT_COST_CENTER_INVALID');
  }
  if (policy.required && costCenters.every((entry) => !entry.active)) {
    throw new TenantConfigurationInputError('TENANT_ACTIVE_COST_CENTER_REQUIRED');
  }
  if (currentSnapshot?.costCenters) retainedIds(currentSnapshot.costCenters, costCenters);
  return requireConfigurationSnapshot({
    policy: {
      required: policy.required,
      maximumAllocations: boundedInteger(policy.maximumAllocations, {
        minimum: 1,
        maximum: 10,
        code: 'TENANT_COST_ALLOCATION_LIMIT_INVALID',
      }),
      defaultCostCenterId,
    },
    costCenters,
  });
}
