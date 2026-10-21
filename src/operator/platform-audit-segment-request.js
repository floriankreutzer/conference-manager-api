import { isInternalUuid } from '../domain/identifiers.js';

const invalid=()=>{ throw new TypeError('PLATFORM_AUDIT_SEGMENT_REQUEST_INVALID'); };
const FIXED=['environment','segmentId','deploymentEpoch','legacyEventCount','inventoryDigest'];
function own(value,keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length!==keys.length || Reflect.ownKeys(value).some(key=>!keys.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))) invalid();
}

export function normalizePlatformAuditSegmentRequest(value,expected) {
  own(value,[...FIXED,'approvalReference','correlationId']);own(expected,FIXED);
  if (expected.environment!=='int' || !isInternalUuid(expected.segmentId) || !isInternalUuid(expected.deploymentEpoch)
    || !Number.isSafeInteger(expected.legacyEventCount) || expected.legacyEventCount<0 || expected.legacyEventCount>3200
    || typeof expected.inventoryDigest!=='string' || !/^[0-9a-f]{64}$/.test(expected.inventoryDigest)
    || FIXED.some(key=>value[key]!==expected[key]) || !isInternalUuid(value.correlationId)
    || typeof value.approvalReference!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value.approvalReference)) invalid();
  return Object.freeze({ ...value });
}
