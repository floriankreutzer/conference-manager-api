import { AuthorizationInputError } from './errors.js';
import { TENANT_ROLE } from './policy.js';

const ORDER=Object.freeze([TENANT_ROLE.CONFERENCE_MANAGER,TENANT_ROLE.TENANT_ADMIN]);

// Input is an internal grant projection, never raw provider groups or browser
// authority. Identity-bound mapping and persistence remain adapter responsibilities.
export function normalizeTenantElevatedRoles(value) {
  const invalid=()=>{ throw new AuthorizationInputError('TENANT_USER_ROLES_INVALID'); };
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>ORDER.length) invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.length!==value.length+1 || keys.some(key=>typeof key!=='string'
    || (key!=='length' && !/^[01]$/.test(key)) || !Object.hasOwn(descriptors[key],'value'))) invalid();
  const entries=[];
  for (let index=0;index<value.length;index++) {
    const entry=descriptors[String(index)]?.value;
    if (!ORDER.includes(entry) || entries.includes(entry)) invalid();
    entries.push(entry);
  }
  return Object.freeze(ORDER.filter(role=>entries.includes(role)));
}

export function resolveTenantRoleSources(value) {
  const fields=['directRoles','microsoftGroupRoles'];
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    throw new AuthorizationInputError('TENANT_ROLE_SOURCES_INVALID');
  }
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if (keys.length!==fields.length || keys.some(key=>!fields.includes(key)
    || !Object.hasOwn(descriptors[key],'value'))) throw new AuthorizationInputError('TENANT_ROLE_SOURCES_INVALID');
  const direct=normalizeTenantElevatedRoles(descriptors.directRoles.value);
  const groups=normalizeTenantElevatedRoles(descriptors.microsoftGroupRoles.value);
  return Object.freeze({ directRoles: direct,microsoftGroupRoles: groups,
    effectiveRoles: Object.freeze(ORDER.filter(role=>direct.includes(role) || groups.includes(role))) });
}
