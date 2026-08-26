import { readFile } from 'node:fs/promises';

const service = await readFile('src/identity/jit-user-service.js', 'utf8');
for (const required of [
  'TENANT_ROLE.EMPLOYEE',
  'tenantAuthorizationSnapshot',
  'snapshot.roles',
  'snapshot.permissions',
  'external.tenantReference',
  'providerTenantReference: external.tenantReference',
  'fallbackDisplayName: JIT_FALLBACK_DISPLAY_NAME',
  'tenantBinding.tenantId',
  'securityVersion: result.identity.securityVersion',
  "status: 'authentication_denied'",
  "status: 'onboarding_required'",
]) {
  if (!service.includes(required)) throw new Error(`JIT service is missing invariant ${required}.`);
}
if (/\b(?:email|groups)\b/i.test(service)) {
  throw new Error('JIT authorization must not derive authority from email or provider groups.');
}

const authorizationPolicy = await readFile('src/authorization/policy.js', 'utf8');
for (const required of [
  "EMPLOYEE: 'employee'",
  "REQUEST_READ: 'request:read'",
  "REQUEST_CANCEL: 'request:cancel'",
  'tenantAuthorizationSnapshot',
]) {
  if (!authorizationPolicy.includes(required)) {
    throw new Error(`Central authorization policy is missing JIT baseline invariant ${required}.`);
  }
}

const repository = await readFile('src/persistence/postgres/jit-user-repository.js', 'utf8');
for (const required of [
  'pg_advisory_xact_lock',
  'b.tenant_id = $1',
  'b.provider = $2',
  'b.provider_tenant_reference = $3',
  'b.provider_user_reference = $4',
  'jit-lock-active-provider-tenant-binding',
  "AND status = 'active'",
  "status: 'binding_unavailable'",
  'displayName ?? fallbackDisplayName',
  "status: 'tenant_unavailable'",
  "status: 'user_disabled'",
  'appendWithClient(client, provisionAuditEvent)',
  'appendWithClient(client, profileAuditEvent)',
]) {
  if (!repository.includes(required)) throw new Error(`JIT persistence is missing invariant ${required}.`);
}

const migration = await readFile('migrations/009_jit_user_identity_bindings.up.sql', 'utf8');
for (const required of [
  'CREATE TABLE user_identity_bindings',
  'provider_tenant_reference varchar(128) NOT NULL',
  'provider_user_reference varchar(128) NOT NULL',
  'PRIMARY KEY (tenant_id, provider, provider_tenant_reference, provider_user_reference)',
  "'tenant.user.provisioned'",
  "'tenant.user.profile_updated'",
]) {
  if (!migration.includes(required)) throw new Error(`JIT migration is missing invariant ${required}.`);
}

const resolver = await readFile('src/identity/provider-identity-resolver.js', 'utf8');
for (const required of [
  'onboardingInvitationId !== null',
  'onboardingService.prepareClaim',
  'jitUserService.resolve',
]) {
  if (!resolver.includes(required)) throw new Error(`Provider resolver is missing JIT boundary ${required}.`);
}

const persistence = await readFile('src/persistence/postgres/index.js', 'utf8');
for (const required of ['createPostgresJitUserRepository', 'jitUserRepository']) {
  if (!persistence.includes(required)) throw new Error(`PostgreSQL composition is missing ${required}.`);
}

const sessionRepository = await readFile('src/persistence/postgres/session-repository.js', 'utf8');
for (const required of [
  'expectedSecurityVersion',
  'AND u.security_version = $3',
  'FOR SHARE OF u, t',
]) {
  if (!sessionRepository.includes(required)) {
    throw new Error(`Session persistence is missing JIT authorization-snapshot invariant ${required}.`);
  }
}

const runtime = await readFile('src/index.js', 'utf8');
for (const required of ['createJitUserService', 'persistence.jitUserRepository', 'jitUserService']) {
  if (!runtime.includes(required)) throw new Error(`Runtime composition is missing ${required}.`);
}

const tenantModel = await readFile('src/tenancy/tenant.js', 'utf8');
if (!tenantModel.includes("'user_identity_binding'")) {
  throw new Error('Tenant ownership inventory must include JIT user identity bindings.');
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
const schemaMatch = pool.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
if (!schemaMatch || Number(schemaMatch[1]) < 9) {
  throw new Error('Runtime schema readiness must include JIT user migration version 9 or later.');
}

console.log('JIT user provisioning boundary check passed.');
