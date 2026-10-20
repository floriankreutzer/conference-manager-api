import { createHash } from 'node:crypto';
import { isInternalUuid,isOpaqueBrowserToken } from './identifiers.js';

export const SYNTHETIC_HANDOFF_OPERATION='synthetic.customer_access.approve';
export const SYNTHETIC_HANDOFF_ROLES=Object.freeze(['employee','conference_manager','tenant_admin']);
export const SYNTHETIC_HANDOFF_SLOTS=Object.freeze(['northwind','contoso','fabrikam']);
export const SYNTHETIC_HANDOFF_START_SECONDS=600;
export const SYNTHETIC_HANDOFF_CODE_SECONDS=60;
export const SYNTHETIC_HANDOFF_COMPLETION_SECONDS=30;
export const SYNTHETIC_HANDOFF_RETAINED_OWNER_LIMIT=512;
export const SYNTHETIC_HANDOFF_RETAINED_GLOBAL_LIMIT=5000;
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/;
function invalid() { throw new TypeError('SYNTHETIC_HANDOFF_INPUT_INVALID'); }
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const fields=Reflect.ownKeys(value);
  if (fields.length!==keys.length || fields.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
function origin(value) {
  try { if (typeof value!=='string' || value.length>253) invalid();
    const parsed=new URL(value);if (parsed.protocol!=='https:' || parsed.origin!==value) invalid();
    return value;
  } catch { invalid(); }
}
export function normalizeSyntheticHandoffScope(value) {
  exact(value,['environment','securityEpoch','platformSecurityEpoch','customerOrigin','platformOrigin']);
  if (!['dev','int'].includes(value.environment) || !Number.isSafeInteger(value.platformSecurityEpoch)
    || value.platformSecurityEpoch<1) invalid();
  const customerOrigin=origin(value.customerOrigin),platformOrigin=origin(value.platformOrigin);
  if (customerOrigin===platformOrigin) invalid();
  return Object.freeze({ environment: value.environment,securityEpoch: uuid(value.securityEpoch),
    platformSecurityEpoch: value.platformSecurityEpoch,customerOrigin,platformOrigin });
}
export function normalizeSyntheticHandoffSelection(value) {
  exact(value,['flowId','operatorId','generationId','slot','role']);
  if (!SYNTHETIC_HANDOFF_SLOTS.includes(value.slot) || !SYNTHETIC_HANDOFF_ROLES.includes(value.role)) invalid();
  return Object.freeze({ flowId: uuid(value.flowId),operatorId: uuid(value.operatorId),
    generationId: uuid(value.generationId),slot: value.slot,role: value.role });
}
export function normalizeSyntheticHandoffIntent(value) {
  exact(value,['flowId','state','operatorId','generationId','slot','role']);
  if (typeof value.state!=='string' || !TOKEN.test(value.state)) invalid();
  const { state,...selection }=value;
  return Object.freeze({ ...normalizeSyntheticHandoffSelection(selection),state });
}
// The binding comes from immutable server custody, never from the browser intent.
// Neither this digest nor a selected role is an authentication grant.
export function syntheticHandoffOperationHash(scope,value,binding) {
  const current=normalizeSyntheticHandoffScope(scope),selection=normalizeSyntheticHandoffSelection(value);
  exact(binding,['flowId','stateHash','browserVerifier']);
  if (uuid(binding.flowId)!==selection.flowId || typeof binding.stateHash!=='string' || !HASH.test(binding.stateHash)
    || typeof binding.browserVerifier!=='string' || !HASH.test(binding.browserVerifier)) invalid();
  return createHash('sha256').update(JSON.stringify({ operation: SYNTHETIC_HANDOFF_OPERATION,...current,...selection,
    stateHash: binding.stateHash,browserVerifier: binding.browserVerifier }),'utf8').digest('hex');
}
export function syntheticDelegationIdentityReference(value) {
  exact(value,['generationId','operatorId','role']);
  if (!SYNTHETIC_HANDOFF_ROLES.includes(value.role)) invalid();
  return `${uuid(value.generationId)}:${uuid(value.operatorId)}:${value.role}`;
}


// One fixed cross-surface redirect contract; neither function grants custody.
export function syntheticHandoffCustomerRedirect(scope,value) {
  const current=normalizeSyntheticHandoffScope(scope);exact(value,['state','code']);
  if (!isOpaqueBrowserToken(value.state) || !isOpaqueBrowserToken(value.code)) invalid();
  const location=new URL('/api/v1/auth/delegation/callback',current.customerOrigin);
  location.searchParams.set('state',value.state);location.searchParams.set('code',value.code);return location.href;
}
export function requireSyntheticHandoffCustomerRedirect(scope,value,state) {
  if (typeof value!=='string' || value.length>512) invalid();
  let location;try { location=new URL(value); } catch { invalid(); }
  const expected=syntheticHandoffCustomerRedirect(scope,{ state,code: location.searchParams.get('code') });
  if (value!==expected) invalid();return expected;
}
