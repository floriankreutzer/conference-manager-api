import { syntheticOperationAssurance } from '../../domain/synthetic-operation-assurance.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { SYNTHETIC_HANDOFF_SLOTS } from '../../domain/synthetic-handoff.js';
import { normalizeSyntheticGenerationDirectory } from '../../domain/synthetic-generation-directory.js';
import { SYNTHETIC_GENERATION_COOLDOWN_MS,SYNTHETIC_GENERATION_RETENTION_LIMIT } from '../../domain/synthetic-generation-lifecycle.js';
import { normalizePlatformPrincipal } from '../../platform/identity/principal.js';
import { PLATFORM_PERMISSION } from '../../platform/identity/policy.js';
import { PlatformAuthorizationError } from '../../platform/identity/errors.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from './transaction.js';

function invalid() { throw new TypeError('SYNTHETIC_GENERATION_DIRECTORY_INVALID'); }
export function createPostgresSyntheticGenerationDirectoryRepository(pool,{ environment,securityEpoch,platformSecurityEpoch,
  assuranceMode='application_passkey' }={}) {
  const assurance=syntheticOperationAssurance(assuranceMode);
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function' || !['dev','int'].includes(environment)
    || !isInternalUuid(securityEpoch) || !Number.isSafeInteger(platformSecurityEpoch) || platformSecurityEpoch<1) {
    throw new TypeError('SYNTHETIC_GENERATION_DIRECTORY_CONFIGURATION_INVALID');
  }
  const protection=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  return Object.freeze({
    async current(value) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      const principal=normalizePlatformPrincipal(value);
      if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='mfa'
        || principal.assurance.authenticationContext!==assurance.normalContext || principal.session.securityEpoch!==platformSecurityEpoch
        || !principal.permissions.includes(PLATFORM_PERMISSION.LIFECYCLE_MANAGE)) throw new PlatformAuthorizationError();
      return withPostgresTransaction(pool,async client=>{
        const authority=await client.query({ name: 'synthetic-generation-directory-current-source',text: `SELECT clock_timestamp() AS now
          FROM platform_operators actor JOIN platform_sessions source ON source.operator_id=actor.id
          WHERE actor.id=$1 AND actor.security_version=$2 AND actor.status='active' AND actor.provider=$4
            AND actor.provider_tenant_reference=$5 AND actor.provider_subject_reference=$6 AND actor.roles=$7::text[]
            AND actor.scope_mode=$8 AND source.id=$3 AND source.principal_version=actor.security_version
            AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
            AND source.provider_subject_reference=actor.provider_subject_reference AND source.roles=actor.roles
            AND source.scope_mode=actor.scope_mode AND source.security_epoch=$9 AND source.assurance_level='mfa'
            AND source.authentication_context=$12 AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp()
            AND date_trunc('milliseconds',source.authenticated_at)=$10
            AND ($13::boolean OR (SELECT count(*) FROM platform_passkey_credentials credential WHERE credential.operator_id=actor.id
              AND credential.environment=$11 AND credential.revoked_at IS NULL)>=2) LIMIT 1`,
        values: [principal.operatorId,principal.securityVersion,principal.session.id,PLATFORM_ENTRA_PROVIDER,
          principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,principal.roles,principal.targetScope.mode,
          platformSecurityEpoch,principal.assurance.authenticatedAt,environment,assurance.normalContext,assuranceMode==='microsoft_mfa'] });
        if (authority.rowCount!==1) throw new PlatformAuthorizationError();
        const now=authority.rows[0]?.now;if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
        const history=await client.query({ name: 'synthetic-generation-directory-own-history',text: `SELECT
            id,state,revision,security_epoch,operator_security_version,created_at,activated_at,archived_at
          FROM synthetic_tenant_generations WHERE environment=$1 AND operator_id=$2 ORDER BY created_at DESC,id LIMIT 33`,
        values: [environment,principal.operatorId] });
        if (history.rowCount>SYNTHETIC_GENERATION_RETENTION_LIMIT) invalid();
        let latest=0;
        for (const row of history.rows) {
          if (!['active','archived'].includes(row.state)) invalid();
          for (const time of [row.created_at,row.activated_at,row.archived_at].filter(entry=>entry!==null)) {
            if (!(time instanceof Date) || !Number.isFinite(time.getTime())) invalid();latest=Math.max(latest,time.getTime());
          }
        }
        const active=history.rows.filter(row=>row.state==='active');if (active.length>1) invalid();
        let generation=null;
        if (active.length===1) {
          const row=active[0];
          const tenants=await client.query({ name: 'synthetic-generation-directory-own-tenants',text: `SELECT registry.slot,
              registry.tenant_id,tenant.status FROM tenant_runtime_registry registry JOIN tenants tenant ON tenant.id=registry.tenant_id
            WHERE registry.environment=$1 AND registry.operator_id=$2 AND registry.generation_id=$3 AND registry.mode='synthetic'
            ORDER BY registry.slot LIMIT 4`,values: [environment,principal.operatorId,row.id] });
          if (tenants.rowCount!==3) invalid();
          generation={ generationId: row.id,revision: Number(row.revision),
            available: row.security_epoch===protection.securityEpoch && Number(row.operator_security_version)===principal.securityVersion,
            tenants: SYNTHETIC_HANDOFF_SLOTS.map(slot=>{
              const tenant=tenants.rows.find(item=>item.slot===slot);if (!tenant) invalid();
              return { slot,tenantId: tenant.tenant_id,status: tenant.status };
            }) };
        }
        const until=latest+SYNTHETIC_GENERATION_COOLDOWN_MS,replaceAfter=latest>0 && until>now.getTime()
          ? new Date(until).toISOString() : null;
        return normalizeSyntheticGenerationDirectory({ generation,retainedGenerations: history.rowCount,replaceAfter,
          canReplace: history.rowCount<SYNTHETIC_GENERATION_RETENTION_LIMIT && replaceAfter===null });
      },{ readOnly: true });
    },
  });
}
