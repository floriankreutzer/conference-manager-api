import { isInternalUuid } from '../domain/identifiers.js';
const FIELDS=['membershipId','tenantId','userId','userSecurityVersion'];
const invalid=()=>{ throw new TypeError('CUSTOMER_MICROSOFT_ADMISSION_INVALID'); };
function entry(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const keys=Reflect.ownKeys(value);
  if (keys.length!==FIELDS.length || keys.some(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    return !FIELDS.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  })) invalid();
  if (!['membershipId','tenantId','userId'].every(key=>isInternalUuid(value[key]))
    || !Number.isSafeInteger(value.userSecurityVersion) || value.userSecurityVersion<1
    || value.userSecurityVersion>=Number.MAX_SAFE_INTEGER) invalid();
  return Object.freeze({ membershipId: value.membershipId.toLowerCase(),tenantId: value.tenantId.toLowerCase(),
    userId: value.userId.toLowerCase(),userSecurityVersion: value.userSecurityVersion });
}
export function normalizeCustomerMicrosoftAdmissionSnapshot(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>100
    || Reflect.ownKeys(value).length!==value.length+1) invalid();
  const rows=[];
  for (let index=0;index<value.length;index++) {
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) invalid();rows.push(entry(descriptor.value));
  }
  if (new Set(rows.map(row=>row.membershipId)).size!==rows.length || new Set(rows.map(row=>row.tenantId)).size!==rows.length) invalid();
  return Object.freeze(rows);
}
export function matchesCustomerMicrosoftAdmission({ snapshot,current }={}) {
  const rows=normalizeCustomerMicrosoftAdmissionSnapshot(snapshot),candidate=entry(current);
  return rows.some(row=>FIELDS.every(key=>row[key]===candidate[key]));
}
