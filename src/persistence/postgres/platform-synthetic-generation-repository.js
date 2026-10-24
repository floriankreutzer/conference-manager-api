import { syntheticOperationAssurance } from '../../domain/synthetic-operation-assurance.js';
import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { createSyntheticGenerationPlanner } from '../../tenancy/synthetic-generation-plan.js';
import { normalizeSyntheticGenerationIntent,requireOwnedSyntheticTenantArchival,
  SYNTHETIC_GENERATION_COOLDOWN_MS,SYNTHETIC_GENERATION_RETENTION_LIMIT } from '../../domain/synthetic-generation-lifecycle.js';
import { normalizePlatformPrincipal } from '../../platform/identity/principal.js';
import { createPlatformAuthorizationPolicy,PLATFORM_PERMISSION } from '../../platform/identity/policy.js';
import { createSyntheticTemplateMediaSource } from '../../media/synthetic-template-media.js';
import { AUDIT_ACTION,AUDIT_OUTCOME,AUDIT_RETENTION_CLASS,normalizeAuditEvent } from '../../audit/event.js';
import { PLATFORM_AUDIT_ACTION,PLATFORM_AUDIT_OUTCOME,PLATFORM_AUDIT_RETENTION,
  normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedSyntheticExecutionScope } from './protected-runtime-execution-scopes.js';
import { changeTenantStatusWithClient } from './tenant-repository.js';
import { seedTenantBusinessFixtureState } from './business-fixture-state.js';
import { appendPlatformMutationEvidence } from './platform-operations-repository.js';

function denied(code='SYNTHETIC_GENERATION_REPLACEMENT_DENIED') { throw new Error(code); }

function lifecycleEvidence(principal,{ tenantId,generationId,slot,previousState,newState,correlationId,occurredAt }) {
  const metadata={ mode: 'synthetic',generationId,slot,operation: 'generation_replace' };
  return {
    tenantAuditEvent: normalizeAuditEvent({ tenantId,actorUserId: null,action: AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,
      targetType: 'tenant',targetId: tenantId,previousState,newState,metadata,correlationId,occurredAt,
      outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE }),
    platformAuditEvent: normalizePlatformAuditEvent({ operatorId: principal.operatorId,roles: principal.roles,
      permissions: principal.permissions,assuranceLevel: principal.assurance.level,targetTenantId: tenantId,
      action: previousState===null ? PLATFORM_AUDIT_ACTION.TENANT_REGISTRATION_CHANGED : PLATFORM_AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,
      targetType: 'tenant',targetId: tenantId,previousState,newState,metadata,correlationId,occurredAt,
      outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE }),
  };
}

async function writeCatalogueMedia(client,{ tenantId,media,bytes,objectKey,createdAt,createdByUserId }) {
  if (objectKey!==null) throw new TypeError('SYNTHETIC_GENERATION_OBJECT_STORAGE_NOT_PREPARED');
  await client.query({ name: 'synthetic-generation-catalogue-media-insert',text: `INSERT INTO synthetic_catalogue_media_assets
    (tenant_id,id,owner_kind,owner_id,bytes,content_type,byte_length,content_sha256,alt_text,created_at,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,values: [tenantId,media.id,media.ownerKind,media.ownerId,bytes,
    media.contentType,media.byteLength,Buffer.from(media.sha256,'hex'),media.altText,createdAt,createdByUserId] });
}

// Only PostgreSQL byte storage is prepared here. There is deliberately no
// object-storage port/fallback: independently durable upload intents need their
// own reviewed preparation phase before a max1 proof transaction is held.
export function createPostgresSyntheticGenerationRepository(pool,{ environment,securityEpoch,
  tenantAuditRepository,platformAuditRepository,calendarEnabled=false,assuranceMode='application_passkey' }={}) {
  const assurance=syntheticOperationAssurance(assuranceMode);
  if (typeof calendarEnabled!=='boolean' || !pool || typeof pool.connect!=='function' || !['dev','int'].includes(environment)
    || !isInternalUuid(securityEpoch)
    || typeof tenantAuditRepository?.appendWithClient!=='function' || typeof platformAuditRepository?.appendWithClient!=='function') {
    throw new TypeError('SYNTHETIC_GENERATION_REPOSITORY_CONFIGURATION_INVALID');
  }
  const epoch=securityEpoch.toLowerCase(),planner=createSyntheticGenerationPlanner(),mediaSource=createSyntheticTemplateMediaSource();
  const auditRepositories={ tenantAuditRepository,platformAuditRepository };

  async function currentAuthority(client,principal) {
    if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='step_up'
      || principal.assurance.authenticationContext!==assurance.freshContext) denied();
    const result=await client.query({ name: 'synthetic-generation-current-authority',text: `SELECT clock_timestamp() AS now
      FROM platform_operators actor JOIN platform_sessions session ON session.operator_id=actor.id
      JOIN protected_runtime_deployments deployment ON deployment.environment=$1 AND deployment.security_epoch=$2
      WHERE actor.id=$3 AND actor.status='active' AND actor.provider=$4 AND actor.security_version=$5
        AND actor.provider_tenant_reference=$6 AND actor.provider_subject_reference=$7
        AND actor.roles=$8::text[] AND actor.scope_mode=$9 AND session.id=$10 AND session.revoked_at IS NULL
        AND session.expires_at>clock_timestamp() AND session.principal_version=actor.security_version
        AND session.provider=actor.provider AND session.provider_tenant_reference=actor.provider_tenant_reference
        AND session.provider_subject_reference=actor.provider_subject_reference AND session.roles=actor.roles
        AND session.scope_mode=actor.scope_mode AND session.permissions=$11::text[] AND $12=ANY(session.permissions)
        AND session.security_epoch=$13 AND session.assurance_level='step_up' AND session.authentication_context=$15
        AND session.authenticated_at=$14 AND session.step_up_expires_at>clock_timestamp()
        AND ($16::boolean OR (SELECT count(*) FROM platform_passkey_credentials key
          WHERE key.operator_id=actor.id AND key.environment=$1 AND key.revoked_at IS NULL)>=2)
      FOR SHARE OF actor,session,deployment`,values: [environment,epoch,principal.operatorId,PLATFORM_ENTRA_PROVIDER,
    principal.securityVersion,principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,
    principal.roles,principal.targetScope.mode,principal.session.id,principal.permissions,PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
    principal.session.securityEpoch,principal.assurance.authenticatedAt,assurance.freshContext,assuranceMode==='microsoft_mfa'] });
    const now=result.rows[0]?.now;
    if (result.rowCount!==1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) denied();
    createPlatformAuthorizationPolicy({ clock: ()=>now.getTime() }).authorize(principal,PLATFORM_PERMISSION.LIFECYCLE_MANAGE);
    return now;
  }

  async function archive(client,principal,generation,correlationId,now) {
    const rows=await client.query({ name: 'synthetic-generation-owned-tenants',text: `SELECT registry.tenant_id,registry.slot,
      tenant.status,tenant.lifecycle_revision FROM tenant_runtime_registry registry JOIN tenants tenant ON tenant.id=registry.tenant_id
      WHERE registry.environment=$1 AND registry.mode='synthetic' AND registry.operator_id=$2 AND registry.generation_id=$3
      ORDER BY registry.slot FOR UPDATE OF tenant`,values: [environment,principal.operatorId,generation.id] });
    if (rows.rowCount!==3 || new Set(rows.rows.map(row=>row.slot)).size!==3) denied();
    for (const row of rows.rows) {
      const revision=Number(row.lifecycle_revision),tenantId=row.tenant_id;
      requireOwnedSyntheticTenantArchival({ environment,operatorId: principal.operatorId,generationId: generation.id },
        { environment,mode: 'synthetic',operatorId: principal.operatorId,generationId: generation.id,
          tenantId,slot: row.slot,status: row.status,revision });
      if (row.status==='archived') continue;
      const result=await changeTenantStatusWithClient(client,{ tenantId,expectedStatus: row.status,
        expectedRevision: revision,targetStatus: 'archived',changedAt: now });
      if (result.outcome!=='updated') denied();
      await appendPlatformMutationEvidence(client,lifecycleEvidence(principal,{ tenantId,generationId: generation.id,
        slot: row.slot,previousState: { status: row.status,revision },newState: { status: 'archived',revision: result.revision },
        correlationId,occurredAt: now.toISOString() }),tenantId,auditRepositories);
    }
    const archived=await client.query({ name: 'synthetic-generation-archive',text: `UPDATE synthetic_tenant_generations
      SET state='archived',revision=revision+1,archived_at=$4 WHERE environment=$1 AND id=$2 AND operator_id=$3
      AND state IN ('preparing','active') RETURNING id`,values: [environment,generation.id,principal.operatorId,now] });
    if (archived.rowCount!==1) denied();
  }

  async function provision(client,principal,plan,correlationId,now) {
    await client.query({ name: 'synthetic-generation-prepare',text: `INSERT INTO synthetic_tenant_generations
      (environment,id,operator_id,operator_security_version,security_epoch,created_at)
      VALUES($1,$2,$3,$4,$5,$6)`,values: [environment,plan.generationId,principal.operatorId,principal.securityVersion,epoch,now] });
    for (const { business,users,slot } of plan.tenants) {
      await client.query({ name: 'synthetic-generation-tenant-create',text: `INSERT INTO tenants
        (id,display_name,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4)`,values: [business.id,business.displayName,business.lifecycleStatus,now] });
      await client.query({ name: 'synthetic-generation-registry-create',text: `INSERT INTO tenant_runtime_registry
        (environment,tenant_id,mode,generation_id,operator_id,slot,created_at) VALUES($1,$2,'synthetic',$3,$4,$5,$6)`,
      values: [environment,business.id,plan.generationId,principal.operatorId,slot,now] });
      for (const user of users) {
        await client.query({ name: 'synthetic-generation-user-create',text: `INSERT INTO users
          (tenant_id,id,display_name,created_at,updated_at)
          VALUES($1,$2,$3,$4,$4)`,values: [business.id,user.userId,`Synthetic ${user.role}`,now] });
        for (const role of user.roles.filter(role=>role!=='employee')) await client.query({
          name: 'synthetic-generation-user-elevation-create',text: `INSERT INTO tenant_user_roles
            (tenant_id,user_id,role,created_at,updated_at)
            VALUES($1,$2,$3,$4,$4)`,values: [business.id,user.userId,role,now] });
        await client.query({ name: 'synthetic-generation-internal-binding-create',text: `INSERT INTO user_identity_bindings
          (tenant_id,provider,provider_tenant_reference,provider_user_reference,user_id,created_at,updated_at)
          VALUES($1,'platform_delegation',$2,$3,$4,$5,$5)`,
        values: [business.id,plan.generationId,`${principal.operatorId}:${user.role}`,user.userId,now] });
        const event=normalizeAuditEvent({ tenantId: business.id,actorUserId: null,action: AUDIT_ACTION.TENANT_USER_PROVISIONED,
          targetType: 'user',targetId: user.userId,previousState: null,newState: { role: user.role,active: true },
          metadata: { mode: 'synthetic',generationId: plan.generationId,slot },correlationId,occurredAt: now.toISOString(),
          outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE });
        if (!await tenantAuditRepository.appendWithClient(client,event)) denied('TENANT_AUDIT_APPEND_FAILED');
      }
      await appendPlatformMutationEvidence(client,lifecycleEvidence(principal,{ tenantId: business.id,generationId: plan.generationId,
        slot,previousState: null,newState: { status: business.lifecycleStatus,revision: 1 },correlationId,
        occurredAt: now.toISOString() }),business.id,auditRepositories);
    }
    const mapping=new Map(plan.tenants.flatMap(tenant=>tenant.mediaSources.map(media=>[media.assetId,media])));
    async function mediaBytes(media,kind) {
      const mapped=mapping.get(media.id);if (mapped?.kind!==kind) denied('SYNTHETIC_GENERATION_MEDIA_INVALID');
      const source=await mediaSource.read(mapped.sourceAssetId);
      if (source.kind!==kind || source.byteLength!==media.byteLength || source.sha256!==media.sha256) {
        denied('SYNTHETIC_GENERATION_MEDIA_INVALID');
      }
      return source.bytes;
    }
    await seedTenantBusinessFixtureState({ client,fixture: { tenants: plan.tenants.map(tenant=>tenant.business),
      fixedClock: now.toISOString() },roomMediaBytes: media=>mediaBytes(media,'room'),
    catalogueMediaBytes: media=>mediaBytes(media,'catalogue'),writeCatalogueMedia,
    mediaCreatorForTenant: tenantId=>plan.tenants.find(tenant=>tenant.business.id===tenantId)
      ?.users.find(user=>user.role==='tenant_admin') });
    if (calendarEnabled) for (const { business } of plan.tenants) {
      const integrationId=randomUUID();
      await client.query({ name: 'synthetic-generation-calendar-integration',text: `INSERT INTO integrations
        (tenant_id,id,provider,provider_reference,status,created_at,updated_at)
        VALUES($1,$2,'synthetic_calendar',$3,'active',$4,$4)`,
      values: [business.id,integrationId,`synthetic:${plan.generationId}`,now] });
      await client.query({ name: 'synthetic-generation-calendar-resources',text: `INSERT INTO synthetic_calendar_resources
        (environment,security_epoch,tenant_id,generation_id,integration_id,room_id,created_at)
        SELECT $1,$2,$3,$4,$5,id,$6 FROM rooms WHERE tenant_id=$3 AND active=true ORDER BY id`,
      values: [environment,epoch,business.id,plan.generationId,integrationId,now] });
    }
    const activated=await client.query({ name: 'synthetic-generation-activate',text: `UPDATE synthetic_tenant_generations
      SET state='active',revision=revision+1,activated_at=clock_timestamp() WHERE environment=$1 AND id=$2
      AND operator_id=$3 AND state='preparing' RETURNING revision`,values: [environment,plan.generationId,principal.operatorId] });
    if (activated.rowCount!==1) denied();
    return Object.freeze({ generationId: plan.generationId,revision: Number(activated.rows[0].revision),
      tenants: Object.freeze(plan.tenants.map(({ slot,business })=>Object.freeze({ slot,tenantId: business.id,
        displayName: business.displayName,status: business.lifecycleStatus }))) });
  }

  return Object.freeze({
    async replace(input) {
      if (!input || Object.keys(input).sort().join(',')!=='correlationId,intent,principal' || !isInternalUuid(input.correlationId)) {
        throw new TypeError('SYNTHETIC_GENERATION_REPOSITORY_INPUT_INVALID');
      }
      const principal=normalizePlatformPrincipal(input.principal),intent=normalizeSyntheticGenerationIntent(input.intent);
      if (principal.operatorId!==intent.operatorId) denied();
      return withPostgresTransaction(pool,async client=>{
        requireProtectedSyntheticExecutionScope(pool,client,{ environment,securityEpoch: epoch,
          operatorId: principal.operatorId,operatorSecurityVersion: principal.securityVersion });
        const now=await currentAuthority(client,principal);
        const history=await client.query({ name: 'synthetic-generation-retained-owner-history',text: `SELECT
          id,state,revision,created_at,activated_at,archived_at
          FROM synthetic_tenant_generations WHERE environment=$1 AND operator_id=$2
          ORDER BY created_at DESC,id LIMIT 33 FOR UPDATE`,values: [environment,principal.operatorId] });
        if (history.rowCount>=SYNTHETIC_GENERATION_RETENTION_LIMIT) denied('SYNTHETIC_GENERATION_RETENTION_LIMIT');
        if (history.rows.some(row=>[row.created_at,...[row.activated_at,row.archived_at].filter(value=>value!==null)]
          .some(time=>!(time instanceof Date) || !Number.isFinite(time.getTime())
            || now.getTime()-time.getTime()<SYNTHETIC_GENERATION_COOLDOWN_MS))) denied('SYNTHETIC_GENERATION_COOLDOWN');
        const current=history.rows.filter(row=>row.state!=='archived');
        if (current.length>1 || (current.length===0 ? intent.expectedGenerationId!==null
          : current[0].id!==intent.expectedGenerationId || Number(current[0].revision)!==intent.expectedRevision)) {
          denied('SYNTHETIC_GENERATION_STALE');
        }
        if (current.length===1) await archive(client,principal,current[0],input.correlationId,now);
        const plan=planner.create({ environment,securityEpoch: epoch,operatorId: principal.operatorId,
          operatorSecurityVersion: principal.securityVersion,now });
        return provision(client,principal,plan,input.correlationId,now);
      },{ isolationLevel: 'REPEATABLE READ' });
    },
  });
}
