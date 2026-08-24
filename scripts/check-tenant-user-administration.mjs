import { readFile } from 'node:fs/promises';

const policy = await readFile('src/authorization/policy.js', 'utf8');
for (const required of [
  "TENANT_USERS_MANAGE: 'tenant:users:manage'",
  'tenantAuthorizationSnapshot',
  'TENANT_ROLE.CONFERENCE_MANAGER',
  'TENANT_ROLE.TENANT_ADMIN',
]) {
  if (!policy.includes(required)) throw new Error(`Tenant role policy is missing ${required}.`);
}
if (policy.includes("PLATFORM_ADMIN: 'platform_admin'")) {
  throw new Error('Platform Admin must remain outside tenant role administration.');
}

const service = await readFile('src/application/tenant-user-administration-service.js', 'utf8');
for (const required of [
  'PERMISSION.TENANT_USERS_MANAGE',
  'authorizationPolicy.requireTenantPermission',
  'targetUserId === principal.userId',
  'SELF_ROLE_CHANGE_NOT_AUTHORIZED',
  'LAST_TENANT_ADMIN_REQUIRED',
  'TENANT_USER_INACTIVE',
  'AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED',
]) {
  if (!service.includes(required)) throw new Error(`Tenant role service is missing ${required}.`);
}
if (/\b(?:tenantId|userId)\s*:\s*.*body/i.test(service)) {
  throw new Error('Tenant role service must not derive Tenant/User authority from transport body fields.');
}

const repository = await readFile('src/persistence/postgres/tenant-user-admin-repository.js', 'utf8');
for (const required of [
  'WHERE tenant_id = $1 AND id = $2',
  'tenant-role-admin:',
  'pg_advisory_xact_lock',
  "r.role = 'tenant_admin'",
  'u.active = true',
  'security_version = security_version + 1',
  'appendWithClient(client, auditEvent)',
]) {
  if (!repository.includes(required)) throw new Error(`Tenant role persistence is missing ${required}.`);
}
if (/\b(?:SELECT|UPDATE|DELETE FROM)\s+users\b[\s\S]{0,300}WHERE\s+id\s*=\s*\$1/i.test(repository)) {
  throw new Error('Tenant role persistence must not expose unscoped User access.');
}

const onboardingRepository = await readFile('src/persistence/postgres/tenant-onboarding-repository.js', 'utf8');
for (const required of [
  'claimant_provider_user_reference',
  'claim.provider_user_reference',
  'findActiveBindingByProvider',
]) {
  if (!onboardingRepository.includes(required)) {
    throw new Error(`Tenant claimant persistence is missing ${required}.`);
  }
}

const jitService = await readFile('src/identity/jit-user-service.js', 'utf8');
for (const required of [
  'tenantBinding.claimantProviderUserReference === external.userReference',
  'bootstrapTenantAdmin',
  'tenantAuthorizationSnapshot',
  'TENANT_USER_PERMISSIONS_CHANGED',
]) {
  if (!jitService.includes(required)) throw new Error(`JIT role bootstrap is missing ${required}.`);
}
if (/email|groups/i.test(jitService)) {
  throw new Error('JIT role bootstrap must not use provider email or groups as authorization authority.');
}

const jitRepository = await readFile('src/persistence/postgres/jit-user-repository.js', 'utf8');
for (const required of [
  'tenant_user_roles',
  "role = 'tenant_admin'",
  'tenant-role-admin:',
  'bootstrapAuditEvent',
]) {
  if (!jitRepository.includes(required)) throw new Error(`JIT role persistence is missing ${required}.`);
}

const app = await readFile('src/app.js', 'utf8');
for (const required of [
  "tenantUsers: '/api/v1/tenant/users'",
  'TENANT_USER_ROLES_PATH',
  'tenantUserAdministrationService.listUsers',
  'tenantUserAdministrationService.setRoles',
  'csrf: isRoleMutation',
  'tenantGuard.requireKnown(principal)',
]) {
  if (!app.includes(required)) throw new Error(`Tenant role HTTP boundary is missing ${required}.`);
}
if (/TENANT_USER_ROLES_BODY_SCHEMA[\s\S]{0,800}\btenantId\b/.test(app)) {
  throw new Error('Tenant role request body must not accept browser-selected Tenant authority.');
}
if (!app.includes("ELEVATED_TENANT_ROLES = new Set(['conference_manager', 'tenant_admin'])")) {
  throw new Error('Tenant role HTTP input must whitelist only elevated tenant roles.');
}

const migration = await readFile('migrations/010_tenant_role_administration.up.sql', 'utf8');
for (const required of [
  'claimant_provider_user_reference',
  'CREATE TABLE tenant_user_roles',
  "role IN ('conference_manager', 'tenant_admin')",
  'FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)',
]) {
  if (!migration.includes(required)) throw new Error(`Tenant role migration is missing ${required}.`);
}
const rollback = await readFile('migrations/010_tenant_role_administration.down.sql', 'utf8');
for (const required of [
  'TENANT_USER_ROLE_ROWS_REQUIRE_REVIEW',
  'TENANT_ROLE_CLAIMANT_BINDINGS_REQUIRE_REVIEW',
]) {
  if (!rollback.includes(required)) throw new Error(`Tenant role rollback is missing ${required}.`);
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!pool.includes('CURRENT_SCHEMA_VERSION = 10')) {
  throw new Error('Runtime schema readiness must include tenant role administration migration version 10.');
}

const runtime = await readFile('src/index.js', 'utf8');
for (const required of [
  'createTenantUserAdministrationService',
  'persistence.tenantUserAdminRepository',
  'tenantUserAdministrationService,',
]) {
  if (!runtime.includes(required)) throw new Error(`Runtime tenant role composition is missing ${required}.`);
}

console.log('Tenant role administration boundary check passed.');
