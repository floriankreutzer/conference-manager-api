import { isInternalUuid } from '../../src/domain/identifiers.js';

export const PROTECTED_OBSERVATION_ORIGINS = Object.freeze({
  customer: 'https://app.int.pavurel.eu',
  platform: 'https://platform.int.pavurel.eu',
});
export const OBSERVATION_MAX_AGE_MS = 120_000;
export const OBSERVATION_FRONTEND_COMMIT = '29cabd5cfa2e254a3d9960cb8b016f9da956e1f9';
export function refuseRuntimeObservation() { throw new Error('PROTECTED_RUNTIME_OBSERVATION_REFUSED'); }
export function exactObservationObject(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) {
    refuseRuntimeObservation();
  }
}
function instant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) refuseRuntimeObservation();
}

// An approved deployment selection, never an observation or browser mutation.
// Restricted to the reviewed Pavurel INT origins; source preparation is not cutover evidence.
export function normalizeRuntimeObservationSelection(value) {
  exactObservationObject(value, ['environment', 'apiCommit', 'frontendCommit',
    'serviceVersion', 'customer', 'platform', 'evidence']);
  if (value.environment !== 'int'
    || ![value.apiCommit, value.frontendCommit].every(item => typeof item === 'string' && /^[a-f0-9]{40}$/.test(item))
    || value.frontendCommit !== OBSERVATION_FRONTEND_COMMIT
    || typeof value.serviceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.serviceVersion)) {
    refuseRuntimeObservation();
  }
  for (const surface of ['customer', 'platform']) {
    const entry = value[surface];
    exactObservationObject(entry, ['deploymentReference', 'deployedAt', 'frontendSha256']);
    if (typeof entry.deploymentReference !== 'string' || !/^dep-[a-z0-9]{20}$/.test(entry.deploymentReference)
      || typeof entry.frontendSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.frontendSha256)) refuseRuntimeObservation();
    instant(entry.deployedAt);
  }
  if (value.customer.deploymentReference === value.platform.deploymentReference) refuseRuntimeObservation();
  exactObservationObject(value.evidence, ['release', 'change', 'rollback', 'runbook']);
  for (const item of Object.values(value.evidence)) {
    if (item !== null && (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,254}$/.test(item)
      || item.includes('://'))) refuseRuntimeObservation();
  }
  return Object.freeze({ ...value, customer: Object.freeze({ ...value.customer }),
    platform: Object.freeze({ ...value.platform }), evidence: Object.freeze({ ...value.evidence }) });
}

export function normalizeRuntimeObservationPlan(value) {
  exactObservationObject(value, ['environment', 'securityEpoch', 'apiCommit', 'frontendCommit',
    'serviceVersion', 'customer', 'platform', 'evidence']);
  if (!isInternalUuid(value.securityEpoch)) refuseRuntimeObservation();
  const { securityEpoch, ...selection } = value;
  return Object.freeze({ ...normalizeRuntimeObservationSelection(selection), securityEpoch });
}
