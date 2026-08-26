import { readFile } from 'node:fs/promises';

const requiredTenantScopedPersistence = Object.freeze([
  'src/persistence/postgres/request-repository.js',
  'src/persistence/postgres/audit-repository.js',
  'src/persistence/postgres/booking-reference-repository.js',
  'src/persistence/postgres/entitlement-repository.js',
  'src/persistence/postgres/microsoft365-capability-health-repository.js',
  'src/persistence/postgres/microsoft365-connection-repository.js',
  'src/persistence/postgres/microsoft365-room-mapping-repository.js',
]);

for (const path of requiredTenantScopedPersistence) {
  const source = await readFile(path, 'utf8');
  if (!source.includes('tenant_id')) {
    throw new Error(`${path} must preserve explicit Tenant ownership in persistence.`);
  }
  if (!/WHERE[\s\S]{0,180}tenant_id\s*=\s*\$\d/i.test(source)) {
    throw new Error(`${path} must retain a parameterized Tenant predicate for reads or mutations.`);
  }
}

const policy = await readFile('src/authorization/policy.js', 'utf8');
for (const invariant of [
  'tenantContext.tenantId !== principal.tenantId',
  'resourceTenantId !== principal.tenantId',
  "deny('RESOURCE_NOT_AVAILABLE', { conceal: true })",
]) {
  if (!policy.includes(invariant)) throw new Error(`Authorization Tenant isolation invariant missing: ${invariant}`);
}

const microsoftProvider = await readFile('src/integrations/microsoft365-calendar-provider.js', 'utf8');
for (const invariant of [
  'connectionRepository.findByTenantId(tenantId)',
  'mappingRepository.listByTenantIdAndIntegrationId(',
  'providerTenantReference: connection.providerTenantReference',
]) {
  if (!microsoftProvider.includes(invariant)) {
    throw new Error(`Microsoft provider Tenant binding invariant missing: ${invariant}`);
  }
}

const httpRoutes = await readFile('src/http/microsoft365-routes.js', 'utf8');
if (!httpRoutes.includes('tenantGuard.requireKnown(principal)')) {
  throw new Error('Microsoft integration routes must derive Tenant context from the authenticated Principal.');
}

const requiredSecuritySuites = Object.freeze([
  'tests/multi-tenant-isolation.test.js',
  'tests/authorization.test.js',
  'tests/tenant-pilot-service.test.js',
  'tests/microsoft365-onboarding-verification.test.js',
]);
for (const path of requiredSecuritySuites) await readFile(path, 'utf8');

console.log('Multi-tenant isolation release gate passed.');
