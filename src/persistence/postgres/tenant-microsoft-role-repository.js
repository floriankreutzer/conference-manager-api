import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeMicrosoftDirectoryId,normalizeMicrosoftGroupMappings,resolveMicrosoftMappedGroups }
  from '../../authorization/microsoft-group-mapping.js';
import { withPostgresTransaction } from './transaction.js';

function uuid(value) { if (!isInternalUuid(value)) throw new TypeError('MICROSOFT_ROLE_SCOPE_INVALID');return value.toLowerCase(); }
function projection(row) {
  if (!row) return Object.freeze({ revision: 0,directoryId: null,mappings: Object.freeze([]) });
  const revision=Number(row.revision);if (!Number.isSafeInteger(revision) || revision<1) throw new Error('MICROSOFT_ROLE_SETTINGS_INVALID');
  return Object.freeze({ revision,directoryId: normalizeMicrosoftDirectoryId(row.directory_id),
    mappings: normalizeMicrosoftGroupMappings(row.mappings) });
}
export async function lockTenantMicrosoftRoleAdministration(client,tenantId) {
  await client.query({ name: 'microsoft-role-administration-lock',text:
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',values: [`tenant-role-admin:${uuid(tenantId)}`] });
}
async function auditReceipt(client,auditRepository,event,tenantId) {
  const stored=await auditRepository.appendWithClient(client,event);
  if (!stored || stored.tenantId!==tenantId || !/^[1-9]\d{0,18}$/.test(String(stored.id))) {
    throw new Error('MICROSOFT_ROLE_AUDIT_FAILED');
  }
  return String(stored.id);
}
async function settings(client,tenantId) {
  const result=await client.query({ name: 'microsoft-role-settings-current',text:
    'SELECT revision,directory_id,mappings FROM tenant_microsoft_role_settings WHERE tenant_id=$1',values: [tenantId] });
  return projection(result.rows[0]);
}
export function createPostgresTenantMicrosoftRoleRepository(pool,{ auditRepository,tenantEligibility=null }={}) {
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function'
    || typeof auditRepository?.appendWithClient!=='function'
    || tenantEligibility!==null && typeof tenantEligibility?.lockAdmissionWithClient!=='function') {
    throw new TypeError('MICROSOFT_ROLE_REPOSITORY_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    get: ({ tenantId })=>withPostgresTransaction(pool,async client=>{
      tenantId=uuid(tenantId);
      if (tenantEligibility!==null && await tenantEligibility.lockAdmissionWithClient(client,tenantId)!==true) {
        return null;
      }
      return settings(client,tenantId);
    }),
    async replace({ tenantId,actorUserId,directoryId,mappings,expectedRevision,auditEventFor }={}) {
      tenantId=uuid(tenantId);actorUserId=uuid(actorUserId);directoryId=normalizeMicrosoftDirectoryId(directoryId);
      mappings=normalizeMicrosoftGroupMappings(mappings);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision<0 || expectedRevision>=2147483646
        || typeof auditEventFor!=='function') throw new TypeError('MICROSOFT_ROLE_REPLACE_INVALID');
      return withPostgresTransaction(pool,async client=>{
        if (tenantEligibility!==null && await tenantEligibility.lockAdmissionWithClient(client,tenantId)!==true) {
          return Object.freeze({ status: 'not_authorized' });
        }
        await lockTenantMicrosoftRoleAdministration(client,tenantId);
        const actor=await client.query({ name: 'microsoft-role-actor-current',text: `SELECT person.id FROM users person
          JOIN (SELECT * FROM tenant_user_roles
      WHERE tenant_role_source_active(direct_grant,microsoft_verified_until)) AS authority
            ON authority.tenant_id=person.tenant_id AND authority.user_id=person.id
          WHERE person.tenant_id=$1 AND person.id=$2 AND person.active=true AND authority.role='tenant_admin' FOR UPDATE OF person`,
        values: [tenantId,actorUserId] });
        if (actor.rowCount!==1) return Object.freeze({ status: 'not_authorized' });
        const current=await settings(client,tenantId);
        if (current.revision!==expectedRevision) return Object.freeze({ status: 'version_conflict',currentRevision: current.revision });
        if (current.directoryId===directoryId && JSON.stringify(current.mappings)===JSON.stringify(mappings)) {
          return Object.freeze({ status: 'unchanged',settings: current });
        }
        // A direct recovery Admin must survive a mapping change. Provider
        // revocation itself is never blocked to preserve stale group authority.
        const recovery=await client.query({ name: 'microsoft-role-direct-recovery-admin',text: `SELECT role.user_id
          FROM tenant_user_roles role JOIN users person ON person.tenant_id=role.tenant_id AND person.id=role.user_id
          WHERE role.tenant_id=$1 AND role.role='tenant_admin' AND role.direct_grant AND person.active=true LIMIT 1`,values: [tenantId] });
        if (recovery.rowCount!==1) return Object.freeze({ status: 'direct_admin_required' });
        // Lock all affected Users in stable order before role rows, matching
        // direct/lifecycle administration and provider reconciliation.
        await client.query({ name: 'microsoft-role-settings-lock-users',text: `SELECT person.id FROM users person
          WHERE person.tenant_id=$1 AND EXISTS(SELECT 1 FROM tenant_user_roles role WHERE role.tenant_id=$1
            AND role.user_id=person.id AND cardinality(role.microsoft_group_ids)>0) ORDER BY person.id FOR UPDATE`,values: [tenantId] });
        await client.query({ name: 'microsoft-role-settings-clear-derived-only',text: `DELETE FROM tenant_user_roles
          WHERE tenant_id=$1 AND NOT direct_grant AND cardinality(microsoft_group_ids)>0`,values: [tenantId] });
        await client.query({ name: 'microsoft-role-settings-clear-combined',text: `UPDATE tenant_user_roles
          SET microsoft_directory_id=NULL,microsoft_group_ids=ARRAY[]::uuid[],microsoft_verified_until=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND cardinality(microsoft_group_ids)>0`,values: [tenantId] });
        const event=auditEventFor({ previousRevision: current.revision,revision: current.revision+1,
          previousMappingCount: current.mappings.length,mappingCount: mappings.length });
        if (event.tenantId!==tenantId || event.actorUserId!==actorUserId) throw new Error('MICROSOFT_ROLE_AUDIT_BINDING_INVALID');
        const receipt=await auditReceipt(client,auditRepository,event,tenantId);
        await client.query({ name: 'microsoft-role-settings-replace',text: `INSERT INTO tenant_microsoft_role_settings
          (tenant_id,revision,directory_id,mappings,approved_by_user_id,audit_event_id)
          VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,
            directory_id=EXCLUDED.directory_id,mappings=EXCLUDED.mappings,approved_by_user_id=EXCLUDED.approved_by_user_id,
            audit_event_id=EXCLUDED.audit_event_id,updated_at=clock_timestamp()`,
        values: [tenantId,current.revision+1,directoryId,JSON.stringify(mappings),actorUserId,receipt] });
        return Object.freeze({ status: 'updated',settings: await settings(client,tenantId) });
      });
    },
    // The caller owns the advisory lock, active User lock, verified flow/browser
    // custody and exact accepted identity binding in the same transaction.
    async reconcileWithClient(client,{ tenantId,userId,environment,flow,auditEventFor }={}) {
      tenantId=uuid(tenantId);userId=uuid(userId);
      if (!['dev','int','prod'].includes(environment) || !flow || flow.status!=='verified'
        || typeof auditEventFor!=='function') throw new TypeError('MICROSOFT_ROLE_RECONCILE_INVALID');
      const scope=await client.query({ name: 'microsoft-role-current-identity',text: `SELECT person.id FROM users person
        JOIN user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
        WHERE person.tenant_id=$1 AND person.id=$2 AND person.active=true AND identity.provider='microsoft_entra'
          AND identity.provider_tenant_reference=$3 AND identity.provider_user_reference=$4 FOR UPDATE OF person`,
      values: [tenantId,userId,flow.provider_tenant_reference,flow.provider_user_reference] });
      if (scope.rowCount!==1) throw new Error('MICROSOFT_ROLE_RECONCILE_SCOPE_INVALID');
      const configured=await settings(client,tenantId);
      const observed=await client.query({ name: 'microsoft-role-flow-membership',text: `SELECT status,group_ids,valid_until
        FROM customer_microsoft_group_observations WHERE environment=$1 AND flow_id=$2 AND directory_id=$3
          AND provider_user_id=$4 AND verified_at=$5 AND valid_until>clock_timestamp()`,
      values: [environment,flow.id,flow.provider_tenant_reference,flow.provider_user_reference,flow.verified_at] });
      const observation=observed.rows[0],desired=configured.directoryId===null ? { conference_manager: [],tenant_admin: [] }
        : resolveMicrosoftMappedGroups({ directoryId: configured.directoryId,mappings: configured.mappings,
          providerDirectoryId: flow.provider_tenant_reference,membership: observation
            ? { status: observation.status,groupIds: observation.group_ids } : { status: 'unavailable',groupIds: [] } });
      const current=await client.query({ name: 'microsoft-role-source-rows',text: `SELECT role,direct_grant,
        microsoft_directory_id,microsoft_group_ids,microsoft_verified_until FROM tenant_user_roles
        WHERE tenant_id=$1 AND user_id=$2 ORDER BY role FOR UPDATE`,values: [tenantId,userId] });
      let changed=false;
      for (const role of ['conference_manager','tenant_admin']) {
        const prior=current.rows.find(row=>row.role===role),ids=desired[role];
        if (!ids.length) {
          if (!prior?.microsoft_group_ids.length) continue;
          changed=true;
          if (!prior.direct_grant) await client.query({ name: 'microsoft-role-source-delete',text:
            'DELETE FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2 AND role=$3',values: [tenantId,userId,role] });
          else await client.query({ name: 'microsoft-role-source-clear',text: `UPDATE tenant_user_roles
            SET microsoft_directory_id=NULL,microsoft_group_ids=ARRAY[]::uuid[],microsoft_verified_until=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND user_id=$2 AND role=$3`,values: [tenantId,userId,role] });
        } else {
          changed=true;
          await client.query({ name: 'microsoft-role-source-upsert',text: `INSERT INTO tenant_user_roles
            (tenant_id,user_id,role,direct_grant,microsoft_directory_id,microsoft_group_ids,microsoft_verified_until)
            VALUES($1,$2,$3,false,$4,$5::uuid[],$6) ON CONFLICT(tenant_id,user_id,role) DO UPDATE SET
              microsoft_directory_id=EXCLUDED.microsoft_directory_id,microsoft_group_ids=EXCLUDED.microsoft_group_ids,
              microsoft_verified_until=EXCLUDED.microsoft_verified_until,updated_at=clock_timestamp()`,
          values: [tenantId,userId,role,flow.provider_tenant_reference,ids,observation.valid_until] });
        }
      }
      if (changed) {
        const event=auditEventFor({ tenantId,userId,
          conferenceManager: desired.conference_manager.length>0,tenantAdmin: desired.tenant_admin.length>0 });
        if (event.tenantId!==tenantId || event.actorUserId!==userId) throw new Error('MICROSOFT_ROLE_AUDIT_BINDING_INVALID');
        await auditReceipt(client,auditRepository,event,tenantId);
      }
      const version=await client.query({ name: 'microsoft-role-current-security-version',text:
        'SELECT security_version FROM users WHERE tenant_id=$1 AND id=$2 AND active=true',values: [tenantId,userId] });
      const value=Number(version.rows[0]?.security_version);
      if (!Number.isSafeInteger(value) || value<1) throw new Error('MICROSOFT_ROLE_SECURITY_VERSION_INVALID');
      return value;
    },
  });
}
