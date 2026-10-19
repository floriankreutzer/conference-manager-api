import { isInternalUuid } from '../domain/identifiers.js';

const FIELDS = ['membershipId','tenantId','userId','userSecurityVersion','invitationId','invitationRevision'];
function invalid() { throw new TypeError('CUSTOMER_EMAIL_ADMISSION_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function entry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some(key => {
    const property = Object.getOwnPropertyDescriptor(value,key);
    return !FIELDS.includes(key) || !property.enumerable || !Object.hasOwn(property,'value');
  })) invalid();
  const membershipId = uuid(value.membershipId), tenantId = uuid(value.tenantId);
  const pending = value.userId === null;
  if (pending ? value.userSecurityVersion !== null || value.invitationId === null || value.invitationRevision === null
    : value.invitationId !== null || value.invitationRevision !== null) invalid();
  return Object.freeze({ membershipId,tenantId,userId: pending ? null : uuid(value.userId),
    userSecurityVersion: pending ? null : version(value.userSecurityVersion),
    invitationId: pending ? uuid(value.invitationId) : null,invitationRevision: pending ? version(value.invitationRevision) : null });
}

// A captured server-loaded eligibility snapshot is a fence, never authority by
// itself. The admission transaction must load current eligible records under locks.
export function normalizeCustomerEmailAdmissionSnapshot(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100
    || Reflect.ownKeys(value).length !== value.length+1) invalid();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value,String(index));
    if (!property?.enumerable || !Object.hasOwn(property,'value')) invalid();
    result.push(entry(property.value));
  }
  if (new Set(result.map(item => item.membershipId)).size !== result.length
    || new Set(result.map(item => item.tenantId)).size !== result.length) invalid();
  return Object.freeze(result);
}

export function matchesCustomerEmailAdmission({ snapshot, current } = {}) {
  const captured = normalizeCustomerEmailAdmissionSnapshot(snapshot), candidate = entry(current);
  const previous = captured.find(item => item.membershipId === candidate.membershipId);
  return previous !== undefined && FIELDS.every(field => previous[field] === candidate[field]);
}
