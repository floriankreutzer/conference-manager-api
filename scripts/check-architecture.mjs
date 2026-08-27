import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current);
  }
  return files;
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const runtimeDependencies = packageJson.dependencies || {};
const approvedRuntimeDependencies = {
  '@azure/msal-node': '5.4.3',
  pg: '8.23.0',
};
if (JSON.stringify(runtimeDependencies) !== JSON.stringify(approvedRuntimeDependencies)) {
  throw new Error('Runtime dependencies must remain exactly the reviewed PostgreSQL and Microsoft identity adapters.');
}

const files = await sourceFiles('src');
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (file !== 'src/config.js' && /process\.env/.test(content)) {
    throw new Error(`${file} accesses process.env directly; runtime configuration belongs in src/config.js.`);
  }
  if (/from ['"](?:node:)?(?:fs|child_process|vm)['"]/.test(content)) {
    throw new Error(`${file} imports a privileged runtime module outside the approved foundation.`);
  }
  if (/https?:\/\//.test(content) && file !== 'src/config.js') {
    throw new Error(`${file} contains a hard-coded outbound URL; provider destinations require an approved integration boundary.`);
  }
  if (/x-tenant-id|x-tenant-context/i.test(content)) {
    throw new Error(`${file} introduces a client-controlled tenant header into the trusted runtime.`);
  }
  if (/\b(?:localStorage|sessionStorage)\b/.test(content)) {
    throw new Error(`${file} introduces browser storage into the trusted backend/session boundary.`);
  }
  if (/from ['"]pg['"]/.test(content) && !file.startsWith('src/persistence/postgres/')) {
    throw new Error(`${file} imports the database driver outside the PostgreSQL infrastructure adapter boundary.`);
  }
  if (/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(content) && !file.startsWith('src/persistence/postgres/')) {
    throw new Error(`${file} contains SQL outside the PostgreSQL infrastructure adapter boundary.`);
  }
}

const app = await readFile('src/app.js', 'utf8');
for (const route of [
  "'/api/v1/health/live'",
  "'/api/v1/health/ready'",
  "'/api/v1/auth/microsoft/login'",
  "'/api/v1/auth/microsoft/callback'",
  "'/api/v1/onboarding/invitations/start'",
  "'/api/v1/onboarding/claim'",
  "'/api/v1/session'",
]) {
  if (!app.includes(route)) throw new Error(`Required route contract is missing: ${route}.`);
}
for (const routeModule of [
  'tenantAuditQueryRouteModule',
  'tenantUserLifecycleRouteModule',
  'tenantCapabilityViewRouteModule',
  'tenantPresentationRouteModule',
  'tenantOrganizationRouteModule',
  'tenantLocationRoutes',
  'tenantCatalogueRouteModule',
  'tenantBookingPolicyRoutes',
  'tenantCostAllocationRoutes',
]) {
  if (!app.includes(routeModule)) {
    throw new Error(`Integrated Tenant administration route registry is missing ${routeModule}.`);
  }
}
if (!app.includes('TENANT_ROUTE_REGISTRY.createDispatcher')) {
  throw new Error('Tenant routes must dispatch through the bounded module registry.');
}
if (!app.includes('createPrincipalGuard') || !app.includes('assertSameOrigin') || !app.includes('createRateLimiter')) {
  throw new Error('Required API security boundaries are not composed in src/app.js.');
}
if (!app.includes('entraAuthService.start') || !app.includes('entraAuthService.complete')) {
  throw new Error('Microsoft authentication routes must delegate to the Entra authentication service.');
}
for (const required of [
  'readEntraTransactionCookie',
  'entraAuthService.clearCookie',
  'browserBinding,',
]) {
  if (!app.includes(required)) {
    throw new Error(`Microsoft callback must preserve initiating-browser binding contract ${required}.`);
  }
}
for (const required of [
  'readTenantClaimCookie',
  'onboardingService.beginInvitation',
  'onboardingService.claimStatus',
  'onboardingService.confirmClaim',
  "request.headers['x-csrf-token']",
  "'/onboarding?auth=confirm'",
]) {
  if (!app.includes(required)) {
    throw new Error(`Tenant onboarding HTTP contract is missing ${required}.`);
  }
}
if (app.includes("searchParams.get('tenantId')") || app.includes("searchParams.get('tid')")) {
  throw new Error('Microsoft authentication routes must not accept browser-selected Tenant authority.');
}
if (/ONBOARDING_[A-Z_]+_BODY_SCHEMA[\s\S]{0,1000}\btenantId\b/.test(app)) {
  throw new Error('Tenant onboarding request schemas must not accept browser-selected Tenant authority.');
}
if (!app.includes("'/?auth=authentication_failed'") || !app.includes("'/?auth=tenant_onboarding_required'")) {
  throw new Error('Authentication callbacks must use fixed same-origin result redirects.');
}
if (!app.includes('createTenantContextGuard') || !app.includes('tenantGuard.requireKnown(principal)')) {
  throw new Error('Protected session context must resolve the tenant from the authenticated principal.');
}
if (!app.includes('tenantGuard.requireActive(principal)') || !app.includes('requestService.transitionRequest')) {
  throw new Error('Tenant business requests must require active Tenant context and the authorized application service.');
}
if (!app.includes('sessionService?.resolvePrincipal') || !app.includes('sessionService?.verifyCsrf')) {
  throw new Error('HTTP principal and CSRF resolution must use the server-side session service when configured.');
}
if (!app.includes("request.method === 'DELETE'") || !app.includes('sessionService.revoke(principal,')) {
  throw new Error('Session logout must revoke the authenticated server-side session with request correlation.');
}
const tenantAuditRoutes = await readFile('src/http/tenant-audit-query-routes.js', 'utf8');
if (
  !tenantAuditRoutes.includes("const AUDIT_PATH = '/api/v1/audit'")
  || !tenantAuditRoutes.includes('tenantAuditQueryService.listEvents')
  || !tenantAuditRoutes.includes('correlationId: requestId')
) {
  throw new Error('Tenant audit reads must use the bounded audit query service and server request correlation.');
}
if (app.includes('tenantId: parsedUrl')) {
  throw new Error('Audit API must not accept client-selected Tenant authority.');
}
if (!app.includes('readJsonObjectBody') || !app.includes('validateExactObject')) {
  throw new Error('State-changing request routes must keep positive-schema bounded JSON validation.');
}
if (/requesterUserId:\s*.*body|tenantId:\s*.*body|nextStatus:\s*.*body/i.test(app)) {
  throw new Error('HTTP input must not supply request ownership, Tenant authority, or target workflow status.');
}

const tenantContext = await readFile('src/tenancy/tenant-context.js', 'utf8');
if (!tenantContext.includes('loadTenant(principal.tenantId)')) {
  throw new Error('Tenant context must load the internal tenant ID from the authenticated principal.');
}
if (/request\.|headers|searchParams|queryParam/i.test(tenantContext)) {
  throw new Error('Tenant context must not derive authority from request-controlled routing or headers.');
}

const tenantRepository = await readFile('src/tenancy/tenant-scoped-repository.js', 'utf8');
for (const method of [
  'findByTenantIdAndId',
  'listByTenantId',
  'insertForTenant',
  'updateByTenantIdAndId',
  'deleteByTenantIdAndId',
]) {
  if (!tenantRepository.includes(method)) {
    throw new Error(`Tenant repository contract is missing scoped adapter method ${method}.`);
  }
}
if (/\.findById\(|\.updateById\(|\.deleteById\(/.test(tenantRepository)) {
  throw new Error('Tenant repository must not expose unscoped object access methods.');
}

const tenantModel = await readFile('src/tenancy/tenant.js', 'utf8');
for (const resourceType of [
  'user',
  'site',
  'room',
  'service',
  'request',
  'notification',
  'integration',
  'entitlement',
  'booking_provider_reference',
  'tenant_onboarding_invitation',
  'tenant_identity_binding',
  'user_identity_binding',
  'audit_event',
]) {
  if (!tenantModel.includes(`'${resourceType}'`)) {
    throw new Error(`Tenant ownership inventory is missing ${resourceType}.`);
  }
}

const authorizationPolicy = await readFile('src/authorization/policy.js', 'utf8');
for (const required of [
  'PERMISSION_NOT_AUTHORIZED',
  'ROLE_NOT_AUTHORIZED',
  'request.requesterUserId !== principal.userId',
  'TENANT_ROLE.CONFERENCE_MANAGER',
  'TENANT_ROLE.TENANT_ADMIN',
  "TENANT_AUDIT_READ: 'tenant:audit:read'",
  'authorizeBookingOperation',
  'BOOKING_OPERATION',
]) {
  if (!authorizationPolicy.includes(required)) {
    throw new Error(`Authorization policy is missing deny-by-default invariant ${required}.`);
  }
}
if (authorizationPolicy.includes("PLATFORM_ADMIN: 'platform_admin'")) {
  throw new Error('Platform Admin must remain outside the Tenant authorization role model.');
}

const requestService = await readFile('src/application/request-service.js', 'utf8');
if (!requestService.includes('authorizationPolicy.authorizeRequestRead')) {
  throw new Error('Request reads must pass through the central authorization policy.');
}
if (!requestService.includes('authorizationPolicy.authorizeRequestTransition')) {
  throw new Error('Request workflow changes must pass through the central authorization policy.');
}
if (!requestService.includes('expectedStatus: decision.expectedStatus')) {
  throw new Error('Authorized workflow writes must preserve optimistic status concurrency.');
}
if (!requestService.includes('auditService.createEvent') || !requestService.includes('auditEvent,')) {
  throw new Error('Request transitions must carry a server-generated audit event into persistence.');
}
if (!requestService.includes('synchronizeCancellation')) {
  throw new Error('Confirmed booking cancellation must retain external calendar reconciliation semantics.');
}

const auditEvent = await readFile('src/audit/event.js', 'utf8');
for (const required of [
  'FORBIDDEN_KEY',
  'canonicalAuditPayload',
  'retentionClass',
  'correlationId',
  'TENANT_ONBOARDING_INVITED',
  'TENANT_IDENTITY_CLAIMED',
  'TENANT_IDENTITY_UNBOUND',
  'TENANT_USER_PROVISIONED',
  'TENANT_USER_PROFILE_UPDATED',
  'INTEGRATION_CONNECTED',
  'INTEGRATION_DISCONNECTED',
  'INTEGRATION_ADMIN_CONSENT_CHANGED',
  'INTEGRATION_VERIFIED',
]) {
  if (!auditEvent.includes(required)) throw new Error(`Audit event contract is missing ${required}.`);
}

const auditService = await readFile('src/audit/audit-service.js', 'utf8');
for (const required of ['PERMISSION.TENANT_AUDIT_READ', 'verifyTenantChain', 'recordAuthorizationDenied']) {
  if (!auditService.includes(required)) throw new Error(`Audit service is missing ${required}.`);
}

const persistence = await readFile('src/persistence/postgres/index.js', 'utf8');
for (const required of [
  'isPostgresSchemaReady',
  'createPostgresTenantRepository',
  'createPostgresSessionRepository',
  'createPostgresRequestRepository',
  'createPostgresAuditRepository',
  'createPostgresEntitlementRepository',
  'createPostgresBookingReferenceRepository',
  'createPostgresOidcTransactionRepository',
  'createPostgresTenantOnboardingRepository',
  'createPostgresJitUserRepository',
  'createPostgresMicrosoft365ConnectionRepository',
  'createPostgresMicrosoft365RoomMappingRepository',
  'createPostgresMicrosoft365CapabilityHealthRepository',
  'createPostgresTenantLocationRepository',
  'createPostgresTenantOrganizationRepository',
  'createPostgresTenantCatalogueRepository',
  'createPostgresTenantBookingPolicyRepository',
  'createPostgresTenantCostAllocationRepository',
  'createPostgresTenantAuditQueryRepository',
  'createPostgresTenantUserLifecycleRepository',
  'auditRepository',
  'entitlementRepository',
  'bookingReferenceRepository',
  'oidcTransactionRepository',
  'tenantOnboardingRepository',
  'jitUserRepository',
  'microsoft365ConnectionRepository',
  'microsoft365RoomMappingRepository',
  'microsoft365CapabilityHealthRepository',
  'tenantLocationRepository',
  'tenantOrganizationRepository',
  'tenantCatalogueRepository',
  'tenantBookingPolicyRepository',
  'tenantCostAllocationRepository',
  'tenantAuditQueryRepository',
  'tenantUserLifecycleRepository',
]) {
  if (!persistence.includes(required)) throw new Error(`PostgreSQL persistence is missing ${required}.`);
}

const requestRepository = await readFile('src/persistence/postgres/request-repository.js', 'utf8');
if (!requestRepository.includes('WHERE tenant_id = $1') || !requestRepository.includes('AND status = $3')) {
  throw new Error('Request persistence must scope object access by Tenant and protect workflow writes against stale status.');
}
if (!requestRepository.includes('normalizeRequest')) {
  throw new Error('Request persistence must validate database output through the canonical domain contract.');
}
if (!requestRepository.includes('appendWithClient(client, auditEvent)')) {
  throw new Error('Successful Request transitions must append audit evidence in the same database transaction.');
}
for (const required of [
  'request-revision-watermark:${tenantId}',
  'request-revision-watermark:${request.tenantId}',
  'RETURNING revision_sequence',
  'SET current_revision_sequence = $3',
  'request.current_revision_sequence <=',
  'request.current_revision_sequence >',
]) {
  if (!requestRepository.includes(required)) {
    throw new Error(`Request persistence is missing durable revision watermark invariant ${required}.`);
  }
}

const auditRepository = await readFile('src/persistence/postgres/audit-repository.js', 'utf8');
for (const required of [
  "createHmac('sha256'",
  'pg_advisory_xact_lock',
  'previous_hash',
  'event_hash',
  'verifyTenantChain',
  'timingSafeEqual',
]) {
  if (!auditRepository.includes(required)) throw new Error(`Audit persistence is missing ${required}.`);
}

const principal = await readFile('src/identity/principal.js', 'utf8');
if (!principal.includes('providerIdentity') || !principal.includes('permissions') || !principal.includes('session')) {
  throw new Error('Internal principal contract must remain provider-neutral and carry session metadata.');
}

const sessionCookie = await readFile('src/identity/session-cookie.js', 'utf8');
for (const required of ['HttpOnly', 'SameSite=Lax', 'Path=/api', 'Secure']) {
  if (!sessionCookie.includes(required)) throw new Error(`Session cookie contract is missing ${required}.`);
}
if (sessionCookie.includes('Domain=')) throw new Error('Session cookie must not set a broad Domain attribute.');

const entraTransactionCookie = await readFile('src/identity/entra-transaction-cookie.js', 'utf8');
for (const required of [
  "'cm_oidc_tx'",
  "'HttpOnly'",
  "'SameSite=Lax'",
  "'Secure'",
  "'/api/v1/auth/microsoft/callback'",
  'Max-Age=',
]) {
  if (!entraTransactionCookie.includes(required)) {
    throw new Error(`Entra transaction cookie contract is missing ${required}.`);
  }
}
if (entraTransactionCookie.includes('Domain=')) {
  throw new Error('Entra transaction cookie must not set a broad Domain attribute.');
}

const claimCookie = await readFile('src/onboarding/claim-cookie.js', 'utf8');
for (const required of [
  "'cm_tenant_claim'",
  "'HttpOnly'",
  "'SameSite=Strict'",
  "'Secure'",
  "'/api/v1/onboarding/claim'",
  'Max-Age=',
]) {
  if (!claimCookie.includes(required)) {
    throw new Error(`Tenant claim cookie contract is missing ${required}.`);
  }
}
if (claimCookie.includes('Domain=')) throw new Error('Tenant claim cookie must not set a broad Domain attribute.');

const sessionService = await readFile('src/identity/session-service.js', 'utf8');
for (const required of [
  'randomBytes(32)',
  "createHash('sha256')",
  "createHmac('sha256'",
  'timingSafeEqual',
  'AUDIT_ACTION.SESSION_ISSUED',
  'AUDIT_ACTION.SESSION_REVOKED',
  'AUDIT_ACTION.SESSION_ROTATED',
]) {
  if (!sessionService.includes(required)) throw new Error(`Session service is missing security/audit primitive ${required}.`);
}
if (/localStorage|sessionStorage/i.test(sessionService)) {
  throw new Error('Session service must not depend on browser token storage.');
}

const sessionRepository = await readFile('src/persistence/postgres/session-repository.js', 'utf8');
if (!sessionRepository.includes('u.security_version = s.principal_version')) {
  throw new Error('Session resolution must invalidate stale privilege snapshots via security_version.');
}
if (!sessionRepository.includes('s.revoked_at IS NULL') || !sessionRepository.includes('s.expires_at > $2')) {
  throw new Error('Session resolution must enforce revocation and expiration.');
}
if (!sessionRepository.includes('appendAudit(client, auditRepository, auditEvent)')) {
  throw new Error('Session mutations must append audit evidence inside their database transaction.');
}

const entraClient = await readFile('src/identity/entra-client.js', 'utf8');
for (const required of [
  'ConfidentialClientApplication',
  'msal.getAuthCodeUrl',
  'msal.acquireTokenByCode',
  "codeChallengeMethod: 'S256'",
  'claims.aud !== clientId',
  'claims.iss !== expectedIssuer',
  'secureHashMatch(claims.nonce',
  'tenantReference',
  'userReference',
]) {
  if (!entraClient.includes(required)) throw new Error(`Entra adapter is missing validation boundary ${required}.`);
}
if (/\b(?:groups|roles|email)\b/i.test(entraClient)) {
  throw new Error('Entra authentication adapter must not infer application authorization from provider group/role/email claims.');
}

const entraAuthService = await readFile('src/identity/entra-auth-service.js', 'utf8');
for (const required of [
  "createHash('sha256')",
  "createHmac('sha256'",
  'pkceChallenge',
  'browserBinding(secret, state)',
  'safeTokenEqual',
  'serializeEntraTransactionCookie',
  'serializeClearedEntraTransactionCookie',
  'onboardingInvitationId',
  'repository.consume',
  'identityResolver.resolve',
  'sessionService.issue',
]) {
  if (!entraAuthService.includes(required)) {
    throw new Error(`Entra authentication service is missing protocol/session invariant ${required}.`);
  }
}
const browserBindingCheck = entraAuthService.indexOf('safeTokenEqual(presentedBinding');
const oidcStateConsume = entraAuthService.indexOf('const transaction = await repository.consume({');
if (browserBindingCheck < 0 || oidcStateConsume < 0 || browserBindingCheck > oidcStateConsume) {
  throw new Error('Entra browser binding must be validated before shared OIDC state is consumed.');
}

const identityResolver = await readFile('src/identity/provider-identity-resolver.js', 'utf8');
for (const required of [
  'onboardingInvitationId',
  'onboardingService.prepareClaim',
  'jitUserService.resolve',
  "status: 'onboarding_required'",
]) {
  if (!identityResolver.includes(required)) {
    throw new Error(`Provider identity resolver is missing identity-routing invariant ${required}.`);
  }
}

const oidcRepository = await readFile('src/persistence/postgres/oidc-transaction-repository.js', 'utf8');
for (const required of [
  'DELETE FROM oidc_auth_transactions',
  'WHERE provider = $1',
  'AND state_hash = $2',
  'AND expires_at > $3',
  'RETURNING nonce_hash, onboarding_invitation_id',
]) {
  if (!oidcRepository.includes(required)) throw new Error(`OIDC transaction repository is missing replay invariant ${required}.`);
}

const onboardingService = await readFile('src/onboarding/tenant-onboarding-service.js', 'utf8');
for (const required of [
  'authorizeOperator = async () => false',
  "createHash('sha256')",
  "createHmac('sha256'",
  'timingSafeEqual',
  'claimCsrf',
  'repository.confirmClaim',
  'AUDIT_ACTION.TENANT_ONBOARDING_INVITED',
  'AUDIT_ACTION.TENANT_IDENTITY_CLAIMED',
  'AUDIT_ACTION.TENANT_IDENTITY_UNBOUND',
]) {
  if (!onboardingService.includes(required)) {
    throw new Error(`Tenant onboarding service is missing security invariant ${required}.`);
  }
}

const onboardingRepository = await readFile('src/persistence/postgres/tenant-onboarding-repository.js', 'utf8');
for (const required of [
  'withPostgresTransaction',
  'tenant_onboarding_invitations',
  'tenant_identity_bindings',
  'tenant_claim_transactions',
  'appendWithClient(client, auditEvent)',
  "status IN ('pending', 'onboarding')",
  "status IN ('pending', 'onboarding', 'ready')",
]) {
  if (!onboardingRepository.includes(required)) {
    throw new Error(`Tenant onboarding persistence is missing invariant ${required}.`);
  }
}

const config = await readFile('src/config.js', 'utf8');
for (const required of [
  'AUDIT_HMAC_SECRET_REQUIRED',
  'auditHmacSecret',
  'ENTRA_AUTHORITY',
  'ENTRA_CLIENT_ID_REQUIRED',
  'ENTRA_CLIENT_SECRET_REQUIRED',
  'OIDC_TRANSACTION_SECRET_REQUIRED',
  'APPROVED_OUTBOUND_ORIGINS',
  "microsoftIdentity: 'https://login.microsoftonline.com'",
  "microsoftGraph: 'https://graph.microsoft.com'",
  'MICROSOFT365_CONSENT_TTL_SECONDS',
  'MICROSOFT365_GRAPH_TIMEOUT_MS',
]) {
  if (!config.includes(required)) throw new Error(`Pilot/Production configuration is missing ${required}.`);
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!/export const CURRENT_SCHEMA_VERSION = 27;/.test(pool)) {
  throw new Error('Runtime schema readiness must require Request composition migration version 27.');
}
const requestCompositionMigration = await readFile(
  'migrations/027_request_composition_v2.up.sql',
  'utf8',
);
for (const required of [
  'tenant_room_prices',
  'FOREIGN KEY (tenant_id, room_id)',
  'request_snapshot IS NOT NULL',
  'request_revisions_append_only',
  'revision_sequence BIGINT GENERATED ALWAYS AS IDENTITY',
  'current_revision_sequence BIGINT',
  'requests_current_revision_integrity',
  'request_revisions_current_pointer_integrity',
  'requests_tenant_revision_watermark_idx',
  'proposed_request_snapshot',
  'booking_change_proposal_identity_immutable',
  'base_request_version + 1',
  'booking_change_room_fk',
  'booking_change_v2_schedule_limit',
  'booking_change_superseded_valid',
  'booking_change_calendar_recovery_valid',
  'booking_change_calendar_replacement_valid',
  'move_attempt_number INTEGER NOT NULL DEFAULT 0',
  "recovery_phase VARCHAR(32) NOT NULL DEFAULT 'none'",
  'jsonb_path_query_array',
  "proposed_request_snapshot -> 'details' = jsonb_build_object(",
  'request_revisions_migration_seed_valid',
  'REQUEST_COMPOSITION_V2_AUTHORITY_INCOMPLETE',
  'REQUEST_COMPOSITION_V2_LEGACY_REQUEST_REQUIRES_REVIEW',
  'requests_tenant_report_range_idx',
  'CREATE OR REPLACE FUNCTION initialize_tenant_catalogue_revision()',
]) {
  if (!requestCompositionMigration.includes(required)) {
    throw new Error(`Request composition migration is missing integrity boundary ${required}.`);
  }
}
if (/\b(?:BEGIN|COMMIT)\s*;|\bschema_migrations\b/i.test(requestCompositionMigration)) {
  throw new Error('Request composition migration must use runner-owned transactions and bookkeeping.');
}
const requestCompositionRollback = await readFile(
  'migrations/027_request_composition_v2.down.sql',
  'utf8',
);
for (const required of [
  'LOCK TABLE booking_change_requests IN ACCESS EXCLUSIVE MODE',
  'REQUEST_COMPOSITION_V2_ROLLBACK_REQUIRES_REVIEW',
  'proposed_request_snapshot IS NOT NULL',
  'previous_tenant_updated_at',
  'HAVING COUNT(revision.request_id) <> 1',
  'prices.currency IS DISTINCT FROM organization.default_currency',
  'DROP CONSTRAINT booking_change_room_fk',
  "WHERE status = 'superseded'",
  "recovery_phase <> 'none'",
  'calendar_replacement IS NOT NULL',
  'DROP INDEX requests_tenant_report_range_idx',
  'DROP INDEX requests_tenant_revision_watermark_idx',
  'DROP FUNCTION enforce_request_revision_pointer_integrity()',
  'CREATE OR REPLACE FUNCTION initialize_tenant_catalogue_revision()',
  "SET snapshot = revision.snapshot - 'roomPrices'",
]) {
  if (!requestCompositionRollback.includes(required)) {
    throw new Error(`Request composition rollback is missing fail-closed boundary ${required}.`);
  }
}

const index = await readFile('src/index.js', 'utf8');
for (const required of [
  'createSessionService',
  'createAuthorizationPolicy',
  'createRequestService',
  'createRoomAvailabilityService',
  'createAuditService',
  'createEntraClient',
  'createEntraAuthService',
  'createTenantOnboardingService',
  'createJitUserService',
  'createPendingProviderIdentityResolver({ onboardingService, jitUserService })',
  'createMicrosoft365Client',
  'createMicrosoft365ConnectionService',
  'createMicrosoft365ConnectionHealthView',
  'createMicrosoft365CapabilityHealthService',
  'createMicrosoft365RoomMappingService',
  'createMicrosoft365BookingServiceFactory',
  'createTenantLocationAdministrationService',
  'createCodeShippedManagedBrandPolicy',
  'createTenantOrganizationService',
  'createTenantPresentationService',
  'createTenantCatalogueService',
  'createTenantBookingPolicyService',
  'createTenantCostAllocationService',
  'createTenantUserLifecycleService',
  'createTenantAuditQueryService',
  'createTenantCapabilityViewService',
  'capabilityHealthService',
  'microsoft365ConnectionService',
  'microsoft365RoomMappingService',
  'microsoft365BookingServiceFactory',
  'roomAvailabilityService',
  'tenantLocationAdministrationService',
  'managedBrandPolicy',
  'tenantOrganizationService',
  'tenantPresentationService',
  'tenantCatalogueService',
  'tenantBookingPolicyService',
  'tenantCostAllocationService',
  'tenantUserLifecycleService',
  'tenantAuditQueryService',
  'tenantCapabilityViewService',
]) {
  if (!index.includes(required)) throw new Error(`Process composition must wire ${required}.`);
}
if (!index.includes('managedAssetPolicy: managedBrandPolicy')) {
  throw new Error('Tenant Organization mutation must use the code-shipped managed-brand policy.');
}
if (!index.includes('microsoft365Service: microsoft365ConnectionService')) {
  throw new Error('Tenant capability view must consume the decorated Microsoft 365 health view.');
}

const auditMigration = await readFile('migrations/004_tamper_evident_audit.up.sql', 'utf8');
for (const required of [
  'AUDIT_LEGACY_ROWS_REQUIRE_REVIEW',
  'audit_events_append_only',
  'BEFORE UPDATE OR DELETE',
  'previous_hash',
  'event_hash',
]) {
  if (!auditMigration.includes(required)) throw new Error(`Audit migration is missing ${required}.`);
}

const onboardingMigration = await readFile('migrations/008_tenant_onboarding_identity_claims.up.sql', 'utf8');
for (const required of [
  'tenant_onboarding_invitations',
  'tenant_identity_bindings_active_provider_idx',
  'tenant_identity_bindings_active_tenant_idx',
  'tenant_claim_transactions',
  'onboarding_invitation_id',
  'tenant.identity.claimed',
]) {
  if (!onboardingMigration.includes(required)) throw new Error(`Tenant onboarding migration is missing ${required}.`);
}
const onboardingRollback = await readFile('migrations/008_tenant_onboarding_identity_claims.down.sql', 'utf8');
if (!onboardingRollback.includes('TENANT_ONBOARDING_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Tenant onboarding rollback must fail closed when claim/binding evidence exists.');
}

const jitMigration = await readFile('migrations/009_jit_user_identity_bindings.up.sql', 'utf8');
for (const required of [
  'CREATE TABLE user_identity_bindings',
  'provider_tenant_reference varchar(128) NOT NULL',
  'provider_user_reference varchar(128) NOT NULL',
  'PRIMARY KEY (tenant_id, provider, provider_tenant_reference, provider_user_reference)',
  'tenant.user.provisioned',
  'tenant.user.profile_updated',
]) {
  if (!jitMigration.includes(required)) throw new Error(`JIT User migration is missing ${required}.`);
}
const jitRollback = await readFile('migrations/009_jit_user_identity_bindings.down.sql', 'utf8');
for (const required of ['JIT_USER_BINDINGS_REQUIRE_REVIEW', 'JIT_USER_AUDIT_REQUIRES_REVIEW']) {
  if (!jitRollback.includes(required)) throw new Error(`JIT User rollback is missing ${required}.`);
}

const microsoft365Migration = await readFile('migrations/011_microsoft365_connection_lifecycle.up.sql', 'utf8');
for (const required of [
  'integrations_microsoft365_tenant_unique',
  'microsoft365_consent_transactions',
  'microsoft365_consent_actor_fk',
  'microsoft365_consent_integration_fk',
  'connection_version > 0',
  'state_hash char(64) NOT NULL UNIQUE',
]) {
  if (!microsoft365Migration.includes(required)) {
    throw new Error(`Microsoft 365 lifecycle migration is missing ${required}.`);
  }
}
const microsoft365Rollback = await readFile('migrations/011_microsoft365_connection_lifecycle.down.sql', 'utf8');
if (!microsoft365Rollback.includes('MICROSOFT365_CONNECTION_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Microsoft 365 lifecycle rollback must fail closed when connection evidence exists.');
}

const roomMappingMigration = await readFile('migrations/012_microsoft365_room_mappings.up.sql', 'utf8');
for (const required of [
  'CREATE TABLE microsoft365_room_mappings',
  'UNIQUE (tenant_id, integration_id, external_room_id)',
  'FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id)',
  'FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id)',
  'microsoft365_room_mapping_address_unique',
]) {
  if (!roomMappingMigration.includes(required)) {
    throw new Error(`Microsoft 365 room mapping migration is missing ${required}.`);
  }
}
const roomMappingRollback = await readFile('migrations/012_microsoft365_room_mappings.down.sql', 'utf8');
if (!roomMappingRollback.includes('Cannot roll back Microsoft 365 room mappings while mapping rows exist')) {
  throw new Error('Microsoft 365 room mapping rollback must fail closed while mapping evidence exists.');
}

const calendarWriteMigration = await readFile('migrations/013_microsoft_calendar_write_entitlement.up.sql', 'utf8');
if (!calendarWriteMigration.includes("'microsoft.calendar.write'")) {
  throw new Error('Calendar-write migration must add the dedicated server-side write entitlement.');
}
const calendarWriteRollback = await readFile('migrations/013_microsoft_calendar_write_entitlement.down.sql', 'utf8');
if (!calendarWriteRollback.includes('CALENDAR_WRITE_ENTITLEMENT_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Calendar-write entitlement rollback must fail closed while write grants exist.');
}

const capabilityHealthMigration = await readFile('migrations/014_microsoft365_capability_health.up.sql', 'utf8');
for (const required of [
  'CREATE TABLE microsoft365_capability_health',
  'PRIMARY KEY (tenant_id, integration_id, capability)',
  'FOREIGN KEY (tenant_id, integration_id)',
  "capability IN ('places', 'free_busy', 'calendar_write')",
  'last_success_at IS NULL OR last_success_at <= last_checked_at',
]) {
  if (!capabilityHealthMigration.includes(required)) {
    throw new Error(`Microsoft 365 capability-health migration is missing ${required}.`);
  }
}
const capabilityHealthRollback = await readFile('migrations/014_microsoft365_capability_health.down.sql', 'utf8');
if (!capabilityHealthRollback.includes('MICROSOFT365_CAPABILITY_HEALTH_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Microsoft 365 capability-health rollback must fail closed while diagnostics exist.');
}

const bookingResourceMigration = await readFile('migrations/017_booking_provider_resource_binding.up.sql', 'utf8');
for (const required of [
  'provider_resource_reference varchar(320) NOT NULL',
  'provider_connection_reference varchar(320) NOT NULL',
  'ALTER COLUMN provider_reference DROP NOT NULL',
  "state IN ('pending', 'active', 'compensating', 'compensated', 'cancelled')",
  'booking_provider_references_state_reference_valid',
  'BOOKING_PROVIDER_RESOURCE_BINDING_REQUIRES_REVIEW',
]) {
  if (!bookingResourceMigration.includes(required)) {
    throw new Error(`Booking provider-resource migration is missing ${required}.`);
  }
}
const bookingResourceRollback = await readFile('migrations/017_booking_provider_resource_binding.down.sql', 'utf8');
if (!bookingResourceRollback.includes('BOOKING_PROVIDER_RESOURCE_BINDING_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Booking provider-resource rollback must fail closed while references exist.');
}
if (!bookingResourceRollback.includes('LOCK TABLE booking_provider_references IN ACCESS EXCLUSIVE MODE')) {
  throw new Error('Booking provider-resource rollback must lock before checking populated rows.');
}

const siteTimeZoneMigration = await readFile('migrations/018_site_time_zones.up.sql', 'utf8');
for (const required of [
  'ALTER TABLE sites',
  'ADD COLUMN time_zone varchar(64)',
  'sites_time_zone_valid',
]) {
  if (!siteTimeZoneMigration.includes(required)) {
    throw new Error(`Site time-zone migration is missing ${required}.`);
  }
}
const siteTimeZoneRollback = await readFile('migrations/018_site_time_zones.down.sql', 'utf8');
if (!siteTimeZoneRollback.includes('SITE_TIME_ZONE_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Site time-zone rollback must fail closed while configured values exist.');
}
if (!siteTimeZoneRollback.includes('LOCK TABLE sites IN ACCESS EXCLUSIVE MODE')) {
  throw new Error('Site time-zone rollback must lock before checking populated rows.');
}

const locationMigration = await readFile('migrations/021_tenant_location_self_service.up.sql', 'utf8');
for (const required of [
  'tenant_location_revisions',
  'sites_details_object',
  'rooms_details_object',
]) {
  if (!locationMigration.includes(required)) throw new Error(`Tenant location migration is missing ${required}.`);
}
if (/\b(?:BEGIN|COMMIT)\s*;|\bschema_migrations\b/i.test(locationMigration)) {
  throw new Error('Tenant location migration must leave transactions and schema bookkeeping to the migration runner.');
}
if (/UPDATE\s+sites[\s\S]{0,200}time_zone\s*=\s*['\"]?UTC/i.test(locationMigration)) {
  throw new Error('Tenant location migration must never fabricate an authoritative Site time zone.');
}
const locationRollback = await readFile('migrations/021_tenant_location_self_service.down.sql', 'utf8');
for (const required of [
  'LOCK TABLE tenant_location_revisions IN ACCESS EXCLUSIVE MODE',
  'LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE',
  "FROM sites WHERE details <> '{}'::jsonb",
  "FROM rooms WHERE details <> '{}'::jsonb",
  'TENANT_LOCATION_HISTORY_REQUIRE_REVIEW',
]) {
  if (!locationRollback.includes(required)) throw new Error(`Tenant location rollback is missing ${required}.`);
}
if (/\b(?:BEGIN|COMMIT)\s*;|\bschema_migrations\b/i.test(locationRollback)) {
  throw new Error('Tenant location rollback must leave transactions and schema bookkeeping to the migration runner.');
}

for (const migration of [
  'migrations/001_core_tenant_schema.up.sql',
  'migrations/001_core_tenant_schema.down.sql',
  'migrations/002_secure_sessions.up.sql',
  'migrations/002_secure_sessions.down.sql',
  'migrations/003_request_authorization_workflow.up.sql',
  'migrations/003_request_authorization_workflow.down.sql',
  'migrations/004_tamper_evident_audit.up.sql',
  'migrations/004_tamper_evident_audit.down.sql',
  'migrations/005_tenant_entitlements.up.sql',
  'migrations/005_tenant_entitlements.down.sql',
  'migrations/006_booking_provider_references.up.sql',
  'migrations/006_booking_provider_references.down.sql',
  'migrations/007_oidc_auth_transactions.up.sql',
  'migrations/007_oidc_auth_transactions.down.sql',
  'migrations/008_tenant_onboarding_identity_claims.up.sql',
  'migrations/008_tenant_onboarding_identity_claims.down.sql',
  'migrations/009_jit_user_identity_bindings.up.sql',
  'migrations/009_jit_user_identity_bindings.down.sql',
  'migrations/010_tenant_role_administration.up.sql',
  'migrations/010_tenant_role_administration.down.sql',
  'migrations/011_microsoft365_connection_lifecycle.up.sql',
  'migrations/011_microsoft365_connection_lifecycle.down.sql',
  'migrations/012_microsoft365_room_mappings.up.sql',
  'migrations/012_microsoft365_room_mappings.down.sql',
  'migrations/013_microsoft_calendar_write_entitlement.up.sql',
  'migrations/013_microsoft_calendar_write_entitlement.down.sql',
  'migrations/014_microsoft365_capability_health.up.sql',
  'migrations/014_microsoft365_capability_health.down.sql',
  'migrations/017_booking_provider_resource_binding.up.sql',
  'migrations/017_booking_provider_resource_binding.down.sql',
  'migrations/018_site_time_zones.up.sql',
  'migrations/018_site_time_zones.down.sql',
  'migrations/019_confirmed_booking_changes.up.sql',
  'migrations/019_confirmed_booking_changes.down.sql',
  'migrations/020_tenant_settings_revisions.up.sql',
  'migrations/020_tenant_settings_revisions.down.sql',
  'migrations/021_tenant_location_self_service.up.sql',
  'migrations/021_tenant_location_self_service.down.sql',
  'migrations/022_tenant_organization_settings.up.sql',
  'migrations/022_tenant_organization_settings.down.sql',
  'migrations/023_tenant_catalogue_administration.up.sql',
  'migrations/023_tenant_catalogue_administration.down.sql',
  'migrations/024_tenant_booking_policies.up.sql',
  'migrations/024_tenant_booking_policies.down.sql',
  'migrations/025_tenant_cost_allocation.up.sql',
  'migrations/025_tenant_cost_allocation.down.sql',
  'migrations/026_tenant_user_lifecycle_revision.up.sql',
  'migrations/026_tenant_user_lifecycle_revision.down.sql',
]) {
  await readFile(migration, 'utf8');
}

console.log('Architecture boundary check passed.');
