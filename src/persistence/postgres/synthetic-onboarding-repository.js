import { createHash } from 'node:crypto';
import { normalizeSyntheticHandoffScope } from '../../domain/synthetic-handoff.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { normalizeSyntheticOnboardingCommand,syntheticOnboardingCandidates,SyntheticOnboardingError }
  from '../../domain/synthetic-onboarding.js';
import { createPostgresProtectedSyntheticCustomerCustody } from './protected-synthetic-customer-custody.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from './transaction.js';
import { loadTenantLocationConfigurationWithClient,lockTenantLocationRevisionWithClient,
  ensureTenantLocationSnapshotWithClient,advanceTenantLocationRevisionWithClient } from './tenant-location-repository.js';

function fail(code='SYNTHETIC_ONBOARDING_AUTHORITY_DENIED') { throw new SyntheticOnboardingError(code); }
function ownedId(tenantId,key) {
  const bytes=createHash('sha256').update(`synthetic-onboarding:v1:${tenantId}:${key}`).digest();
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const text=bytes.subarray(0,16).toString('hex');
  return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
}

// The owning protected root fixes the full scope, actual pool and audit store.
// This repository does not authenticate, select a mode or activate a provider.
export function createPostgresSyntheticOnboardingRepository(pool,{ scope,auditRepository,syntheticParticipantsEnabled=false }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function' || typeof auditRepository?.appendWithClient!=='function'
    || typeof syntheticParticipantsEnabled!=='boolean') {
    throw new TypeError('SYNTHETIC_ONBOARDING_REPOSITORY_CONFIGURATION_INVALID');
  }
  const protection=Object.freeze({ environment: scope.environment,securityEpoch: scope.securityEpoch });
  const access=createPostgresProtectedSyntheticCustomerCustody(pool,{ scope,syntheticParticipantsEnabled });
  async function qualify(client,value,lock=false) {
    let principal;try { principal=normalizePrincipal(value); } catch { fail(); }
    const input={ ...protection,principal };
    const resolved=lock ? await access.lockCurrentAccessWithClient(client,input) : await access.resolveCurrentAccess(input);
    if (resolved?.runtime?.mode!=='synthetic' || !principal.roles.includes('tenant_admin')) fail();
    return { principal,runtime: resolved.runtime,kind: resolved.kind };
  }

  async function transaction(work,readOnly=false) {
    requireProtectedRuntimeSharedExecutionScope(pool,protection);
    try { return await withPostgresTransaction(pool,work,{ readOnly }); }
    catch (error) {
      if (['40001','40P01','23505'].includes(error?.code)) fail('SYNTHETIC_ONBOARDING_CONFLICT');
      if (error?.code==='42501') fail();
      if (error?.code==='57014') fail('SYNTHETIC_ONBOARDING_STATE_INVALID');throw error;
    }
  }
  async function view(client,runtime) {
    const result=await client.query({ name: 'synthetic-onboarding-current-view',text: `SELECT tenant.status,tenant.locations_revision,
      (SELECT count(*)::int FROM rooms WHERE tenant_id=tenant.id AND active=true) AS room_count,
      (SELECT count(*)::int FROM rooms room JOIN sites site ON site.tenant_id=room.tenant_id AND site.id=room.site_id
        JOIN synthetic_calendar_resources resource ON resource.tenant_id=room.tenant_id AND resource.room_id=room.id
        JOIN integrations integration ON integration.tenant_id=resource.tenant_id AND integration.id=resource.integration_id
        WHERE room.tenant_id=tenant.id AND room.active=true AND site.active=true AND resource.environment=$1
          AND resource.security_epoch=$2 AND resource.generation_id=$4 AND integration.provider='synthetic_calendar'
          AND integration.status='active' AND integration.provider_reference='synthetic:'||resource.generation_id::text) AS bound_count,
      EXISTS(SELECT 1 FROM tenant_entitlements WHERE tenant_id=tenant.id
        AND capability_id='microsoft.directory' AND enabled=true) AS directory_entitled,
      EXISTS(SELECT 1 FROM tenant_entitlements WHERE tenant_id=tenant.id
        AND capability_id='microsoft.calendar' AND enabled=true) AS calendar_entitled,
      EXISTS(SELECT 1 FROM tenant_entitlements WHERE tenant_id=tenant.id
        AND capability_id='microsoft.calendar.write' AND enabled=true) AS write_entitled
      FROM tenants tenant WHERE tenant.id=$3 AND tenant.status IN ('onboarding','ready','active')`,
    values: [scope.environment,scope.securityEpoch,runtime.tenantId,runtime.generationId] });
    const row=result.rows[0];if (!row) fail();
    const revision=Number(row.locations_revision),count=Number(row.room_count),bound=Number(row.bound_count);
    if (!Number.isSafeInteger(revision) || revision<1 || !Number.isSafeInteger(count) || count<0 || count>2000
      || !Number.isSafeInteger(bound) || bound<0 || bound>count) fail('SYNTHETIC_ONBOARDING_STATE_INVALID');
    const checks=Object.freeze({ roomsImported: count>0,calendarResourcesBound: count>0 && count===bound,
      directoryEntitled: row.directory_entitled===true,calendarEntitled: row.calendar_entitled===true });
    const existing=(await client.query({ name: 'synthetic-onboarding-imported-room-ids',
      text: 'SELECT id FROM rooms WHERE tenant_id=$1 ORDER BY id',values: [runtime.tenantId] })).rows.map(row=>row.id);
    return Object.freeze({ mode: 'synthetic',provider: 'synthetic_calendar',microsoftConnection: 'not_applicable',
      tenantStatus: row.status,locationsRevision: revision,roomCount: count,boundRoomCount: bound,
      readiness: Object.freeze({ ready: Object.values(checks).every(Boolean),checks }),
      calendarWriteEntitled: row.write_entitled===true,candidates: Object.freeze(syntheticOnboardingCandidates(runtime)
        .map(candidate=>Object.freeze({ ...candidate,imported: existing.includes(ownedId(runtime.tenantId,candidate.key)) }))) });
  }
  return Object.freeze({
    async isReady() {
      try {
        const result=await pool.query(`SELECT has_function_privilege(current_user,
          'public.protected_synthetic_lifecycle(text,uuid,uuid,text,text,bigint)','EXECUTE')
          AND (NOT ${syntheticParticipantsEnabled} OR has_function_privilege(current_user,
            'public.protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint)','EXECUTE')) AS allowed`);
        return result.rows[0]?.allowed===true;
      } catch { return false; }
    },
    view({ principal }) {
      return transaction(async client=>view(client,(await qualify(client,principal)).runtime),!syntheticParticipantsEnabled);
    },
    importRooms({ principal,expectedRevision,selectedKeys,auditEventFor }) {
      const command=normalizeSyntheticOnboardingCommand({ expectedRevision,selectedKeys },'import');
      if (typeof auditEventFor!=='function') throw new TypeError('SYNTHETIC_ONBOARDING_AUDIT_REQUIRED');
      return transaction(async client=>{
        const current=await qualify(client,principal,true),tenantId=current.runtime.tenantId;
        const revision=await lockTenantLocationRevisionWithClient(client,tenantId);
        if (revision!==command.expectedRevision) fail('SYNTHETIC_ONBOARDING_CONFLICT');
        const before=await view(client,current.runtime),candidates=syntheticOnboardingCandidates(current.runtime);
        if (command.selectedKeys.some(key=>!candidates.some(candidate=>candidate.key===key))) {
          fail('SYNTHETIC_ONBOARDING_INPUT_INVALID');
        }
        const selected=candidates.filter(candidate=>command.selectedKeys.includes(candidate.key)
          && !before.candidates.find(row=>row.key===candidate.key)?.imported);
        if (!selected.length) return Object.freeze({ ...before,importedCount: 0 });
        const changedAt=new Date(),configuration=await loadTenantLocationConfigurationWithClient(client,tenantId);
        await ensureTenantLocationSnapshotWithClient(client,{ tenantId,revision,configuration,changedAt,
          actorUserId: current.principal.userId });
        const siteId=ownedId(tenantId,'site');
        await client.query({ name: 'synthetic-onboarding-import-site',text: `INSERT INTO sites
          (tenant_id,id,name,active,time_zone,created_at,updated_at) VALUES($1,$2,$3,true,$4,$5,$5)
          ON CONFLICT(tenant_id,id) DO NOTHING`,values: [tenantId,siteId,selected[0].building,selected[0].timeZone,changedAt] });
        const site=await client.query('SELECT active FROM sites WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenantId,siteId]);
        if (site.rows[0]?.active!==true) fail('SYNTHETIC_ONBOARDING_CONFLICT');
        for (const candidate of selected) await client.query({ name: 'synthetic-onboarding-import-room',text: `INSERT INTO rooms
          (tenant_id,id,site_id,name,capacity,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,true,$6,$6)`,
        values: [tenantId,ownedId(tenantId,candidate.key),siteId,candidate.name,candidate.capacity,changedAt] });
        const nextRevision=revision+1;
        await advanceTenantLocationRevisionWithClient(client,{ tenantId,currentRevision: revision,nextRevision,changedAt });
        await ensureTenantLocationSnapshotWithClient(client,{ tenantId,revision: nextRevision,
          configuration: await loadTenantLocationConfigurationWithClient(client,tenantId),changedAt,
          actorUserId: current.principal.userId });
        await qualify(client,current.principal);
        await auditRepository.appendWithClient(client,auditEventFor({ importedCount: selected.length,revision: nextRevision }));
        return Object.freeze({ ...await view(client,current.runtime),importedCount: selected.length });
      });
    },
    transition({ principal,expectedRevision,expectedStatus,targetStatus,auditEvent }) {
      const command=normalizeSyntheticOnboardingCommand({ expectedRevision,expectedStatus,targetStatus },'lifecycle');
      return transaction(async client=>{
        const current=await qualify(client,principal,true);
        const lifecycle=current.kind==='synthetic_participant'
          ? 'protected_synthetic_participant_lifecycle' : 'protected_synthetic_lifecycle';
        const result=await client.query({ name: 'synthetic-onboarding-lifecycle',
          text: `SELECT ${lifecycle}($1,$2,$3,$4,$5,$6) AS allowed`,values: [scope.environment,scope.securityEpoch,
            current.principal.session.id,command.expectedStatus,command.targetStatus,command.expectedRevision] });
        if (result.rows[0]?.allowed!==true) fail('SYNTHETIC_ONBOARDING_CONFLICT');
        await qualify(client,current.principal);await auditRepository.appendWithClient(client,auditEvent);
        return view(client,current.runtime);
      });
    },
  });
}
