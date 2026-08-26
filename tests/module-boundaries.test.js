import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModuleGraph, findModuleCycles } from '../scripts/module-graph.mjs';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

test('general module graph detects cycles', () => {
  const { graph } = buildModuleGraph({
    'src/a.js': "import './b.js';",
    'src/b.js': "import './a.js';",
  });
  assert.equal(findModuleCycles(graph).length, 1);
});

test('valid HTTP to application to domain direction passes', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/http/catalog-routes.js': "import { service } from '../application/catalog-service.js'; export { service };",
    'src/application/catalog-service.js': "import { validate } from '../domain/catalog.js'; export const service = validate;",
    'src/domain/catalog.js': 'export const validate = (value) => value;',
  });
  assert.deepEqual(violations, []);
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

test('SaaS 2 settings routes require the route-module contract', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/http/settings/catalog-settings-routes.js': 'export const route = true;',
  });
  assert.ok(violations.some((item) => item.includes('route-module registration contract')));
  assert.ok(violations.some((item) => item.includes('defineRouteModule contract')));
});

test('generic mutable settings services and repositories are rejected', () => {
  const violations = backendSaas2BoundaryViolations({
    'src/application/tenant-settings-service.js': 'export const service = true;',
    'src/persistence/postgres/settings-repository.js': 'export const repository = true;',
  });
  assert.equal(violations.filter((item) => item.includes('generic mutable Tenant settings modules')).length, 2);
});

test('PostgreSQL adapters may consume provider-neutral contracts but not concrete providers', () => {
  const valid = backendSaas2BoundaryViolations({
    'src/persistence/postgres/booking-reference-repository.js': "import { normalize } from '../../integrations/booking-reference.js'; export { normalize };",
    'src/integrations/booking-reference.js': 'export const normalize = (value) => value;',
  });
  assert.deepEqual(valid, []);

  const invalid = backendSaas2BoundaryViolations({
    'src/persistence/postgres/room-repository.js': "import '../../integrations/microsoft365-client.js';",
    'src/integrations/microsoft365-client.js': 'export const client = true;',
  });
  assert.ok(invalid.some((item) => item.includes('PostgreSQL adapters must not depend')));
});
