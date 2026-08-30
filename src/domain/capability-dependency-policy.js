export class CapabilityDependencyPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CapabilityDependencyPolicyError';
    this.code = code;
  }
}

function fail(code) {
  throw new CapabilityDependencyPolicyError(code);
}

export function requireCapabilityDependencyClosure(entries, descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length < 1) {
    fail('CAPABILITY_DEPENDENCY_CATALOGUE_INVALID');
  }
  const catalogue = new Map();
  for (const descriptor of descriptors) {
    if (
      !descriptor
      || typeof descriptor !== 'object'
      || Array.isArray(descriptor)
      || typeof descriptor.capabilityId !== 'string'
      || !Array.isArray(descriptor.dependencies)
      || catalogue.has(descriptor.capabilityId)
    ) fail('CAPABILITY_DEPENDENCY_CATALOGUE_INVALID');
    catalogue.set(descriptor.capabilityId, descriptor.dependencies);
  }
  if (!Array.isArray(entries) || entries.length > catalogue.size) {
    fail('CAPABILITY_DEPENDENCY_STATE_INVALID');
  }
  const state = new Map();
  for (const entry of entries) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || typeof entry.enabled !== 'boolean'
      || !catalogue.has(entry.capabilityId)
      || state.has(entry.capabilityId)
    ) fail('CAPABILITY_DEPENDENCY_STATE_INVALID');
    state.set(entry.capabilityId, entry.enabled);
  }
  for (const [capabilityId, dependencies] of catalogue) {
    if (state.get(capabilityId) !== true) continue;
    if (dependencies.some((dependency) => state.get(dependency) !== true)) {
      fail('CAPABILITY_DEPENDENCY_MISSING');
    }
  }
  return true;
}
