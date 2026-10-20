import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { TENANT_ROLE,tenantAuthorizationSnapshot } from '../authorization/policy.js';
import { createSyntheticBusinessTemplates,SYNTHETIC_BUSINESS_TEMPLATE_VERSION } from '../synthetic/business-templates.js';
import { scheduleSyntheticBusinessRequests } from '../synthetic/business-schedule.js';

const SLOTS=['northwind','contoso','fabrikam'];
const ROLES=[TENANT_ROLE.EMPLOYEE,TENANT_ROLE.CONFERENCE_MANAGER,TENANT_ROLE.TENANT_ADMIN];
const REFERENCE_KEYS=new Set(['id','roomId','ownerId','costCenterId','cateringPackageId','requesterUserId']);
const REFERENCE_ARRAYS=new Set(['siteIds','roomIds','itemIds','equipmentIds','equipment']);

function invalid() { throw new TypeError('SYNTHETIC_GENERATION_PLAN_INVALID'); }

function collectIds(value,ids) {
  if (!value || typeof value!=='object') return;
  if (Object.hasOwn(value,'id')) ids.add(value.id);
  for (const item of Object.values(value)) collectIds(item,ids);
}

function remap(value,mapping,key='') {
  if (Array.isArray(value)) return value.map(item=>remap(item,mapping,key));
  if (value && typeof value==='object') {
    return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,remap(item,mapping,name)]));
  }
  if (typeof value==='string' && (REFERENCE_KEYS.has(key) || REFERENCE_ARRAYS.has(key))) {
    if (!mapping.has(value)) invalid();
    return mapping.get(value);
  }
  return value;
}

// Server composition fixes randomness. A plan allocates data only: persistence,
// current operator authority and exact request proof remain mandatory elsewhere.
export function createSyntheticGenerationPlanner({ allocateId=randomUUID }={}) {
  if (typeof allocateId!=='function') invalid();
  return Object.freeze({
    create(input) {
      if (!input || Object.keys(input).sort().join(',')!=='environment,now,operatorId,operatorSecurityVersion,securityEpoch'
        || !['dev','int'].includes(input.environment) || !isInternalUuid(input.operatorId)
        || !isInternalUuid(input.securityEpoch) || !Number.isSafeInteger(input.operatorSecurityVersion)
        || input.operatorSecurityVersion<1 || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) invalid();
      const templates=createSyntheticBusinessTemplates();
      const reserved=new Set([input.operatorId.toLowerCase(),input.securityEpoch.toLowerCase()]);
      for (const template of templates) {
        const sourceIds=new Set();collectIds(template,sourceIds);
        for (const id of sourceIds) reserved.add(id);
        for (const request of template.requests) reserved.add(request.requesterUserId);
      }
      function fresh() {
        const id=allocateId();
        if (!isInternalUuid(id) || reserved.has(id.toLowerCase())) invalid();
        reserved.add(id.toLowerCase());return id.toLowerCase();
      }
      const generationId=fresh();
      const tenants=templates.map((template,index)=>{
        const ids=new Set();collectIds(template,ids);
        const mapping=new Map([...ids].map(id=>[id,fresh()]));
        const tenantId=mapping.get(template.id);
        const users=ROLES.map(role=>({ userId: fresh(),role,tenantId,
          ...tenantAuthorizationSnapshot(role===TENANT_ROLE.EMPLOYEE ? [role] : [TENANT_ROLE.EMPLOYEE,role]) }));
        const employee=users.find(user=>user.role===TENANT_ROLE.EMPLOYEE);
        for (const request of template.requests) mapping.set(request.requesterUserId,employee.userId);
        const business=remap(template,mapping);
        const mediaSources=[...template.roomMedia.map(media=>({ kind: 'room',media })),
          ...template.catalogueMedia.map(media=>({ kind: 'catalogue',media }))]
          .map(({ kind,media })=>({ assetId: mapping.get(media.id),kind,sourceAssetId: media.id }));
        return { slot: SLOTS[index],business,users,mediaSources };
      });
      const scheduled=scheduleSyntheticBusinessRequests(tenants.map(tenant=>tenant.business),input.now);
      return { generationId,environment: input.environment,securityEpoch: input.securityEpoch.toLowerCase(),
        operatorId: input.operatorId.toLowerCase(),operatorSecurityVersion: input.operatorSecurityVersion,
        createdAt: input.now.toISOString(),templateVersion: SYNTHETIC_BUSINESS_TEMPLATE_VERSION,
        tenants: tenants.map((tenant,index)=>({ ...tenant,business: scheduled[index] })) };
    },
  });
}
