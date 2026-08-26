import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteModuleRegistry, defineRouteModule } from '../src/http/route-module.js';

test('route modules expose deterministic keys and dispatch in registration order', async () => {
  const first = defineRouteModule({
    id: 'catalog',
    routeKey: (path) => path === '/api/v1/tenant/catalog' ? 'tenant_catalog' : null,
    createHandler: () => async ({ path }) => path === '/api/v1/tenant/catalog' ? 200 : null,
  });
  const second = defineRouteModule({
    id: 'policies',
    routeKey: (path) => path === '/api/v1/tenant/policies' ? 'tenant_policies' : null,
    createHandler: () => async ({ path }) => path === '/api/v1/tenant/policies' ? 204 : null,
  });
  const registry = createRouteModuleRegistry([first, second]);
  assert.equal(registry.routeKey('/api/v1/tenant/catalog'), 'tenant_catalog');
  assert.equal(registry.routeKey('/not-found'), null);
  const dispatch = registry.createDispatcher({});
  assert.equal(await dispatch({ path: '/api/v1/tenant/policies' }), 204);
  assert.equal(await dispatch({ path: '/not-found' }), null);
});

test('route registration rejects invalid and duplicate module identities', () => {
  assert.throws(() => defineRouteModule({ id: 'Catalog', routeKey() {}, createHandler() {} }), /ROUTE_MODULE_ID_INVALID/);
  const module = defineRouteModule({ id: 'catalog', routeKey: () => null, createHandler: () => async () => null });
  assert.throws(() => createRouteModuleRegistry([module, module]), /ROUTE_MODULE_ID_DUPLICATE/);
});
