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
  for (const module of modules) {
    if (!module || typeof module !== 'object') throw new TypeError('ROUTE_MODULE_INVALID');
    if (typeof module.id !== 'string' || ids.has(module.id)) throw new TypeError('ROUTE_MODULE_ID_DUPLICATE');
    requireFunction(module.routeKey, 'ROUTE_MODULE_KEY_REQUIRED');
    requireFunction(module.createHandler, 'ROUTE_MODULE_HANDLER_FACTORY_REQUIRED');
    ids.add(module.id);
    registered.push(module);
  }

  return Object.freeze({
    modules: Object.freeze([...registered]),
    routeKey(path) {
      for (const module of registered) {
        const key = module.routeKey(path);
        if (key !== null && key !== undefined) return key;
      }
      return null;
    },
    createDispatcher(runtime) {
      const handlers = registered.map((module) => {
        const handler = module.createHandler(runtime);
        return requireFunction(handler, 'ROUTE_MODULE_HANDLER_REQUIRED');
      });
      return async function dispatch(context) {
        for (const handler of handlers) {
          const status = await handler(context);
          if (status !== null && status !== undefined) return status;
        }
        return null;
      };
    },
  });
}
