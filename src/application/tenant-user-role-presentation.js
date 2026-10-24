import { TENANT_ROLE,tenantAuthorizationSnapshot } from '../authorization/policy.js';
import { resolveTenantRoleSources } from '../authorization/tenant-role-sources.js';

// Presentation of internal, persisted authority only. Provider identifiers are
// deliberately excluded; this contract cannot accept or establish group grants.
export function tenantUserRolePresentation(user) {
  const sources=resolveTenantRoleSources({ directRoles: user.elevatedRoles,
    microsoftGroupRoles: user.microsoftGroupRoles ?? [] });
  const { roles }=tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE,...sources.effectiveRoles]);
  return Object.freeze({ roles,...(sources.microsoftGroupRoles.length>0 ? {
    roleSources: Object.freeze({ direct: sources.directRoles,microsoftGroups: sources.microsoftGroupRoles }),
  } : {}) });
}
