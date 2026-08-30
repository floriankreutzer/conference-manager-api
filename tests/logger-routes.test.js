import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { tenantCatalogueRouteKey } from '../src/http/settings/catalogue.js';
import { tenantCostAllocationRouteKey } from '../src/http/settings/cost-allocation.js';
import { tenantLocationRouteKey } from '../src/http/settings/locations.js';
import { createLogger } from '../src/logger.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';

const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

function loggedRoute(route, method) {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.requestCompleted({
    requestId: REQUEST_ID,
    method,
    route,
    statusCode: 200,
    durationMs: 1,
  });
  return JSON.parse(lines.at(-1));
}

test('the default output writer contains asynchronous stream failures', async () => {
  let writes = 0;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      setImmediate(() => callback(Object.assign(new Error('collector unavailable'), { code: 'EPIPE' })));
    },
  });
  const logger = createLogger({ output });

  logger.lifecycle({ event: 'startup' });
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.equal(writes, 1);
  assert.doesNotThrow(() => logger.lifecycle({ event: 'shutdown' }));
  assert.equal(writes, 1);
});

test('Tenant user administration uses bounded operational route labels', () => {
  assert.equal(loggedRoute('tenant_users', 'GET').route, 'tenant_users');
  assert.equal(loggedRoute('tenant_user_roles', 'PUT').route, 'tenant_user_roles');
});

test('every modular bulk route identity is accepted by logger and metrics', () => {
  const routeFamilies = [
    [tenantLocationRouteKey, '/api/v1/tenant/settings/locations/bulk/sites'],
    [tenantCatalogueRouteKey, '/api/v1/tenant/settings/catalogue/bulk/services'],
    [tenantCostAllocationRouteKey, '/api/v1/tenant/settings/cost-allocation/bulk/cost-centers'],
  ];
  const operations = ['template', 'export', 'validate', 'apply'];
  const metrics = createMetricsRegistry();
  const actualRoutes = [];

  for (const [routeKey, prefix] of routeFamilies) {
    for (const operation of operations) {
      const route = routeKey(`${prefix}/${operation}`);
      const method = operation === 'template' || operation === 'export' ? 'GET' : 'POST';
      actualRoutes.push(route);
      assert.equal(loggedRoute(route, method).route, route);
      metrics.recordApiRequest({ route, method, statusCode: 200, durationMs: 1 });
    }
  }

  assert.deepEqual(actualRoutes, [
    'tenant_settings_locations_bulk_template',
    'tenant_settings_locations_bulk_export',
    'tenant_settings_locations_bulk_validate',
    'tenant_settings_locations_bulk_apply',
    'tenant_settings_catalogue_bulk_template',
    'tenant_settings_catalogue_bulk_export',
    'tenant_settings_catalogue_bulk_validate',
    'tenant_settings_catalogue_bulk_apply',
    'tenant_settings_cost_allocation_bulk_template',
    'tenant_settings_cost_allocation_bulk_export',
    'tenant_settings_cost_allocation_bulk_validate',
    'tenant_settings_cost_allocation_bulk_apply',
  ]);
  const snapshot = JSON.stringify(metrics.snapshot());
  for (const route of actualRoutes) assert.match(snapshot, new RegExp(route));
  assert.doesNotMatch(snapshot, /\/api\/v1\/tenant\/settings/);
});

test('operational logger still rejects arbitrary dynamic route labels', () => {
  const logger = createLogger({ write: () => {} });
  assert.throws(() => logger.requestCompleted({
    requestId: REQUEST_ID,
    method: 'GET',
    route: '/api/v1/tenant/users/attacker-controlled',
    statusCode: 200,
    durationMs: 1,
  }), /LOG_ROUTE_INVALID/);

  const metrics = createMetricsRegistry();
  assert.throws(() => metrics.recordApiRequest({
    route: '/api/v1/tenant/users/attacker-controlled',
    method: 'GET',
    statusCode: 200,
    durationMs: 1,
  }), /METRIC_ROUTE_INVALID/);
});
