import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModuleGraph,
  findModuleCycles,
  moduleImports,
  moduleSpecifiers,
} from '../scripts/module-graph.mjs';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

test('module graph retains static import statements for route and policy boundary checks', () => {
  const source = [
    "import { defineRouteModule } from '../http/route-module.js';",
    "import { createTenantReadinessPolicy } from '../tenancy/tenant-readiness-policy.js';",
    "const lazy = import('./optional.js');",
  ].join('\n');
  const imports = moduleImports(source);
  assert.deepEqual(imports.map(({ specifier, dynamic }) => [specifier, dynamic]), [
    ['../http/route-module.js', false],
    ['../tenancy/tenant-readiness-policy.js', false],
    ['./optional.js', true],
  ]);
  assert.match(imports[0].statement, /\bdefineRouteModule\b/);
  assert.match(imports[1].statement, /\bcreateTenantReadinessPolicy\b/);
  assert.equal(imports[2].statement, null);
});

test('general module graph detects cycles', () => {
  const { graph } = buildModuleGraph({
    'src/a.js': "import './b.js';",
    'src/b.js': "import './a.js';",
  });
  assert.equal(findModuleCycles(graph).length, 1);
});

test('module graph parses executable template dynamic imports only', () => {
  const source = [
    "// import('../persistence/postgres/comment.js');",
    "const example = \"import(`../persistence/postgres/string.js`)\";",
    "import(`../persistence/postgres/catalog-repository.js`);",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(source), ['../persistence/postgres/catalog-repository.js']);
  assert.equal(moduleImports(source)[0].dynamic, true);

  const violations = backendSaas2BoundaryViolations({
    'src/application/catalog-service.js': source,
    'src/persistence/postgres/catalog-repository.js': 'export const repository = true;',
  });
  assert.ok(violations.some((item) => item.includes('application code must not depend')));
});

test('valid HTTP to application to domain direction passes', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/http/catalog-routes.js': [
      "import { service } from '../application/catalog-service.js';",
      'export { service };',
    ].join('\n'),
    'src/application/catalog-service.js': [
      "import { validate } from '../domain/catalog.js';",
      'export const service = validate;',
    ].join('\n'),
    'src/domain/catalog.js': 'export const validate = (value) => value;',
  });
  assert.deepEqual(violations, []);
});

test('Tenant readiness has one policy owner across projection persistence and Platform reads', () => {
  const canonical = backendSaas2BoundaryViolations({
    'src/tenancy/tenant-readiness-policy.js': [
      'export const TENANT_READINESS_CHECK = Object.freeze({ IDENTITY: \'tenant.identity.active\' });',
      'export const createTenantReadinessPolicy = () => ({ evaluateSnapshot: () => ({}) });',
    ].join('\n'),
    'src/persistence/postgres/platform-projection-repository.js': [
      "import { createTenantReadinessPolicy } from '../../tenancy/tenant-readiness-policy.js';",
      'const policy = createTenantReadinessPolicy();',
      'export const store = (checks) => policy.evaluateSnapshot({ checks });',
    ].join('\n'),
    'src/platform/application/fleet-readiness-service.js': [
      'export const createService = (readinessPolicy) => ({',
      '  list: (input) => readinessPolicy.evaluateSnapshot(input),',
      '});',
    ].join('\n'),
  });
  assert.deepEqual(canonical, []);

  const duplicated = backendSaas2BoundaryViolations({
    'src/tenancy/tenant-readiness-policy.js': 'export const policy = true;',
    'src/persistence/postgres/platform-projection-repository.js': [
      'const REQUIRED_CAPABILITIES = [];',
      'function readinessState() { return \'ready\'; }',
      'export { readinessState };',
    ].join('\n'),
    'src/platform/application/fleet-readiness-service.js': [
      'function evaluateFleetReadinessSnapshot() { return { state: \'ready\' }; }',
      'export { evaluateFleetReadinessSnapshot };',
    ].join('\n'),
  });
  assert.ok(duplicated.some((item) => item.includes('must consume the canonical Tenant readiness policy')));
  assert.ok(duplicated.some((item) => item.includes('must not redefine readiness checks')));
  assert.ok(duplicated.some((item) => item.includes('must delegate state and blocker evaluation')));
  assert.ok(duplicated.some((item) => item.includes('must not redefine Tenant readiness')));
});

test('application to PostgreSQL and domain to HTTP dependencies fail closed', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/application/catalog-service.js': "import '../persistence/postgres/catalog-repository.js';",
    'src/persistence/postgres/catalog-repository.js': 'export const repository = true;',
    'src/domain/catalog.js': "import '../http/catalog-routes.js';",
    'src/http/catalog-routes.js': 'export const route = true;',
  });
  assert.ok(violations.some((item) => item.includes('application code must not depend')));
  assert.ok(violations.some((item) => item.includes('domain and authorization policy must remain independent')));
});

test('SaaS 2 settings routes require an executable route-module contract', () => {
  const valid = backendSaas2BoundaryViolations({
    'src/http/settings/catalog-settings-routes.js': [
      "import { defineRouteModule } from '../route-module.js';",
      'export const catalogRoutes = defineRouteModule({',
      "  id: 'catalog', routeKey: () => null, createHandler: () => async () => null,",
      '});',
    ].join('\n'),
    'src/http/route-module.js': 'export const defineRouteModule = (value) => value;',
  });
  assert.deepEqual(valid, []);

  const invalid = backendSaas2BoundaryViolations({
    'src/http/settings/catalog-settings-routes.js': [
      "import '../route-module.js';",
      '// defineRouteModule({});',
    ].join('\n'),
    'src/http/route-module.js': 'export const defineRouteModule = (value) => value;',
  });
  assert.ok(invalid.some((item) => item.includes('must import the bounded')));
});

test('generic mutable settings services and repositories are rejected', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/application/tenant-settings-service.js': 'export const service = true;',
    'src/persistence/postgres/settings-repository.js': 'export const repository = true;',
  });
  assert.equal(violations.filter((item) => item.includes('generic mutable Tenant settings modules')).length, 2);
});

test('provider-neutral contracts are allowlisted and future providers fail closed', () => {
  const valid = backendSaas2BoundaryViolations({
    'src/persistence/postgres/booking-reference-repository.js': [
      "import { normalize } from '../../integrations/booking-reference.js';",
      'export { normalize };',
    ].join('\n'),
    'src/integrations/booking-reference.js': 'export const normalize = (value) => value;',
  });
  assert.deepEqual(valid, []);

  const invalid = backendSaas2BoundaryViolations({
    'src/application/catalog-service.js': "import '../integrations/google-calendar-provider.js';",
    'src/integrations/google-calendar-provider.js': 'export const provider = true;',
    'src/persistence/postgres/room-repository.js': [
      "import '../../integrations/google-calendar-provider.js';",
      'export const repository = true;',
    ].join('\n'),
  });
  assert.ok(invalid.some((item) => item.includes('application code may consume provider contracts only')));
  assert.ok(invalid.some((item) => item.includes('PostgreSQL adapters must not depend')));
});
