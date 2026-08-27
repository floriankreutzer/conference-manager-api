const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COST_CENTER_CODE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TEXT_MAX = 160;
const COST_CENTER_LIMIT = 1_000;
const ALLOCATION_ENTRY_LIMIT = 100;

export const TOTAL_ALLOCATION_BASIS_POINTS = 10_000;

export class TenantCostAllocationInputError extends Error {
  constructor(code = 'TENANT_COST_ALLOCATION_INVALID') {
    super(code);
    this.name = 'TenantCostAllocationInputError';
    this.code = code;
  }
}

function inputError(code) {
  throw new TenantCostAllocationInputError(code);
}

function exactObject(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    inputError('TENANT_COST_ALLOCATION_INVALID');
  }
  const allowed = new Set(required);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    inputError('TENANT_COST_ALLOCATION_INVALID');
  }
  return value;
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) inputError(code);
  return value;
}

function boundedText(value, code, maximum = TEXT_MAX) {
  if (typeof value !== 'string') inputError(code);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    inputError(code);
  }
  return normalized;
}

function nullableText(value, code) {
  return value === null ? null : boundedText(value, code);
}

function costCenterCode(value) {
  if (typeof value !== 'string' || !COST_CENTER_CODE.test(value)) {
    inputError('TENANT_COST_CENTER_CODE_INVALID');
  }
  return value;
}

function normalizeCostCenter(value) {
  const costCenter = exactObject(value, [
    'id',
    'code',
    'name',
    'group',
    'active',
  ]);
  if (typeof costCenter.active !== 'boolean') {
    inputError('TENANT_COST_CENTER_ACTIVE_INVALID');
  }
  return Object.freeze({
    id: safeId(costCenter.id, 'TENANT_COST_CENTER_ID_INVALID'),
    code: costCenterCode(costCenter.code),
    name: boundedText(costCenter.name, 'TENANT_COST_CENTER_NAME_INVALID'),
    group: nullableText(costCenter.group, 'TENANT_COST_CENTER_GROUP_INVALID'),
    active: costCenter.active,
  });
}

export function normalizeTenantCostAllocation(value) {
  const root = exactObject(value, ['allocationRequired', 'costCenters']);
  if (typeof root.allocationRequired !== 'boolean') {
    inputError('TENANT_COST_ALLOCATION_REQUIRED_INVALID');
  }
  if (
    !Array.isArray(root.costCenters)
    || root.costCenters.length > COST_CENTER_LIMIT
  ) {
    inputError('TENANT_COST_CENTERS_INVALID');
  }
  const costCenters = root.costCenters.map(normalizeCostCenter);
  if (new Set(costCenters.map((entry) => entry.id)).size !== costCenters.length) {
    inputError('TENANT_COST_CENTER_ID_DUPLICATE');
  }
  if (new Set(costCenters.map((entry) => entry.code)).size !== costCenters.length) {
    inputError('TENANT_COST_CENTER_CODE_DUPLICATE');
  }
  costCenters.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    allocationRequired: root.allocationRequired,
    costCenters: Object.freeze(costCenters),
  });
}

export const DEFAULT_TENANT_COST_ALLOCATION = normalizeTenantCostAllocation({
  allocationRequired: false,
  costCenters: [],
});

export function assertTenantCostAllocationTransition(currentValue, proposedValue) {
  const current = normalizeTenantCostAllocation(currentValue);
  const proposed = normalizeTenantCostAllocation(proposedValue);
  const proposedIds = new Set(proposed.costCenters.map((entry) => entry.id));
  if (current.costCenters.some((entry) => !proposedIds.has(entry.id))) {
    inputError('TENANT_COST_CENTER_ARCHIVE_REQUIRED');
  }
  return proposed;
}

function normalizeAllocationEntry(value) {
  const entry = exactObject(value, [
    'costCenterId',
    'percentageBasisPoints',
  ]);
  if (
    !Number.isSafeInteger(entry.percentageBasisPoints)
    || entry.percentageBasisPoints < 1
    || entry.percentageBasisPoints > TOTAL_ALLOCATION_BASIS_POINTS
  ) {
    inputError('TENANT_COST_ALLOCATION_PERCENTAGE_INVALID');
  }
  return Object.freeze({
    costCenterId: safeId(
      entry.costCenterId,
      'TENANT_COST_ALLOCATION_COST_CENTER_INVALID',
    ),
    percentageBasisPoints: entry.percentageBasisPoints,
  });
}

export function normalizeTenantCostAllocationEntries(value, configurationValue) {
  const configuration = normalizeTenantCostAllocation(configurationValue);
  if (!Array.isArray(value) || value.length > ALLOCATION_ENTRY_LIMIT) {
    inputError('TENANT_COST_ALLOCATION_ENTRIES_INVALID');
  }
  const entries = value.map(normalizeAllocationEntry);
  if (new Set(entries.map((entry) => entry.costCenterId)).size !== entries.length) {
    inputError('TENANT_COST_ALLOCATION_COST_CENTER_DUPLICATE');
  }
  if (entries.length === 0) {
    if (configuration.allocationRequired) {
      inputError('TENANT_COST_ALLOCATION_REQUIRED');
    }
    return Object.freeze([]);
  }
  const total = entries.reduce(
    (sum, entry) => sum + entry.percentageBasisPoints,
    0,
  );
  if (total !== TOTAL_ALLOCATION_BASIS_POINTS) {
    inputError('TENANT_COST_ALLOCATION_TOTAL_INVALID');
  }
  const centers = new Map(
    configuration.costCenters.map((entry) => [entry.id, entry]),
  );
  for (const entry of entries) {
    const center = centers.get(entry.costCenterId);
    if (!center || !center.active) {
      inputError('TENANT_COST_ALLOCATION_COST_CENTER_UNAVAILABLE');
    }
  }
  return Object.freeze(entries);
}

function money(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) inputError(code);
  return value;
}

function currency(value) {
  if (typeof value !== 'string' || !CURRENCY.test(value)) {
    inputError('TENANT_COST_ALLOCATION_CURRENCY_INVALID');
  }
  return value;
}

function allocatedMinorValues(entries, totalMinor) {
  if (entries.length === 0) return [];
  const denominator = BigInt(TOTAL_ALLOCATION_BASIS_POINTS);
  const total = BigInt(totalMinor);
  const working = entries.map((entry, index) => {
    const product = total * BigInt(entry.percentageBasisPoints);
    return {
      index,
      costCenterId: entry.costCenterId,
      allocated: product / denominator,
      remainder: product % denominator,
    };
  });
  const allocated = working.reduce((sum, entry) => sum + entry.allocated, 0n);
  const remainder = total - allocated;
  const order = [...working].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return left.costCenterId.localeCompare(right.costCenterId);
  });
  for (let index = 0; index < Number(remainder); index += 1) {
    order[index].allocated += 1n;
  }
  const result = Array(entries.length);
  for (const entry of working) result[entry.index] = Number(entry.allocated);
  return result;
}

export function createTenantCostAllocationSnapshot(
  configurationValue,
  { entries: entryValues, totalMinor: totalValue, currency: currencyValue } = {},
) {
  const configuration = normalizeTenantCostAllocation(configurationValue);
  const entries = normalizeTenantCostAllocationEntries(
    entryValues,
    configuration,
  );
  const totalMinor = money(totalValue, 'TENANT_COST_ALLOCATION_TOTAL_MINOR_INVALID');
  const normalizedCurrency = currency(currencyValue);
  const centers = new Map(
    configuration.costCenters.map((entry) => [entry.id, entry]),
  );
  const allocatedValues = allocatedMinorValues(entries, totalMinor);
  const snapshots = entries.map((entry, index) => {
    const center = centers.get(entry.costCenterId);
    return Object.freeze({
      costCenterId: center.id,
      code: center.code,
      name: center.name,
      group: center.group,
      percentageBasisPoints: entry.percentageBasisPoints,
      allocatedMinor: allocatedValues[index],
    });
  });
  const allocatedMinor = allocatedValues.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    model: 'percentage_basis_points',
    totalBasisPoints: entries.length === 0 ? 0 : TOTAL_ALLOCATION_BASIS_POINTS,
    totalMinor,
    allocatedMinor,
    unallocatedMinor: totalMinor - allocatedMinor,
    currency: normalizedCurrency,
    entries: Object.freeze(snapshots),
  });
}
