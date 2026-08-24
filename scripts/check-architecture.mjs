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
  "'/api/v1/session'",
  "'/api/v1/audit'",
]) {
  if (!app.includes(route)) throw new Error(`Required route contract is missing: ${route}.`);
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
if (app.includes("searchParams.get('tenantId')") || app.includes("searchParams.get('tid')")) {
  throw new Error('Microsoft authentication routes must not accept browser-selected Tenant authority.');
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
if (!app.includes('auditService.listTenantEvents') || !app.includes('correlationId: requestId')) {
  throw new Error('Tenant audit reads must use the audit service and server-generated request correlation.');
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

const auditEvent = await readFile('src/audit/event.js', 'utf8');
for (const required of ['FORBIDDEN_KEY', 'canonicalAuditPayload', 'retentionClass', 'correlationId']) {
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
  'auditRepository',
  'entitlementRepository',
  'bookingReferenceRepository',
  'oidcTransactionRepository',
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
  'repository.consume',
  'identityResolver.resolve',
  'sessionService.issue',
]) {
  if (!entraAuthService.includes(required)) {
    throw new Error(`Entra authentication service is missing protocol/session invariant ${required}.`);
  }
}
const browserBindingCheck = entraAuthService.indexOf('safeTokenEqual(presentedBinding');
const oidcStateConsume = entraAuthService.indexOf('repository.consume');
if (browserBindingCheck < 0 || oidcStateConsume < 0 || browserBindingCheck > oidcStateConsume) {
  throw new Error('Entra browser binding must be validated before shared OIDC state is consumed.');
}

const oidcRepository = await readFile('src/persistence/postgres/oidc-transaction-repository.js', 'utf8');
for (const required of [
  'DELETE FROM oidc_auth_transactions',
  'WHERE provider = $1',
  'AND state_hash = $2',
  'AND expires_at > $3',
  'RETURNING nonce_hash',
]) {
  if (!oidcRepository.includes(required)) throw new Error(`OIDC transaction repository is missing replay invariant ${required}.`);
}

const config = await readFile('src/config.js', 'utf8');
for (const required of [
  'AUDIT_HMAC_SECRET_REQUIRED',
  'auditHmacSecret',
  'ENTRA_AUTHORITY',
  'ENTRA_CLIENT_ID_REQUIRED',
  'ENTRA_CLIENT_SECRET_REQUIRED',
  'OIDC_TRANSACTION_SECRET_REQUIRED',
]) {
  if (!config.includes(required)) throw new Error(`Pilot/Production configuration is missing ${required}.`);
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!pool.includes('CURRENT_SCHEMA_VERSION = 7')) {
  throw new Error('Runtime schema readiness must require OIDC transaction migration version 7.');
}

const index = await readFile('src/index.js', 'utf8');
for (const required of [
  'createSessionService',
  'createAuthorizationPolicy',
  'createRequestService',
  'createAuditService',
  'createEntraClient',
  'createEntraAuthService',
]) {
  if (!index.includes(required)) throw new Error(`Process composition must wire ${required}.`);
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
]) {
  await readFile(migration, 'utf8');
}

console.log('Architecture boundary check passed.');
