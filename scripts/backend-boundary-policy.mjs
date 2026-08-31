import {
  buildModuleGraph,
  findModuleCycles,
  isInside,
  moduleImports,
} from './module-graph.mjs';

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
const COMPOSITION_FILES = new Set([
  'src/index.js',
  'src/server.js',
  'src/app.js',
  'src/platform-composition.js',
  'src/platform-main.js',
]);
const PROVIDER_NEUTRAL_INTEGRATION_MODULES = new Set([
  'src/integrations/booking-reference.js',
  'src/integrations/calendar-contract.js',
  'src/integrations/errors.js',
]);
const TENANT_READINESS_POLICY_FILE = 'src/tenancy/tenant-readiness-policy.js';
const PLATFORM_PROJECTION_REPOSITORY_FILE = 'src/persistence/postgres/platform-projection-repository.js';
const PLATFORM_FLEET_READINESS_SERVICE_FILE = 'src/platform/application/fleet-readiness-service.js';
const TENANT_READINESS_CHECK_LITERAL = new RegExp([
  "['\"](?:tenant\\.identity\\.active|microsoft\\.connection\\.connected",
  '|microsoft\\.permission\\.(?:places|calendars)|microsoft\\.room_mapping\\.active',
  '|microsoft\\.free_busy\\.healthy|entitlement\\.microsoft_(?:directory|calendar))',
  "['\"]",
].join(''));

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
    || file === 'src/tenancy/tenant-scoped-repository.js'
    || file === TENANT_READINESS_POLICY_FILE;
}

function isProviderApplicationException(file) {
  const name = basename(file);
  return isInside(file, 'src/application') && name.startsWith('microsoft365-');
}

function isConcreteProviderModule(file) {
  return file === 'src/identity/entra-client.js'
    || (isInside(file, 'src/integrations')
      && !PROVIDER_NEUTRAL_INTEGRATION_MODULES.has(file));
}

function isNewSettingsRoute(file) {
  return isInside(file, 'src/http/settings') || /-settings-routes\.js$/.test(file);
}

function isPlatformDomain(file) {
  return isInside(file, 'src/platform/identity') || isInside(file, 'src/platform/audit');
}

function isPlatformPersistence(file) {
  return isInside(file, 'src/persistence/postgres')
    && basename(file).startsWith('platform-');
}

function importsRouteModuleContract(source) {
  return moduleImports(source).some((entry) => !entry.dynamic
    && entry.specifier.endsWith('/route-module.js')
    && /\bdefineRouteModule\b/.test(entry.statement || ''));
}

export function backendSaas2BoundaryViolations(sourceEntries) {
  const sources = sourceEntries instanceof Map
    ? sourceEntries
    : new Map(Object.entries(sourceEntries || {}));
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
    const genericSegment = pathSegments(file)
      .find((segment) => GENERIC_DUMPING_GROUNDS.has(segment));
    if (genericSegment) {
      violations.push(violation(
        file,
        `generic dumping-ground module or directory ${genericSegment} is forbidden.`,
      ));
    }
    if (GENERIC_SETTINGS_MODULES.has(basename(file))) {
      violations.push(violation(
        file,
        'generic mutable Tenant settings modules are forbidden; use the owning bounded domain.',
      ));
    }
    if (file === PLATFORM_PROJECTION_REPOSITORY_FILE) {
      if (!graph.get(file)?.includes(TENANT_READINESS_POLICY_FILE)) {
        violations.push(violation(
          file,
          'Platform readiness projection persistence must consume the canonical Tenant readiness policy.',
        ));
      }
      if (
        /\b(?:function|const)\s+(?:readinessState|blockerCodes|REQUIRED_CAPABILITIES)\b/.test(source)
        || TENANT_READINESS_CHECK_LITERAL.test(source)
      ) {
        violations.push(violation(
          file,
          'Platform readiness projection persistence must not redefine readiness checks, state, or blockers.',
        ));
      }
    }
    if (file === PLATFORM_FLEET_READINESS_SERVICE_FILE) {
      if (!/\breadinessPolicy\.evaluateSnapshot\s*\(/.test(source)) {
        violations.push(violation(
          file,
          'Platform fleet readiness must delegate state and blocker evaluation to its canonical policy port.',
        ));
      }
      if (
        /\b(?:function|const)\s+(?:evaluateFleetReadinessSnapshot|freshnessForObservation|requiredIds)\b/.test(source)
        || TENANT_READINESS_CHECK_LITERAL.test(source)
      ) {
        violations.push(violation(
          file,
          'Platform fleet readiness must not redefine Tenant readiness checks, freshness, state, or blockers.',
        ));
      }
    }
    if (isNewSettingsRoute(file) && file !== 'src/http/route-module.js') {
      if (!importsRouteModuleContract(source)) {
        violations.push(violation(
          file,
          'SaaS 2 settings route families must import the bounded defineRouteModule contract.',
        ));
      }
      if (!/\bdefineRouteModule\s*\(/.test(source)) {
        violations.push(violation(
          file,
          'SaaS 2 settings route families must export a defineRouteModule contract.',
        ));
      }
    }
  }

  for (const [sourceFile, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (
        isInside(sourceFile, 'src/platform')
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/identity')
          || isInside(dependency, 'src/audit')
          || isInside(dependency, 'src/authorization')
          || isInside(dependency, 'src/tenancy')
          || isInside(dependency, 'src/entitlements')
          || isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')
      ) {
        violations.push(violation(
          sourceFile,
          `Platform code must remain independent from the customer runtime boundary ${dependency}.`,
        ));
      }

      if (
        isPlatformDomain(sourceFile)
        && isInside(dependency, 'src/platform/application')
      ) {
        violations.push(violation(
          sourceFile,
          `Platform identity and audit policy must remain independent of application module ${dependency}.`,
        ));
      }

      if (
        !isInside(sourceFile, 'src/platform')
        && !['src/platform-composition.js', 'src/platform-main.js'].includes(sourceFile)
        && !isPlatformPersistence(sourceFile)
        && isInside(dependency, 'src/platform')
      ) {
        violations.push(violation(
          sourceFile,
          `Customer runtime code must not import the Platform control-plane boundary ${dependency}.`,
        ));
      }

      if (isInside(sourceFile, 'src/application')) {
        if (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/persistence')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js') {
          violations.push(violation(
            sourceFile,
            `application code must not depend on transport, concrete persistence or composition module ${dependency}.`,
          ));
        }
        if (isConcreteProviderModule(dependency)
          && !isProviderApplicationException(sourceFile)) {
          violations.push(violation(
            sourceFile,
            `application code may consume provider contracts only; concrete provider module ${dependency} is not allowed here.`,
          ));
        }
      }

      if (isDomainPolicy(sourceFile)
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(
          sourceFile,
          `domain and authorization policy must remain independent of ${dependency}.`,
        ));
      }

      if (isInside(sourceFile, 'src/http')
        && (isInside(dependency, 'src/persistence')
          || isInside(dependency, 'src/integrations')
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(
          sourceFile,
          `HTTP transport must not import concrete infrastructure or composition module ${dependency}.`,
        ));
      }

      if (isInside(sourceFile, 'src/persistence/postgres')
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isConcreteProviderModule(dependency)
          || COMPOSITION_FILES.has(dependency)
          || dependency === 'src/config.js')) {
        violations.push(violation(
          sourceFile,
          `PostgreSQL adapters must not depend on transport, application services, providers or composition module ${dependency}.`,
        ));
      }

      if (isInside(sourceFile, 'src/integrations')
        && (isInside(dependency, 'src/http')
          || isInside(dependency, 'src/application')
          || isInside(dependency, 'src/persistence')
          || COMPOSITION_FILES.has(dependency))) {
        violations.push(violation(
          sourceFile,
          `provider adapters must not depend on transport, application services, persistence or composition module ${dependency}.`,
        ));
      }
    }
  }

  return Object.freeze([...new Set(violations)].sort());
}
