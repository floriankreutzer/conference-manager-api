import { randomUUID } from 'node:crypto';
import { loadProtectedPlatformConfiguration } from './protected-platform-config.js';
import { createPlatformComposition } from './platform-composition.js';
import { createPostgresPlatformPersistence } from './persistence/postgres/platform-index.js';
import { createPostgresPool } from './persistence/postgres/pool.js';
import { createPostgresProtectedRuntimeReadiness } from './persistence/postgres/protected-runtime-readiness.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresProtectedPlatformCustomerOnboardingRepository }
  from './persistence/postgres/platform-protected-customer-onboarding-repository.js';
import { createPostgresProtectedPlatformCustomerInvitationRepository }
  from './persistence/postgres/platform-protected-customer-invitation-repository.js';
import { createPostgresSyntheticGenerationRepository } from './persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticGenerationDirectoryRepository }
  from './persistence/postgres/platform-synthetic-generation-directory-repository.js';
import { createPostgresSyntheticHandoffRepository } from './persistence/postgres/platform-synthetic-handoff-repository.js';
import { createPlatformOperationEvidenceFactory } from './persistence/postgres/platform-operations-evidence.js';
import { createPlatformAuthorizationPolicy } from './platform/identity/policy.js';
import { createPlatformTenantTargetPolicy } from './platform/identity/tenant-target-policy.js';
import { createAuditService } from './audit/audit-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { normalizeCustomerInvitationIntent,normalizeCustomerInvitationBatch } from './authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from './application/customer-invitation-result.js';
import { createCustomerAccessEmailContent } from './integrations/customer-access-email-content.js';
import { createPlatformCustomerOnboardingService } from './platform/application/customer-onboarding-service.js';
import { createPlatformCustomerInvitationAdministrationService }
  from './platform/application/customer-invitation-administration-service.js';
import { createSyntheticGenerationService } from './platform/application/synthetic-generation-service.js';
import { createSyntheticGenerationProtocol } from './platform/application/synthetic-generation-protocol.js';
import { createSyntheticHandoffService } from './platform/application/synthetic-handoff-service.js';
import { createSyntheticHandoffProtocol } from './platform/application/synthetic-handoff-protocol.js';
import { createSyntheticHandoffBrowserBinding } from './identity/synthetic-handoff-browser-binding.js';
import { createPlatformSyntheticHandoffIntentCookie } from './platform/identity/synthetic-handoff-intent-cookie.js';
import { createPlatformSyntheticGenerationRouteModule } from './platform/http/synthetic-generation-routes.js';
import { createPlatformSyntheticHandoffRouteModule } from './platform/http/synthetic-handoff-routes.js';
import { createPlatformTenantRoutes } from './platform/http/tenant-routes.js';
import { protectPlatformPasskeyRoute } from './platform/http/passkey-operation-route.js';
import { protectPlatformMicrosoftRoute } from './platform/http/microsoft-operation-route.js';
import { PLATFORM_OPERATIONAL_ROUTE_MODULES } from './platform/app.js';
import { platformHealthRoutes } from './platform/http/health-routes.js';
import { platformSessionRoutes } from './platform/http/session-routes.js';
import { createPlatformHttpServer } from './platform/server.js';
import { protectedPlatformExecutionBoundary } from './platform/http/protected-execution-boundary.js';
import { createProtectedHttpExecutionHandler } from './transport/protected-http-execution.js';
import { loadProtectedHostedFrontend,withProtectedHostedFrontend } from './protected-hosted-frontend.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { assertPlatformRouteKey } from './platform/http/observability.js';
import { createPlatformInsightService } from './platform/application/insight-service.js';
import { createPlatformInsightRoutes } from './platform/http/insight-routes.js';

function syntheticRoutes(bundle,persistence,authentication,authorizationPolicy,disposables) {
  if (bundle.synthetic===null) return [];
  const { profile }=bundle,protection={ environment: profile.environment,securityEpoch: profile.securityEpoch };
  const passkeyService=authentication.syntheticPasskeyService;
  if (!passkeyService) throw new TypeError('PROTECTED_PLATFORM_SYNTHETIC_AUTHENTICATION_REQUIRED');
  const scope={ ...protection,platformSecurityEpoch: profile.platformSecurityEpoch,
    customerOrigin: profile.customerOrigin,platformOrigin: profile.platformOrigin };
  const browserBinding=createSyntheticHandoffBrowserBinding({ scope,secret: bundle.synthetic.browserSecret });
  const intentCookie=createPlatformSyntheticHandoffIntentCookie({ scope,secret: bundle.synthetic.intentSecret });
  disposables.push(()=>browserBinding.destroy(),()=>intentCookie.destroy());
  const generationService=createSyntheticGenerationService({ ...protection,passkeyService,authorizationPolicy,
    repository: createPostgresSyntheticGenerationRepository(persistence.pool,{ ...protection,calendarEnabled: true,
      tenantAuditRepository: persistence.tenantAuditRepository,platformAuditRepository: persistence.auditRepository }) });
  const directory=createPostgresSyntheticGenerationDirectoryRepository(persistence.pool,
    { ...protection,platformSecurityEpoch: profile.platformSecurityEpoch });
  const generationProtocol=createSyntheticGenerationProtocol({ generationService,directory,passkeyService,
    withPreparationScope: authentication.withPreparationScope });
  const handoffService=createSyntheticHandoffService({ scope,passkeyService,authorizationPolicy,browserBinding,
    repository: createPostgresSyntheticHandoffRepository(persistence.pool,{ scope,browserBinding,
      platformAuditRepository: persistence.auditRepository }) });
  return [createPlatformSyntheticGenerationRouteModule({ protocol: generationProtocol,scope: {
    ...protection,platformOrigin: profile.platformOrigin,platformSecurityEpoch: profile.platformSecurityEpoch } }),
  createPlatformSyntheticHandoffRouteModule({ scope,intentCookie,protocol: createSyntheticHandoffProtocol({ handoffService,
    passkeyService,withPreparationScope: authentication.withPreparationScope }) })];
}

// Closed process owner. No external authentication, grant issuer, fallback,
// repository, verifier, driver, provider or handler implementation is accepted.
export async function createProtectedPlatformRuntime(environment) {
  let bundle,persistence,leasePool,composition;const disposables=[];
  try {
    bundle=loadProtectedPlatformConfiguration(environment);
    const { profile,config,cipher }=bundle,protection={ environment: profile.environment,securityEpoch: profile.securityEpoch };
    const frontend=await loadProtectedHostedFrontend(profile);
    persistence=createPostgresPlatformPersistence(config,{ protectedRuntime: protection });
    leasePool=createPostgresPool(profile.leaseDatabase);const base=persistence;
    const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...protection,pool: base.pool,leasePool });
    const readiness=createPostgresProtectedRuntimeReadiness(base.pool,{ ...protection,leasePool,surface: 'platform' });
    // Periodic durable projection work uses no persistent LISTEN connection on
    // the bounded business pool, preserving max1 business/lease configurations.
    persistence=Object.freeze({ ...base,readinessChecks: Object.freeze([readiness.isReady,
      ()=>base.auditRepository.isReady()]),projectionRepository: Object.freeze({
      refreshBatch: input=>base.projectionRepository.refreshBatch(input),
      consumeBatch: input=>base.projectionRepository.consumeBatch(input),
    }) });
    const authentication=bundle.authenticationFactory({ pool: base.pool,leasePool });
    const platformAuthorizationPolicy=createPlatformAuthorizationPolicy();
    const tenantTargetPolicy=createPlatformTenantTargetPolicy({ operatorRepository: base.operatorRepository });
    const operationEvidenceFactory=createPlatformOperationEvidenceFactory({
      tenantAuditService: createAuditService({ repository: base.tenantAuditRepository,authorizationPolicy: createAuthorizationPolicy() }),
      platformAuditService: authentication.platformAuditService });
    const invitationContract=Object.freeze({ normalizeIntent: normalizeCustomerInvitationIntent,
      normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations });
    const common={ platformAuthorizationPolicy,tenantTargetPolicy,operationEvidenceFactory,invitationContract,
      environment: profile.environment };
    const custody={ ...protection,cipher,content: createCustomerAccessEmailContent({ environment: profile.environment,
      publicOrigin: profile.customerOrigin }),tenantAuditRepository: base.tenantAuditRepository,
      platformAuditRepository: base.auditRepository };
    const onboarding=createPlatformCustomerOnboardingService({ ...common,ownerRecipient: bundle.ownerRecipient,
      ownerLocale: bundle.ownerLocale,idFactory: randomUUID,
      repository: createPostgresProtectedPlatformCustomerOnboardingRepository(base.pool,custody) });
    const invitations=createPlatformCustomerInvitationAdministrationService({ ...common,
      repository: createPostgresProtectedPlatformCustomerInvitationRepository(base.pool,custody) });
    const active=['application_passkey','microsoft_mfa'].includes(config.assuranceMode);
    const tenantRoutes=createPlatformTenantRoutes({ invitationAdministration: true });
    const operational=active ? PLATFORM_OPERATIONAL_ROUTE_MODULES.map(module=>{
      const selected=module.id===tenantRoutes.id ? tenantRoutes : module;
      const protect=config.assuranceMode==='microsoft_mfa' ? protectPlatformMicrosoftRoute : protectPlatformPasskeyRoute;
      return protect(selected,{ authService: config.assuranceMode==='microsoft_mfa'
        ? authentication.normalMicrosoftService : authentication.normalPasskeyService,
      environment: profile.environment,securityEpoch: profile.platformSecurityEpoch });
    }) : [platformHealthRoutes,platformSessionRoutes];
    const insights=active ? [createPlatformInsightRoutes(createPlatformInsightService({
      sources: bundle.insightSources,authorizationPolicy: platformAuthorizationPolicy }))] : [];
    const routeModules=Object.freeze([...authentication.routeModules,...operational,...insights,
      ...syntheticRoutes(bundle,persistence,authentication,platformAuthorizationPolicy,disposables)]);
    composition=createPlatformComposition({ config,persistence,routeModules,projectionEnabled: active,
      metrics: createMetricsRegistry({ assertRouteKey: assertPlatformRouteKey }),
      authenticationFactory(context) {
        if (context?.config!==config || context?.persistence!==persistence) throw new TypeError('PROTECTED_PLATFORM_CONTEXT_INVALID');
        return authentication;
      },
      projectionRunGate: work=>scopes.withShared(async()=>{
        if (!await readiness.isReady()) throw new Error('PROTECTED_PLATFORM_PROJECTION_NOT_READY');return work();
      }),
      httpServerFactory: options=>createPlatformHttpServer({ ...options,
        platformCustomerOnboardingService: onboarding,platformCustomerInvitationAdministrationService: invitations,
        requestHandlerFactory: app=>withProtectedHostedFrontend({ profile,config,artifact: frontend,
          apiHandler: createProtectedHttpExecutionHandler({ config,surface: 'platform',executionScopes: scopes,app,
            platformBoundary: protectedPlatformExecutionBoundary }) }),
      }) });
    let closed=false,started=false,starting=false,startTask=null,stopping=null;
    const stop=()=>{
      if (stopping) return stopping;closed=true;
      stopping=(async()=>{
        let failed=false;
        try { if (startTask) await startTask.catch(()=>{});await composition.stop(); } catch { failed=true; }
        try { await leasePool.end(); } catch { failed=true; }
        finally { for (const dispose of disposables) dispose();cipher.destroy(); }
        if (failed) throw new Error('PROTECTED_PLATFORM_RUNTIME_STOP_FAILED');
      })();return stopping;
    };
    return Object.freeze({ start() {
      if (closed || started || starting) return Promise.reject(new Error('PROTECTED_PLATFORM_RUNTIME_STATE_INVALID'));
      starting=true;
      startTask=(async()=>{
        if (!await readiness.isReady() || closed) throw new Error('PROTECTED_PLATFORM_RUNTIME_NOT_READY');
        const address=await composition.start();started=true;
        if (closed) throw new Error('PROTECTED_PLATFORM_RUNTIME_STATE_INVALID');return address;
      })().finally(()=>{ starting=false; });
      return startTask.catch(async()=>{ await stop();throw new Error('PROTECTED_PLATFORM_RUNTIME_START_FAILED'); });
    },stop });
  } catch {
    await Promise.allSettled([composition ? composition.stop() : persistence?.close(),leasePool?.end()]);
    for (const dispose of disposables) dispose();bundle?.cipher.destroy();
    throw new Error('PROTECTED_PLATFORM_RUNTIME_CONFIGURATION_INVALID');
  }
}
