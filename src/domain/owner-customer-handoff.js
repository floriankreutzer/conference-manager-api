import { createHash } from 'node:crypto';
import { isInternalUuid,isOpaqueBrowserToken } from './identifiers.js';

export const OWNER_CUSTOMER_ACCESS_OPERATION='owner.customer_access.approve';
export const OWNER_CUSTOMER_ACCESS_PROVIDER='platform_owner';
export const OWNER_CUSTOMER_ACCESS_ROLES=Object.freeze(['employee','conference_manager','tenant_admin']);
export const OWNER_CUSTOMER_ACCESS_START_SECONDS=600;
export const OWNER_CUSTOMER_ACCESS_CODE_SECONDS=60;
export const OWNER_CUSTOMER_ACCESS_COMPLETION_SECONDS=30;
const HASH=/^[a-f0-9]{64}$/;
function invalid() { throw new TypeError('OWNER_CUSTOMER_ACCESS_INPUT_INVALID'); }
function exact(value,keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const fields=Reflect.ownKeys(value);
  if (fields.length!==keys.length || fields.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
function origin(value) {
  try {
    if (typeof value!=='string' || value.length>253) invalid();
    const parsed=new URL(value);if (parsed.protocol!=='https:' || parsed.origin!==value) invalid();return value;
  } catch { invalid(); }
}
export function normalizeOwnerCustomerAccessScope(value) {
  exact(value,['environment','securityEpoch','platformSecurityEpoch','customerOrigin','platformOrigin']);
  if (!['dev','int','prod'].includes(value.environment) || !Number.isSafeInteger(value.platformSecurityEpoch)
    || value.platformSecurityEpoch<1) invalid();
  const customerOrigin=origin(value.customerOrigin),platformOrigin=origin(value.platformOrigin);
  if (customerOrigin===platformOrigin) invalid();
  return Object.freeze({ environment: value.environment,securityEpoch: uuid(value.securityEpoch),
    platformSecurityEpoch: value.platformSecurityEpoch,customerOrigin,platformOrigin });
}
export function normalizeOwnerCustomerAccessSelection(value) {
  exact(value,['flowId','operatorId','tenantId','role']);
  if (!OWNER_CUSTOMER_ACCESS_ROLES.includes(value.role)) invalid();
  return Object.freeze({ flowId: uuid(value.flowId),operatorId: uuid(value.operatorId),tenantId: uuid(value.tenantId),role: value.role });
}
export function normalizeOwnerCustomerAccessIntent(value) {
  exact(value,['flowId','state','operatorId','tenantId','role']);
  if (!isOpaqueBrowserToken(value.state)) invalid();
  const { state,...selection }=value;return Object.freeze({ ...normalizeOwnerCustomerAccessSelection(selection),state });
}
// The digest binds the server's pending original-browser custody to its exact
// selected REAL target. It creates no owner, identity, role, session or proof.
export function ownerCustomerAccessOperationHash(scope,value,binding) {
  const current=normalizeOwnerCustomerAccessScope(scope),selection=normalizeOwnerCustomerAccessSelection(value);
  exact(binding,['flowId','stateHash','browserVerifier']);
  if (uuid(binding.flowId)!==selection.flowId || typeof binding.stateHash!=='string' || !HASH.test(binding.stateHash)
    || typeof binding.browserVerifier!=='string' || !HASH.test(binding.browserVerifier)) invalid();
  return createHash('sha256').update(JSON.stringify({ operation: OWNER_CUSTOMER_ACCESS_OPERATION,...current,...selection,
    stateHash: binding.stateHash,browserVerifier: binding.browserVerifier }),'utf8').digest('hex');
}
// Stable own Customer identity across role switches. This predictable internal
// identifier is not a bearer credential and never authorizes row adoption.
export function ownerCustomerUserId(value) {
  exact(value,['environment','operatorId','tenantId']);
  if (!['dev','int','prod'].includes(value.environment)) invalid();
  const operatorId=uuid(value.operatorId),tenantId=uuid(value.tenantId);
  const bytes=createHash('sha256').update(`owner-customer-user:v1:${value.environment}:${tenantId}:${operatorId}`,'utf8').digest();
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
export function ownerCustomerAccessIdentityReference(value) {
  exact(value,['flowId','operatorId','role']);
  if (!OWNER_CUSTOMER_ACCESS_ROLES.includes(value.role)) invalid();
  return `${uuid(value.flowId)}:${uuid(value.operatorId)}:${value.role}`;
}
export function ownerCustomerAccessRedirect(scope,value) {
  const current=normalizeOwnerCustomerAccessScope(scope);exact(value,['state','code']);
  if (!isOpaqueBrowserToken(value.state) || !isOpaqueBrowserToken(value.code)) invalid();
  const location=new URL('/api/v1/auth/owner/callback',current.customerOrigin);
  location.searchParams.set('state',value.state);location.searchParams.set('code',value.code);return location.href;
}
export function requireOwnerCustomerAccessRedirect(scope,value,state) {
  if (typeof value!=='string' || value.length>512) invalid();
  let location;try { location=new URL(value); } catch { invalid(); }
  const expected=ownerCustomerAccessRedirect(scope,{ state,code: location.searchParams.get('code') });
  if (value!==expected) invalid();return expected;
}
