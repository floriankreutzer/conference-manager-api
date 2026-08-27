const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MODES = new Set(['disabled', 'optional', 'required']);

export class TenantCostAllocationInputError extends Error {
  constructor(code = 'TENANT_COST_ALLOCATION_INVALID') {
    super(code);
    this.name = 'TenantCostAllocationInputError';
    this.code = code;
  }
}
function invalid(code) { throw new TenantCostAllocationInputError(code); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('TENANT_COST_ALLOCATION_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid('TENANT_COST_ALLOCATION_INVALID');
  return value;
}
function text(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') invalid('TENANT_COST_ALLOCATION_INVALID');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || CONTROL_CHARACTER.test(normalized)) invalid('TENANT_COST_ALLOCATION_INVALID');
  return normalized;
}
function id(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalid('TENANT_COST_ALLOCATION_INVALID');
  return value;
}
export function normalizeTenantCostAllocation(value) {
  const input = exact(value, ['mode', 'defaultCostCenterId', 'costCenters']);
  if (!MODES.has(input.mode) || !Array.isArray(input.costCenters) || input.costCenters.length > 1000) {
    invalid('TENANT_COST_ALLOCATION_INVALID');
  }
  const seenIds = new Set();
  const seenCodes = new Set();
  const costCenters = input.costCenters.map((entry) => {
    const item = exact(entry, ['id','code','name','description','active','sortOrder']);
    const centerId = id(item.id);
    if (seenIds.has(centerId) || typeof item.code !== 'string' || !SAFE_CODE.test(item.code) || seenCodes.has(item.code)) {
      invalid('TENANT_COST_ALLOCATION_INVALID');
    }
    seenIds.add(centerId); seenCodes.add(item.code);
    if (typeof item.active !== 'boolean' || !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0 || item.sortOrder > 100000) {
      invalid('TENANT_COST_ALLOCATION_INVALID');
    }
    return Object.freeze({
      id: centerId,
      code: item.code,
      name: text(item.name, 160),
      description: text(item.description, 1000, true),
      active: item.active,
      sortOrder: item.sortOrder,
    });
  });
  if (input.defaultCostCenterId !== null && !seenIds.has(input.defaultCostCenterId)) {
    invalid('TENANT_COST_ALLOCATION_REFERENCE_INVALID');
  }
  if (input.mode === 'disabled' && input.defaultCostCenterId !== null) invalid('TENANT_COST_ALLOCATION_INVALID');
  const defaultCenter = costCenters.find((item) => item.id === input.defaultCostCenterId);
  if (defaultCenter && !defaultCenter.active) invalid('TENANT_COST_ALLOCATION_REFERENCE_INVALID');
  return Object.freeze({
    mode: input.mode,
    defaultCostCenterId: input.defaultCostCenterId,
    costCenters: Object.freeze(costCenters),
  });
}
