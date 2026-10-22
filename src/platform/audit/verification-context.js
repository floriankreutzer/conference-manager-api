import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuditIntegrityError } from './errors.js';

function exact(value,keys) {
  return value && [Object.prototype,null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length===keys.length && Reflect.ownKeys(value).every(key=>keys.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
}

export function projectPlatformAuditVerification(value) {
  if (!exact(value,['legacy','segmentId','verification'])
    || !isInternalUuid(value.segmentId) || value.verification!=='verified' || !value.legacy
    || !exact(value.legacy,['eventCount','verification'])
    || !Number.isSafeInteger(value.legacy.eventCount) || value.legacy.eventCount<0 || value.legacy.eventCount>3200
    || value.legacy.verification!=='unavailable') throw new PlatformAuditIntegrityError();
  return Object.freeze({ segmentId: value.segmentId,verification: 'verified',legacy: Object.freeze({
    eventCount: value.legacy.eventCount,verification: 'unavailable' }) });
}
