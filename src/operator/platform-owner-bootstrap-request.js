import { isInternalUuid } from '../domain/identifiers.js';

function refuse() { throw new Error('PLATFORM_OWNER_BOOTSTRAP_REQUEST_INVALID'); }
function exact(value,keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field=>!Object.hasOwn(field,'value'))) refuse();
}

// Administrative input only; no email/display-name inference or browser authority.
export function normalizePlatformOwnerBootstrapRequest(value,expected) {
  exact(value,['environment','deploymentEpoch','directoryId','subjectId','approvalReference','correlationId']);
  exact(expected,['environment','deploymentEpoch','directoryId','subjectId']);
  if (expected.environment!=='int' || value.environment!==expected.environment
    || !['deploymentEpoch','directoryId','subjectId'].every(key=>isInternalUuid(value[key])
      && isInternalUuid(expected[key]) && value[key]===expected[key])
    || !isInternalUuid(value.correlationId) || typeof value.approvalReference!=='string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value.approvalReference)) refuse();
  return Object.freeze({ ...value });
}

// This separate, one-time upgrade never replays first-owner initialization.
export function normalizePlatformOwnerRolesRequest(value,expected) {
  exact(value,['environment','deploymentEpoch','directoryId','subjectId','approvalReference','correlationId','expectedSecurityVersion']);
  const { expectedSecurityVersion,...bootstrap }=value;
  if (!Number.isSafeInteger(expectedSecurityVersion) || expectedSecurityVersion<1) refuse();
  return Object.freeze({ ...normalizePlatformOwnerBootstrapRequest(bootstrap,expected),expectedSecurityVersion });
}
