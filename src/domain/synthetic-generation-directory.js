import { isInternalUuid } from './identifiers.js';
import { SYNTHETIC_HANDOFF_SLOTS } from './synthetic-handoff.js';
import { SYNTHETIC_GENERATION_RETENTION_LIMIT } from './synthetic-generation-lifecycle.js';
import { TENANT_LIFECYCLE_STATUS } from '../tenancy/tenant-lifecycle-policy.js';

function invalid() { throw new TypeError('SYNTHETIC_GENERATION_DIRECTORY_INVALID'); }
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

// Own synthetic metadata is presentation only. A revision/ID/available bit is
// neither an operation proof nor a Customer/Platform authority grant.
export function normalizeSyntheticGenerationDirectory(value) {
  exact(value,['generation','retainedGenerations','canReplace','replaceAfter']);
  if (!Number.isSafeInteger(value.retainedGenerations) || value.retainedGenerations<0
    || value.retainedGenerations>SYNTHETIC_GENERATION_RETENTION_LIMIT || typeof value.canReplace!=='boolean'
    || value.replaceAfter!==null && (typeof value.replaceAfter!=='string' || !Number.isFinite(Date.parse(value.replaceAfter))
      || new Date(value.replaceAfter).toISOString()!==value.replaceAfter)
    || value.canReplace && (value.replaceAfter!==null || value.retainedGenerations===SYNTHETIC_GENERATION_RETENTION_LIMIT)) invalid();
  let generation=null;
  if (value.generation!==null) {
    if (value.retainedGenerations<1) invalid();
    generation=normalizeSyntheticGenerationSnapshot(value.generation);
  }
  return Object.freeze({ generation,retainedGenerations: value.retainedGenerations,canReplace: value.canReplace,
    replaceAfter: value.replaceAfter });
}


export function normalizeSyntheticGenerationSnapshot(value) {
  const item=value;exact(item,['generationId','revision','available','tenants']);
  if (!Number.isSafeInteger(item.revision) || item.revision<1
    || typeof item.available!=='boolean' || !Array.isArray(item.tenants) || item.tenants.length!==3) invalid();
  const tenants=item.tenants.map((tenant,index)=>{
    exact(tenant,['slot','tenantId','status']);
    if (tenant.slot!==SYNTHETIC_HANDOFF_SLOTS[index] || !Object.values(TENANT_LIFECYCLE_STATUS).includes(tenant.status)) invalid();
    return Object.freeze({ slot: tenant.slot,tenantId: uuid(tenant.tenantId),status: tenant.status });
  });
  if (new Set(tenants.map(tenant=>tenant.tenantId)).size!==3) invalid();
  return Object.freeze({ generationId: uuid(item.generationId),revision: item.revision,available: item.available,
    tenants: Object.freeze(tenants) });
}


export function projectSyntheticGenerationReplacement(value) {
  exact(value,['generationId','revision','tenants']);
  if (!Array.isArray(value.tenants) || value.tenants.length!==3) invalid();
  const tenants=value.tenants.map(tenant=>{
    exact(tenant,['slot','tenantId','displayName','status']);
    if (typeof tenant.displayName!=='string' || tenant.displayName.length<1 || tenant.displayName.length>160
      || /[\u0000-\u001f\u007f]/.test(tenant.displayName)) invalid();
    return { slot: tenant.slot,tenantId: tenant.tenantId,status: tenant.status };
  });
  return normalizeSyntheticGenerationSnapshot({ generationId: value.generationId,revision: value.revision,available: true,tenants });
}
