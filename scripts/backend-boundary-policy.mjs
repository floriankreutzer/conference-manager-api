import { buildModuleGraph, findModuleCycles, isInside } from './module-graph.mjs';

const GENERIC_DUMPING_GROUNDS = new Set([
  'common.js',
  'helpers.js',
  'utils.js',
  'common',
  'helpers',
  'utils',
]);
const GENERIC_SETTINGS_MODULES = new Set([
  'settings-service.js',
  'settings-repository.js',
  'settings-routes.js',
  'tenant-settings-service.js',
  'tenant-settings-repository.js',
  'tenant-settings-routes.js',
]);
const COMPOSITION_FILES = new Set(['src/index.js', 'src/server.js', 'src/app.js']);
const CONCRETE_PROVIDER_MODULES = new Set([
  'src/integrations/microsoft365-client.js',
  'src/integrations/microsoft365-calendar-provider.js',
  'src/identity/entra-client.js',
]);

function normalized(file) {
  return String(file).replaceAll('\\', '/');
}

function pathSegments(file) {
  return normalized(file).split('/');
}

function basename(file) {
  return pathSegments(file).at(-1);
}

function violation(file, message) {
  return `${file}: ${message}`;
}

function isDomainPolicy(file) {
  return isInside(file, 'src/domain')
    || isInside(file, 'src/authorization')
    || file === 'src/entitlements/capabilities.js'
    || file === 'src/tenancy/tenant.js'
    || file === 'src/tenancy/tenant-scoped-repository.js';
}

function isProviderApplicationException(file) {
  const name = basename(file);
  return isInside(file, 'src/application') && name.startsWith('microsoft365-');
}

function isNewSettingsRoute(file) {
  return isInside(file, 'src/http/settings') || /-settings-routes\.js$/.test(file);
}

export function backendSaas2BoundaryViolations(sourceEntries) {
  const sources = sourceEntries instanceof Map ? sourceEntries : new Map(Object.entries(sourceEntries || {}));
  const { graph, unresolved } = buildModuleGraph(sources);
  const violations = [];

  for (const { file, specifier } of unresolved) {
    violations.push(violation(file, `relative dependency ${specifier} cannot be resolved.`));
  }
  for (const cycle of findModuleCycles(graph)) {
    violations.push(`Source import cycle is forbidden: ${cycle.join(' -> ')}`);
  }

  for (const [rawFile, rawSource] of sources) {
    const file = normalized(rawFile);
    const source = String(rawSource);
    const genericSegment = pathSegments(file).find((segment) => GENERIC_DUMPING_GROUNDS.has(segment));
    if (genericSegment) {
      violations.push(violation(file, `generic dumping-ground module or directory ${genericSegment} is forbidden.`));
    }
    if (GENERIC_SETTINGS_MODULES.has(basename(file))) {
      violations.push(violation(file, 'generic mutable Tenant settings modules are forbidden; use the owning bounded domain.'));
    }
    if (isNewSettingsRoute(file) && file !== 'src/http/route-module.js') {
      if (!source.includes("from '../route-module.js'") && !source.includes("from './route-module.js'")) {
        violations.push(violation(file, 'SaaS 2 settings route families must use the bounded route-module registration contract.'));
      }
      if (!source.includes('defineRouteModule')) {
        violations.push(violation(file, 'SaaS 2 settings route families must export a defineRouteModule contract.'));
      }
    }
  }

  for (const [sourceFile, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (isInside(sourceFile, 'src/application')) {
        if (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/persistence')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js') {
          violations.push(violation(sourceFile, `application code must not depend on transport, concrete persistence or composition module ${dependency}.`));
        }
        if (CONCRETE_PROVIDER_MODULES.has(dependency) && !isProviderApplicationException(sourceFile)) {
          violations.push(violation(sourceFile, `application code may consume provider contracts only; concrete provider module ${dependency} is not allowed here.`));
        }
      }

      if (isDomainPolicy(sourceFile)
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(sourceFile, `domain and authorization policy must remain independent of ${dependency}.`));
      }

      if (isInside(sourceFile, 'src/http')
        && (isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(sourceFile, `HTTP transport must not import concrete infrastructure or composition module ${dependency}.`));
      }

      if (isInside(sourceFile, 'src/persistence/postgres')
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(sourceFile, `PostgreSQL adapters must not depend on transport, application services, providers or composition module ${dependency}.`));
      }

      if (isInside(sourceFile, 'src/integrations')
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/persistence')
          || COMPOSITION_FILES.has(dependency))) {
        violations.push(violation(sourceFile, `provider adapters must not depend on transport, application services, persistence or composition module ${dependency}.`));
      }
    }
  }

  return Object.freeze([...new Set(violations)].sort());
}
