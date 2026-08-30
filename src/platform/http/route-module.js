import { assertPlatformRouteKey } from './observability.js';

const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

export function definePlatformRouteModule({ id, claim, createHandler } = {}) {
  if (typeof id !== 'string' || !MODULE_ID.test(id)) {
    throw new TypeError('PLATFORM_ROUTE_MODULE_ID_INVALID');
  }
  return Object.freeze({
    id,
    claim: requireFunction(claim, 'PLATFORM_ROUTE_MODULE_CLAIM_REQUIRED'),
    createHandler: requireFunction(
      createHandler,
      'PLATFORM_ROUTE_MODULE_HANDLER_FACTORY_REQUIRED',
    ),
  });
}

export function createPlatformRouteRegistry(modules = []) {
  if (!Array.isArray(modules)) throw new TypeError('PLATFORM_ROUTE_MODULES_INVALID');
  const registered = [];
  const ids = new Set();
  for (const candidate of modules) {
    const module = definePlatformRouteModule(candidate);
    if (ids.has(module.id)) throw new TypeError('PLATFORM_ROUTE_MODULE_ID_DUPLICATE');
    ids.add(module.id);
    registered.push(module);
  }

  function routeClaim(context) {
    const claims = [];
    for (const module of registered) {
      const route = module.claim(context);
      if (route !== null && route !== undefined) {
        claims.push({ route: assertPlatformRouteKey(route), module });
      }
    }
    if (claims.length > 1) throw new TypeError('PLATFORM_ROUTE_MODULE_CLAIM_CONFLICT');
    return claims[0] || null;
  }

  return Object.freeze({
    modules: Object.freeze([...registered]),
    routeKey(context) {
      return routeClaim(context)?.route || null;
    },
    createDispatcher(runtime) {
      const handlers = registered.map((module) => Object.freeze({
        handler: requireFunction(
          module.createHandler(runtime),
          'PLATFORM_ROUTE_MODULE_HANDLER_REQUIRED',
        ),
        module,
      }));
      return async function dispatch(context) {
        routeClaim(context);
        for (const { handler } of handlers) {
          const status = await handler(context);
          if (status !== null && status !== undefined) return status;
        }
        return null;
      };
    },
  });
}
