import { createProtectedCustomerStartupFailure } from './protected-customer-startup-diagnostic.js';
import { ApiError } from './api-error.js';
import { loadProtectedCustomerConfiguration } from './protected-customer-config.js';
import { createCustomerComposition } from './customer-composition.js';
import { createProtectedCustomerAuthentication } from './protected-customer-authentication-composition.js';
import { createProtectedCustomerAccessDeliveryWorker } from './protected-customer-access-delivery-composition.js';
import { createFreshCustomerEntraClient } from './identity/entra-client.js';
import { createMicrosoft365Client } from './integrations/microsoft365-client.js';
import { createMicrosoft365CalendarProviderFactory } from './integrations/microsoft365-calendar-provider.js';
import { createProtectedCalendarProviderFactory } from './integrations/protected-calendar-provider-factory.js';
import { createSyntheticCalendarProviderFactory } from './integrations/synthetic-calendar-provider.js';
import { createPostgresSyntheticCalendarRepository } from './persistence/postgres/synthetic-calendar-repository.js';
import { createPostgresSyntheticOnboardingRepository } from './persistence/postgres/synthetic-onboarding-repository.js';
import { createSyntheticOnboardingService } from './application/synthetic-onboarding-service.js';
import { createSyntheticOnboardingRouteModule } from './http/synthetic-onboarding-routes.js';
import { createProtectedTenantRuntimeViewRouteModule } from './http/protected-tenant-runtime-view-routes.js';
import { createProtectedCatalogueMediaRouteModule } from './http/protected-catalogue-media-routes.js';
import { createProtectedCatalogueMediaService } from './application/protected-catalogue-media-service.js';
import { createPostgresProtectedCatalogueMediaRepository } from './persistence/postgres/protected-catalogue-media-repository.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { createAuditService } from './audit/audit-service.js';
import { createPostgresProtectedCalendarAuthorityGuard } from './persistence/postgres/protected-calendar-authority-guard.js';
import { createMicrosoft365CapabilityHealthService } from './application/microsoft365-capability-health-service.js';
import { createPostgresPersistence } from './persistence/postgres/index.js';
import { createPostgresPool } from './persistence/postgres/pool.js';
import { createPostgresProtectedRuntimeReadiness } from './persistence/postgres/protected-runtime-readiness.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresProtectedTenantRuntimeRepository } from './persistence/postgres/protected-tenant-runtime-repository.js';
import { createProtectedTenantProviderGate } from './tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError } from './tenancy/protected-tenant-runtime.js';
import { createProtectedHttpExecutionHandler } from './transport/protected-http-execution.js';
import { loadProtectedHostedFrontend,withProtectedHostedFrontend } from './protected-hosted-frontend.js';
import { createHttpServer } from './server.js';
import { createLogger } from './logger.js';

function realMicrosoftService(service,gate) {
  if (service===null) return null;
  return Object.freeze(Object.fromEntries(Object.entries(service).map(([name,operation])=>{
    if (typeof operation!=='function') throw new TypeError('PROTECTED_CUSTOMER_MICROSOFT_SERVICE_INVALID');
    return [name,input=>{
      if (!input?.principal || input.tenantContext?.tenantId!==input.principal.tenantId) {
        throw new ApiError(403,'RESOURCE_NOT_AVAILABLE');
      }
      // The normal handler owns this principal/context. Keep the complete
      // consent/discovery/verification/mapping/read operation inside current
      // REAL custody; calendar calls have their independently owned selector.
      return gate.run(input.principal.tenantId,()=>operation.call(service,input)).catch(error=>{
        if (error instanceof ProtectedTenantRuntimeError) throw new ApiError(409,'MICROSOFT365_REAL_TENANT_REQUIRED');
        throw error;
      });
    }];
  })));
}

// No supplied session/provider/driver/verifier/clock/handler ports. All real
// protocol and infrastructure constructors are owned here; only explicit
// per-surface deployment configuration crosses this process boundary.
export async function createProtectedCustomerRuntime(environment) {
  let bundle,persistence,leasePool,composition;
  try {
    bundle=loadProtectedCustomerConfiguration(environment);
    const { config,profile,cipher }=bundle,protection={ environment: profile.environment,securityEpoch: profile.securityEpoch };
    const frontend=await loadProtectedHostedFrontend(profile);
    const logger=createLogger();
    const syntheticScope=profile.syntheticEnabled ? { ...protection,platformSecurityEpoch: profile.platformSecurityEpoch,
      customerOrigin: profile.customerOrigin,platformOrigin: profile.platformOrigin } : null;
    const ownerScope=profile.ownerCustomerAccessEnabled ? { ...protection,platformSecurityEpoch: profile.platformSecurityEpoch,
      customerOrigin: profile.customerOrigin,platformOrigin: profile.platformOrigin } : null;
    persistence=createPostgresPersistence(config,{ calendarAuthorityGuardFactory: pool=>
      createPostgresProtectedCalendarAuthorityGuard(pool,{ ...protection,syntheticScope,ownerScope }) });
    leasePool=createPostgresPool(profile.leaseDatabase);
    const base=persistence,readiness=createPostgresProtectedRuntimeReadiness(base.pool,
      { ...protection,leasePool,surface: 'customer' });
    const additionalReadinessChecks=[];
    async function runtimeReady() {
      if (!await readiness.isReady()) return false;
      for (const check of [...base.readinessChecks,...additionalReadinessChecks]) if (await check()!==true) return false;
      return true;
    }
    persistence=Object.freeze({ ...base,readinessChecks: Object.freeze([runtimeReady]) });
    const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...protection,pool: base.pool,leasePool });
    const runtimeRepository=createPostgresProtectedTenantRuntimeRepository(base.pool,{ ...protection,leasePool });
    const realGate=createProtectedTenantProviderGate({ ...protection,repository: runtimeRepository,mode: 'real' });
    const microsoftClient=createFreshCustomerEntraClient({ clientId: config.entraClientId,clientSecret: config.entraClientSecret,
      authority: config.entraAuthority,publicOrigin: config.publicOrigin,includeGroupMembership: true });
    const authentication=createProtectedCustomerAuthentication({ config,persistence,leasePool,...protection,cipher,
      microsoftClient,...bundle.authentication });
    if (authentication.writeCustody!==null) additionalReadinessChecks.push(authentication.writeCustody.isReady);
    const actualGraph=createMicrosoft365Client({ clientId: config.entraClientId,clientSecret: config.entraClientSecret,
      publicOrigin: config.publicOrigin,timeoutMs: config.microsoft365GraphTimeoutMs,allowInsecureLocalhost: false });
    const graph=authentication.writeCustody===null ? actualGraph : authentication.writeCustody.providerClient(actualGraph);
    const executionScopes=authentication.writeCustody===null ? scopes : Object.freeze({
      withShared: work=>scopes.withShared(()=>authentication.writeCustody.run(work)),
    });
    const realFactory=createMicrosoft365CalendarProviderFactory({ connectionRepository: base.microsoft365ConnectionRepository,
      bindingRepository: base.tenantOnboardingRepository,mappingRepository: base.microsoft365RoomMappingRepository,
      providerClient: graph,capabilityHealthService: createMicrosoft365CapabilityHealthService({
        repository: base.microsoft365CapabilityHealthRepository }) });
    const syntheticFactory=profile.syntheticEnabled ? createSyntheticCalendarProviderFactory({
      repository: createPostgresSyntheticCalendarRepository(base.pool,protection) }) : null;
    const calendarProviderFactory=createProtectedCalendarProviderFactory({ ...protection,runtimeRepository,realFactory,syntheticFactory });
    const additionalRouteModules=[...authentication.routeModules,
      createProtectedTenantRuntimeViewRouteModule({ runtimeRepository,...protection }),
      createProtectedCatalogueMediaRouteModule({ service: createProtectedCatalogueMediaService({
        authorizationPolicy: createAuthorizationPolicy(),
        repository: createPostgresProtectedCatalogueMediaRepository(base.pool,{ ...protection,syntheticScope }) }) })];
    if (syntheticScope!==null) {
      const authorizationPolicy=createAuthorizationPolicy();
      const repository=createPostgresSyntheticOnboardingRepository(base.pool,{ scope: syntheticScope,
        auditRepository: base.auditRepository });
      additionalReadinessChecks.push(repository.isReady);
      additionalRouteModules.push(createSyntheticOnboardingRouteModule({ publicOrigin: profile.customerOrigin,
        service: createSyntheticOnboardingService({ authorizationPolicy,repository,
          auditService: createAuditService({ repository: base.auditRepository,authorizationPolicy }) }) }));
    }
    composition=createCustomerComposition({ config,persistence,microsoft365Client: graph,calendarProviderFactory,
      authenticationFactory: authentication.authenticationFactory,additionalRouteModules,logger,
      httpServerFactory: options=>createHttpServer({ ...options,
        microsoft365ConnectionService: realMicrosoftService(options.microsoft365ConnectionService,realGate),
        requestHandlerFactory: app=>withProtectedHostedFrontend({ profile,config,artifact: frontend,
          apiHandler: createProtectedHttpExecutionHandler({ config,surface: 'customer',executionScopes,app }) }),
      }) });
    const worker=bundle.mailProvider===null ? null : createProtectedCustomerAccessDeliveryWorker({ ...protection,
      pool: base.pool,leasePool,cipher,provider: bundle.mailProvider });
    let timer=null,running=null,closed=false,starting=false,started=false,stopping=null,startTask=null;
    function tick() {
      if (closed || running) return;
      running=worker.runOnce().catch(()=>{
        logger.lifecycle({ event: 'customer_access_delivery_unavailable' });
      }).finally(()=>{ running=null; });
    }
    const stop=()=>{
      if (stopping) return stopping;
      closed=true;if (timer!==null) clearInterval(timer);
      stopping=(async()=>{
        let failed=false;
        try {
          if (startTask) await startTask.catch(()=>{});
          try { if (running) await running; }
          finally { await composition.stop(); }
        } catch { failed=true; }
        try { await leasePool.end(); } catch { failed=true; }
        finally { cipher.destroy(); }
        if (failed) throw new Error('PROTECTED_CUSTOMER_RUNTIME_STOP_FAILED');
      })();
      return stopping;
    };
    return Object.freeze({
      start() {
        if (closed || starting || started) return Promise.reject(new Error('PROTECTED_CUSTOMER_RUNTIME_STATE_INVALID'));
        starting=true;
        startTask=(async()=>{
          if (!await runtimeReady()) throw new Error('PROTECTED_CUSTOMER_RUNTIME_NOT_READY');
          if (closed) throw new Error('PROTECTED_CUSTOMER_RUNTIME_STATE_INVALID');
          const address=await composition.start();started=true;
          if (closed) throw new Error('PROTECTED_CUSTOMER_RUNTIME_STATE_INVALID');
          if (worker!==null) { timer=setInterval(tick,1000);timer.unref(); }
          return address;
        })().finally(()=>{ starting=false; });
        return startTask.catch(async error=>{
          await stop();throw createProtectedCustomerStartupFailure('PROTECTED_CUSTOMER_RUNTIME_START_FAILED',error);
        });
      },
      stop,
    });
  } catch (error) {
    await Promise.allSettled([composition ? composition.stop() : persistence?.close(),leasePool?.end()]);
    bundle?.cipher.destroy();
    throw createProtectedCustomerStartupFailure('PROTECTED_CUSTOMER_RUNTIME_CONFIGURATION_INVALID',error);
  }
}
