import { AuthorizationInputError } from './errors.js';
import { normalizeTenantElevatedRoles } from './tenant-role-sources.js';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=()=>{ throw new AuthorizationInputError('MICROSOFT_ROLE_MAPPING_INVALID'); };
function exact(value,fields) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if (keys.length!==fields.length || keys.some(key=>!fields.includes(key)
    || !Object.hasOwn(descriptors[key],'value'))) invalid();
}
function array(value,max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>max) invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length!==value.length+1) invalid();
  return Array.from({ length: value.length },(_,index)=>{
    const descriptor=descriptors[String(index)];if (!descriptor || !Object.hasOwn(descriptor,'value')) invalid();
    return descriptor.value;
  });
}
export function normalizeMicrosoftDirectoryId(value) {
  if (typeof value!=='string' || !GUID.test(value)
    || value.toLowerCase()==='9188040d-6c67-4c5b-b112-36a304b66dad') invalid();
  return value.toLowerCase();
}
export function normalizeMicrosoftGroupMappings(value) {
  const seen=new Set();
  const normalized=array(value,100).map(entry=>{
    exact(entry,['groupId','roles']);
    if (typeof entry.groupId!=='string' || !GUID.test(entry.groupId)) invalid();
    const groupId=entry.groupId.toLowerCase();if (seen.has(groupId)) invalid();seen.add(groupId);
    const roles=normalizeTenantElevatedRoles(entry.roles);if (!roles.length) invalid();
    return Object.freeze({ groupId,roles });
  });
  return Object.freeze(normalized.sort((left,right)=>left.groupId.localeCompare(right.groupId)));
}
export function resolveMicrosoftMappedGroups({ directoryId,mappings,providerDirectoryId,membership }={}) {
  const approved=normalizeMicrosoftDirectoryId(directoryId),provider=normalizeMicrosoftDirectoryId(providerDirectoryId);
  const configured=normalizeMicrosoftGroupMappings(mappings);
  exact(membership,['status','groupIds']);
  if (!['complete','unavailable','overage'].includes(membership.status)) invalid();
  const groups=array(membership.groupIds,200),seen=new Set();
  for (const group of groups) {
    if (typeof group!=='string' || !GUID.test(group) || seen.has(group.toLowerCase())) invalid();seen.add(group.toLowerCase());
  }
  if (membership.status!=='complete' && groups.length) invalid();
  const output={ conference_manager: [],tenant_admin: [] };
  if (approved===provider && membership.status==='complete') for (const mapping of configured) {
    if (seen.has(mapping.groupId)) for (const role of mapping.roles) output[role].push(mapping.groupId);
  }
  return Object.freeze(Object.fromEntries(Object.entries(output).map(([role,ids])=>[role,Object.freeze(ids)])));
}
