const ROUTE_MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

export function defineRouteModule({ id, routeKey, createHandler } = {}) {
  if (typeof id !== 'string' || !ROUTE_MODULE_ID.test(id)) {
    throw new TypeError('ROUTE_MODULE_ID_INVALID');
  }
  return Object.freeze({
    id,
    routeKey: requireFunction(routeKey, 'ROUTE_MODULE_KEY_REQUIRED'),
    createHandler: requireFunction(createHandler, 'ROUTE_MODULE_HANDLER_FACTORY_REQUIRED'),
  });
}

export function createRouteModuleRegistry(modules = []) {
  if (!Array.isArray(modules)) throw new TypeError('ROUTE_MODULES_INVALID');
  const registered = [];
  const ids = new Set();
  for (const candidate of modules) {
    const module = defineRouteModule(candidate);
    if (ids.has(module.id)) throw new TypeError('ROUTE_MODULE_ID_DUPLICATE');
    ids.add(module.id);
    registered.push(module);
  }

  function routeClaim(path) {
    const claims = [];
    for (const module of registered) {
      const key = module.routeKey(path);
      if (key !== null && key !== undefined) claims.push({ key, module });
    }
    if (claims.length > 1) throw new TypeError('ROUTE_MODULE_KEY_CONFLICT');
    return claims[0] || null;
  }

  return Object.freeze({
    modules: Object.freeze([...registered]),
    routeKey(path) {
      return routeClaim(path)?.key || null;
    },
    createDispatcher(runtime) {
      const handlers = registered.map((module) => Object.freeze({
        handler: requireFunction(
          module.createHandler(runtime),
          'ROUTE_MODULE_HANDLER_REQUIRED',
        ),
        module,
      }));
      return async function dispatch(context) {
        routeClaim(context?.path);
        for (const { handler } of handlers) {
          const status = await handler(context);
          if (status !== null && status !== undefined) return status;
        }
        return null;
      };
    },
  });
}
