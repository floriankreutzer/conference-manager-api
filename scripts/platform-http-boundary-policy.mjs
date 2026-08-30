import {
  buildModuleGraph,
  findModuleCycles,
  isInside,
  moduleImports,
} from './module-graph.mjs';

const CUSTOMER_COMPOSITION = new Set([
  'src/app.js',
  'src/config.js',
  'src/index.js',
  'src/server.js',
]);
const PLATFORM_COMPOSITION = new Set([
  'src/platform/app.js',
  'src/platform/config.js',
  'src/platform/index.js',
  'src/platform/server.js',
]);
const PLATFORM_HTTP_IDENTITY_CONTRACTS = new Set([
  'src/platform/identity/entra-transaction-cookie.js',
  'src/platform/identity/entra-authorization-url.js',
  'src/platform/identity/principal.js',
  'src/platform/identity/policy.js',
  'src/platform/identity/errors.js',
]);

function normalized(value) {
  return String(value).replaceAll('\\', '/');
}

function violation(file, message) {
  return `${file}: ${message}`;
}

function isPlatformRouteModule(file) {
  return isInside(file, 'src/platform/http') && file.endsWith('-routes.js');
}

function isConcretePlatformService(file) {
  return (isInside(file, 'src/platform/application') || isInside(file, 'src/platform/identity'))
    && file.endsWith('-service.js');
}

export function platformHttpBoundaryViolations(sourceEntries) {
  const sources = sourceEntries instanceof Map
    ? sourceEntries
    : new Map(Object.entries(sourceEntries || {}));
  const { graph, unresolved } = buildModuleGraph(sources);
  const violations = [];

  for (const { file, specifier } of unresolved) {
    violations.push(violation(file, `relative dependency ${specifier} cannot be resolved.`));
  }
  for (const cycle of findModuleCycles(graph)) {
    violations.push(`Platform source import cycle is forbidden: ${cycle.join(' -> ')}`);
  }

  for (const [rawFile, rawSource] of sources) {
    const file = normalized(rawFile);
    const source = String(rawSource);
    if (CUSTOMER_COMPOSITION.has(file)) {
      for (const dependency of graph.get(file) || []) {
        if (isInside(dependency, 'src/platform')) {
          violations.push(violation(
            file,
            `customer composition must not import Platform control-plane module ${dependency}.`,
          ));
        }
      }
    }

    if (isPlatformRouteModule(file)) {
      const importsContract = moduleImports(source).some((entry) => {
        return !entry.dynamic
          && entry.specifier.endsWith('/route-module.js')
          && /\bdefinePlatformRouteModule\b/.test(entry.statement || '');
      });
      if (!importsContract || !/\bdefinePlatformRouteModule\s*\(/.test(source)) {
        violations.push(violation(
          file,
          'Platform route families must use the explicit definePlatformRouteModule contract.',
        ));
      }
    }

    if (isInside(file, 'src/platform/http')) {
      if (/['"]\/api\/(?!v1\/platform(?:\/|['"]))/i.test(source)) {
        violations.push(violation(file, 'Platform HTTP route literals must stay below /api/v1/platform/.'));
      }
      if (/['"]\/api\/v1\/platform\/(?:command|commands|action|actions)(?:\/|['"])/i.test(source)) {
        violations.push(violation(file, 'generic Platform command or action routes are forbidden.'));
      }
      if (moduleImports(source).some((entry) => entry.dynamic)) {
        violations.push(violation(file, 'dynamic imports are forbidden in the Platform HTTP boundary.'));
      }
    }
  }

  for (const [sourceFile, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (isInside(sourceFile, 'src/platform/http')) {
        if (
          isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || isConcretePlatformService(dependency)
          || CUSTOMER_COMPOSITION.has(dependency)
        ) {
          violations.push(violation(
            sourceFile,
            `Platform HTTP must consume injected ports, not concrete infrastructure/service ${dependency}.`,
          ));
        }
        if (
          isInside(dependency, 'src/platform/identity')
          && !PLATFORM_HTTP_IDENTITY_CONTRACTS.has(dependency)
        ) {
          violations.push(violation(
            sourceFile,
            `Platform HTTP identity dependency is not an approved transport contract: ${dependency}.`,
          ));
        }
      }

      if (
        (isInside(sourceFile, 'src/platform/application')
          || isInside(sourceFile, 'src/platform/identity')
          || isInside(sourceFile, 'src/platform/audit'))
        && isInside(dependency, 'src/platform/http')
      ) {
        violations.push(violation(
          sourceFile,
          `Platform application/domain code must not depend on HTTP transport ${dependency}.`,
        ));
      }

      if (
        PLATFORM_COMPOSITION.has(sourceFile)
        && CUSTOMER_COMPOSITION.has(dependency)
      ) {
        violations.push(violation(
          sourceFile,
          `Platform composition must not depend on customer composition ${dependency}.`,
        ));
      }
    }
  }

  return Object.freeze([...new Set(violations)].sort());
}
