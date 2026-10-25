import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { normalizeOwnerCustomerAccessScope } from '../../domain/owner-customer-handoff.js';
import { createPostgresOwnerCustomerAccessRepository } from './owner-customer-access-repository.js';
import { normalizeSyntheticHandoffScope } from '../../domain/synthetic-handoff.js';
import { createPostgresProtectedCustomerAccessRepository } from './protected-customer-access-repository.js';
import { createPostgresSyntheticCustomerAccessRepository } from './synthetic-customer-access-repository.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { isPostgresTransactionActive } from './transaction.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard,isCalendarAuthorityLockInput,lockCalendarBookingReferenceAuthority }
  from './calendar-authority-guard.js';

// Current registry chooses the fixed branch. A provider label or principal
// alone cannot replace current invited/delegated custody at the final write.
export function createPostgresProtectedCalendarAuthorityGuard(pool,{ environment,securityEpoch,syntheticScope=null,ownerScope=null }={}) {
  if (!pool || typeof pool.query!=='function' || typeof pool.connect!=='function'
    || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CALENDAR_AUTHORITY_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  if (syntheticScope!==null) {
    syntheticScope=normalizeSyntheticHandoffScope(syntheticScope);
    if (syntheticScope.environment!==environment || syntheticScope.securityEpoch!==scope.securityEpoch) {
      throw new TypeError('PROTECTED_CALENDAR_AUTHORITY_CONFIGURATION_INVALID');
    }
  }
  if (ownerScope!==null) {
    ownerScope=normalizeOwnerCustomerAccessScope(ownerScope);
    if (ownerScope.environment!==environment || ownerScope.securityEpoch!==scope.securityEpoch) {
      throw new TypeError('PROTECTED_CALENDAR_AUTHORITY_CONFIGURATION_INVALID');
    }
  }
  const owner=ownerScope===null ? null : createPostgresOwnerCustomerAccessRepository(pool,{ scope: ownerScope });
  const real=createPostgresProtectedCustomerAccessRepository(pool,scope),microsoft=createPostgresMicrosoft365CalendarAuthorityGuard();
  const synthetic=syntheticScope===null ? null : createPostgresSyntheticCustomerAccessRepository(pool,{ scope: syntheticScope });
  function transaction(client) {
    requireProtectedRuntimeSharedExecutionScope(pool,scope);
    if (!isPostgresTransactionActive(pool,client)) throw new TypeError('PROTECTED_CALENDAR_AUTHORITY_TRANSACTION_REQUIRED');
  }
  async function access(client,tenantId,value) {
    transaction(client);let principal;
    try { principal=normalizePrincipal(value); } catch { return null; }
    if (principal.tenantId!==tenantId) return null;
    const selected=await client.query({ name: 'protected-calendar-current-tenant',text: `SELECT registry.mode
      FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
        ON deployment.environment=registry.environment AND deployment.security_epoch=$2
      JOIN tenants tenant ON tenant.id=registry.tenant_id
      WHERE registry.environment=$1 AND registry.tenant_id=$3 AND tenant.status='active' FOR SHARE OF tenant`,
    values: [environment,scope.securityEpoch,tenantId] });
    const mode=selected.rows[0]?.mode,isOwner=principal.providerIdentity.provider==='platform_owner';
    const repository=mode==='real' ? isOwner ? owner : real : mode==='synthetic' ? synthetic : null;
    if (!repository) return null;
    const input={ ...scope,principal },first=await repository.resolveCurrentAccess(input);
    if (first?.runtime?.mode!==mode) return null;
    if (mode==='real' && isOwner) {
      if (!await owner.lockCurrentAccessWithClient(client,input)) return null;
    } else if (mode==='synthetic') {
      const locked=await client.query({ name: 'protected-calendar-source-lock',
        text: 'SELECT protected_lock_synthetic_calendar_source($1,$2,$3) AS allowed',
        values: [environment,scope.securityEpoch,principal.session.id] });
      if (locked.rows[0]?.allowed!==true) return null;
    } else {
      try {
        const locked=await client.query({ name: 'protected-calendar-real-customer-lock',text: `SELECT person.id
          FROM users person JOIN sessions session ON session.tenant_id=person.tenant_id AND session.user_id=person.id
          WHERE person.tenant_id=$1 AND person.id=$2 AND person.active=true AND person.security_version=$3
            AND session.id=$4 AND session.principal_version=person.security_version AND session.revoked_at IS NULL
            AND session.expires_at>clock_timestamp() FOR SHARE OF person,session NOWAIT`,
        values: [tenantId,principal.userId,principal.session.securityVersion,principal.session.id] });
        if (locked.rowCount!==1) return null;
      } catch (error) { if (error?.code==='55P03') return null;throw error; }
    }
    const current=await repository.resolveCurrentAccess(input);
    return current?.runtime?.mode===mode ? current.runtime : null;
  }
  async function syntheticAuthority(client,{ tenantId,requestId,authority,currentRequest,cleanupReference },runtime) {
    if (authority.integrationProvider!=='synthetic_calendar' || authority.identityProvider!=='platform_delegation'
      || authority.providerConnectionReference!==`synthetic:${runtime.generationId}`
      || authority.providerResourceReference!==`synthetic-room:${tenantId}:${authority.roomId}`
      || currentRequest?.tenantId!==tenantId || currentRequest.id!==requestId || currentRequest.roomId!==authority.roomId) return false;
    const resource=await client.query({ name: 'protected-calendar-final-synthetic-resource',text: `SELECT resource.room_id
      FROM synthetic_calendar_resources resource JOIN integrations integration
        ON integration.tenant_id=resource.tenant_id AND integration.id=resource.integration_id
      JOIN rooms room ON room.tenant_id=resource.tenant_id AND room.id=resource.room_id
      WHERE resource.environment=$1 AND resource.security_epoch=$2 AND resource.tenant_id=$3 AND resource.generation_id=$4
        AND resource.integration_id=$5 AND resource.room_id=$6 AND integration.provider='synthetic_calendar'
        AND integration.provider_reference=$7 AND integration.status='active' AND room.active=true FOR SHARE OF integration,room`,
    values: [environment,scope.securityEpoch,tenantId,runtime.generationId,authority.integrationId,authority.roomId,
      authority.providerConnectionReference] });
    if (resource.rowCount!==1) return false;
    if (authority.calendarWriteEnabled) {
      const event=await client.query({ name: 'protected-calendar-final-synthetic-event',text: `SELECT event.id
        FROM synthetic_calendar_events event JOIN booking_provider_references reference
          ON reference.tenant_id=event.tenant_id AND reference.request_id=event.request_id
          AND reference.integration_id=event.integration_id AND reference.provider_reference='synthetic-event:'||event.id::text
          AND reference.idempotency_key=event.idempotency_key
        WHERE event.environment=$1 AND event.security_epoch=$2 AND event.tenant_id=$3 AND event.generation_id=$4
          AND event.integration_id=$5 AND event.room_id=$6 AND event.request_id=$7 AND event.state='active'
          AND event.starts_at=$8 AND event.ends_at=$9 AND reference.state='active'
          AND reference.provider_connection_reference=$10 AND reference.provider_resource_reference=$11
        FOR SHARE OF event,reference`,values: [environment,scope.securityEpoch,tenantId,runtime.generationId,authority.integrationId,
        authority.roomId,requestId,currentRequest.startsAt,currentRequest.endsAt,authority.providerConnectionReference,
        authority.providerResourceReference] });
      if (event.rowCount!==1) return false;
    } else {
      const active=await client.query({ name: 'protected-calendar-final-synthetic-no-event',text: `SELECT id
        FROM synthetic_calendar_events WHERE tenant_id=$1 AND request_id=$2 AND state='active' FOR SHARE`,
      values: [tenantId,requestId] });
      if (active.rowCount!==0) return false;
    }
    return lockCalendarBookingReferenceAuthority(client,{ tenantId,requestId,authority,cleanupReference });
  }
  return Object.freeze({
    async isReady() {
      if (synthetic===null) return true;
      try {
        const result=await pool.query(`SELECT has_function_privilege(current_user,
          'public.protected_lock_synthetic_calendar_source(text,uuid,uuid)','EXECUTE') AS allowed`);
        return result.rows[0]?.allowed===true;
      } catch { return false; }
    },
    async lockBookingIntegration(client,{ tenantId,integrationId,providerConnectionReference,principal }={}) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(integrationId)) return false;
      const runtime=await access(client,tenantId,principal);
      if (runtime?.mode!=='synthetic' || providerConnectionReference!==`synthetic:${runtime.generationId}`) return false;
      const integration=await client.query({ name: 'protected-calendar-booking-integration',text: `SELECT id FROM integrations
        WHERE tenant_id=$1 AND id=$2 AND provider='synthetic_calendar' AND status='active'
          AND provider_reference=$3 FOR SHARE`,values: [tenantId,integrationId,providerConnectionReference] });
      return integration.rowCount===1;
    },
    async lockCustomerMutation(client,{ tenantId,principal }={}) {
      return isInternalUuid(tenantId) && await access(client,tenantId,principal)!==null;
    },
    async lockCurrent(client,input={}) {
      if (!isCalendarAuthorityLockInput(client,input)) return false;
      const runtime=await access(client,input.tenantId,input.principal);if (!runtime) return false;
      return runtime.mode==='real' ? microsoft.lockCurrent(client,input) : syntheticAuthority(client,input,runtime);
    },
    completePreConfirmationCleanup: microsoft.completePreConfirmationCleanup,
  });
}
