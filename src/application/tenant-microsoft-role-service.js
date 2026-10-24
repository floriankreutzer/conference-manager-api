import { AUDIT_ACTION,AUDIT_OUTCOME,AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { PERMISSION } from '../authorization/policy.js';
import { AuthorizationDeniedError,AuthorizationInputError } from '../authorization/errors.js';
import { normalizeMicrosoftDirectoryId,normalizeMicrosoftGroupMappings } from '../authorization/microsoft-group-mapping.js';
import { isInternalUuid } from '../domain/identifiers.js';

export class MicrosoftRoleMappingConflictError extends Error {
  constructor(code,currentRevision) {
    super(code);this.name='MicrosoftRoleMappingConflictError';this.code=code;this.currentRevision=currentRevision;
  }
}
export function createTenantMicrosoftRoleService({ repository,authorizationPolicy,auditService }={}) {
  if (['get','replace'].some(name=>typeof repository?.[name]!=='function')
    || typeof authorizationPolicy?.requireTenantPermission!=='function'
    || ['createEvent','record','recordAuthorizationDenied'].some(name=>typeof auditService?.[name]!=='function')) {
    throw new TypeError('MICROSOFT_ROLE_SERVICE_CONFIGURATION_INVALID');
  }
  async function authorize(context,operation) {
    if (!isInternalUuid(context?.correlationId)) throw new AuthorizationInputError('MICROSOFT_ROLE_CORRELATION_INVALID');
    try { authorizationPolicy.requireTenantPermission(context.principal,context.tenantContext,PERMISSION.TENANT_USERS_MANAGE); }
    catch (error) {
      if (error instanceof AuthorizationDeniedError) await auditService.recordAuthorizationDenied({ ...context,
        targetType: 'endpoint',targetId: 'microsoft_role_mappings',metadata: { operation } });
      throw error;
    }
  }
  return Object.freeze({
    async get(context) { await authorize(context,'read_microsoft_role_mapping');
      const result=await repository.get({ tenantId: context.tenantContext.tenantId });
      if (!result) throw new AuthorizationDeniedError('MICROSOFT_ROLE_MAPPING_NOT_AUTHORIZED');
      return result; },
    async replace(context,{ directoryId,mappings,expectedRevision }={}) {
      await authorize(context,'replace_microsoft_role_mapping');
      directoryId=normalizeMicrosoftDirectoryId(directoryId);mappings=normalizeMicrosoftGroupMappings(mappings);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision<0 || expectedRevision>=2147483646) {
        throw new AuthorizationInputError('MICROSOFT_ROLE_REVISION_INVALID');
      }
      const tenantId=context.tenantContext.tenantId;
      const result=await repository.replace({ tenantId,actorUserId: context.principal.userId,directoryId,mappings,expectedRevision,
        auditEventFor({ previousRevision,revision,previousMappingCount,mappingCount }) {
          return auditService.createEvent({ ...context,action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
            targetType: 'microsoft_role_mapping',targetId: tenantId,outcome: AUDIT_OUTCOME.SUCCESS,
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            previousState: { revision: previousRevision,mappingCount: previousMappingCount },
            newState: { revision,mappingCount },metadata: { operation: 'replace_microsoft_role_mapping' } });
        } });
      if (result?.status==='not_authorized') {
        await auditService.recordAuthorizationDenied({ ...context,targetType: 'microsoft_role_mapping',targetId: tenantId,
          metadata: { operation: 'replace_microsoft_role_mapping' } });
        throw new AuthorizationDeniedError('MICROSOFT_ROLE_MAPPING_NOT_AUTHORIZED');
      }
      if (['version_conflict','direct_admin_required'].includes(result?.status)) {
        await auditService.record({ ...context,action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'microsoft_role_mapping',targetId: tenantId,outcome: AUDIT_OUTCOME.FAILURE,
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
          metadata: { operation: 'replace_microsoft_role_mapping',reasonCode: result.status } });
      }
      if (result?.status==='version_conflict') throw new MicrosoftRoleMappingConflictError(
        'MICROSOFT_ROLE_MAPPING_VERSION_CONFLICT',result.currentRevision);
      if (result?.status==='direct_admin_required') throw new MicrosoftRoleMappingConflictError(
        'MICROSOFT_ROLE_DIRECT_ADMIN_REQUIRED',expectedRevision);
      if (!['updated','unchanged'].includes(result?.status) || !result.settings) throw new Error('MICROSOFT_ROLE_MAPPING_RESULT_INVALID');
      return result.settings;
    },
  });
}
