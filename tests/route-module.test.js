import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteModuleRegistry, defineRouteModule } from '../src/http/route-module.js';

function routeModule(id, path, status = 200) {
  return defineRouteModule({
    id,
    routeKey: (candidate) => candidate === path ? `${id}_route` : null,
    createHandler: () => async ({ path: candidate }) => candidate === path ? status : null,
  });
}

test('route modules expose deterministic keys and dispatch in registration order', async () => {
  const registry = createRouteModuleRegistry([
    routeModule('catalog', '/api/v1/tenant/catalog'),
    routeModule('policies', '/api/v1/tenant/policies', 204),
  ]);
  assert.equal(registry.routeKey('/api/v1/tenant/catalog'), 'catalog_route');
  assert.equal(registry.routeKey('/not-found'), null);
  const dispatch = registry.createDispatcher({});
  assert.equal(await dispatch({ path: '/api/v1/tenant/policies' }), 204);
  assert.equal(await dispatch({ path: '/not-found' }), null);
});

test('route registration rejects invalid and duplicate module identities', () => {
  const invalid = { id: 'Catalog', routeKey() {}, createHandler() {} };
  assert.throws(() => createRouteModuleRegistry([invalid]), /ROUTE_MODULE_ID_INVALID/);
  const module = routeModule('catalog', '/api/v1/tenant/catalog');
  assert.throws(() => createRouteModuleRegistry([module, module]), /ROUTE_MODULE_ID_DUPLICATE/);
});

test('duplicate route ownership fails closed before dispatch', async () => {
  const registry = createRouteModuleRegistry([
    routeModule('catalog', '/api/v1/tenant/shared'),
    routeModule('policies', '/api/v1/tenant/shared'),
  ]);
  assert.throws(
    () => registry.routeKey('/api/v1/tenant/shared'),
    /ROUTE_MODULE_KEY_CONFLICT/,
  );
  await assert.rejects(
    registry.createDispatcher({})({ path: '/api/v1/tenant/shared' }),
    /ROUTE_MODULE_KEY_CONFLICT/,
  );
});
