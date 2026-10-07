import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendSaas2BoundaryViolations } from './backend-boundary-policy.mjs';
import {
  buildModuleGraph,
  isInside,
  moduleImports,
} from './module-graph.mjs';

const PRODUCTION_COMPOSITION_ROOTS = new Set([
  'src/index.js',
  'src/customer-composition.js',
  'src/server.js',
  'src/app.js',
  'src/platform-main.js',
  'src/platform-composition.js',
  'src/platform-production-authentication.js',
  'src/platform/index.js',
  'src/platform/app.js',
]);
const REAL_PRODUCTION_IDENTITY_AND_PROVIDER_MODULES = new Set([
  'src/identity/entra-client.js',
  'src/identity/entra-auth-service.js',
  'src/identity/provider-identity-resolver.js',
  'src/identity/jit-user-service.js',
  'src/integrations/microsoft365-client.js',
  'src/integrations/microsoft365-calendar-provider.js',
  'src/platform-production-authentication.js',
  'src/platform/identity/entra-client.js',
  'src/platform/identity/entra-auth-service.js',
  'src/platform/identity/claim-policy.js',
  'src/platform/identity/identity-service.js',
]);
const RUNTIME_ENVIRONMENT_AUTHORITY = new Set([
  'src/config.js',
  'src/platform/config.js',
  'src/platform-main.js',
  'src/demo/customer-main.js',
  'src/demo/platform-main.js',
]);
const CUSTOMER_DEMO_FORBIDDEN_MODULES = new Set([
  'src/platform-composition.js',
  'src/platform-main.js',
  'src/platform-production-authentication.js',
]);
const PLATFORM_DEMO_FORBIDDEN_MODULES = new Set([
  'src/index.js',
  'src/customer-composition.js',
  'src/server.js',
  'src/app.js',
  'src/security.js',
]);
const LEGACY_PLATFORM_BOUNDARY_MESSAGE = ': Customer runtime code must not import the Platform control-plane boundary ';
const SQL_STATEMENT = /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/;
const MEDIA_STORAGE_COMPOSITION_ROOTS = new Set([
  'src/index.js', 'src/customer-composition.js',
  'src/demo/customer-main.js', 'src/demo/customer-composition.js',
]);

function normalized(file) {
  return String(file).replaceAll('\\', '/');
}

function sourcesMap(sourceEntries) {
  const entries = sourceEntries instanceof Map
    ? sourceEntries
    : new Map(Object.entries(sourceEntries || {}));
  return new Map([...entries].map(([file, source]) => [normalized(file), String(source)]));
}

function demoSurfaceFile(file, surface) {
  if (!isInside(file, 'src/demo')) return false;
  const segments = normalized(file).split('/');
  const name = segments.at(-1);
  return segments.includes(surface)
    || name === `${surface}-main.js`
    || name === `${surface}-composition.js`
    || name === `${surface}-server.js`
    || name.startsWith(`${surface}-`);
}

function approvedLegacyPlatformDependencyViolation(item) {
  const separator = item.indexOf(LEGACY_PLATFORM_BOUNDARY_MESSAGE);
  if (separator < 0) return false;
  const sourceFile = item.slice(0, separator);
  return sourceFile === 'src/platform-production-authentication.js'
    || demoSurfaceFile(sourceFile, 'platform');
}

function firstReachablePath(graph, root, predicate) {
  const queue = [[root]];
  const visited = new Set([root]);
  while (queue.length > 0) {
    const currentPath = queue.shift();
    const current = currentPath.at(-1);
    if (current !== root && predicate(current)) return currentPath;
    for (const dependency of graph.get(current) || []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      queue.push([...currentPath, dependency]);
    }
  }
  return null;
}

function violation(file, message) {
  return `${file}: ${message}`;
}

function isCustomerDemoForbidden(dependency) {
  return CUSTOMER_DEMO_FORBIDDEN_MODULES.has(dependency)
    || isInside(dependency, 'src/platform')
    || (isInside(dependency, 'src/persistence/postgres')
      && path.posix.basename(dependency).startsWith('platform-'));
}

function isPlatformDemoForbidden(dependency) {
  return PLATFORM_DEMO_FORBIDDEN_MODULES.has(dependency)
    || isInside(dependency, 'src/identity')
    || isInside(dependency, 'src/http');
}

export function architectureConsolidationBoundaryViolations(sourceEntries) {
  const sources = sourcesMap(sourceEntries);
  const { graph } = buildModuleGraph(sources);
  const violations = [];

  for (const root of PRODUCTION_COMPOSITION_ROOTS) {
    if (!graph.has(root)) continue;
    const dependencyPath = firstReachablePath(graph, root, (file) => isInside(file, 'src/demo'));
    if (dependencyPath) {
      violations.push(violation(
        root,
        `Production composition must not reach the Demo runtime (${dependencyPath.join(' -> ')}).`,
      ));
    }
  }

  for (const file of graph.keys()) {
    const customerDemo = demoSurfaceFile(file, 'customer');
    const platformDemo = demoSurfaceFile(file, 'platform');
    if (!customerDemo && !platformDemo) continue;
    const dependencyPath = firstReachablePath(
      graph,
      file,
      customerDemo
        ? (dependency) => demoSurfaceFile(dependency, 'platform')
          || isCustomerDemoForbidden(dependency)
        : (dependency) => demoSurfaceFile(dependency, 'customer')
          || isPlatformDemoForbidden(dependency),
    );
    if (dependencyPath) {
      violations.push(violation(
        file,
        `${customerDemo ? 'customer' : 'Platform'} Demo security/session boundary must remain isolated (${dependencyPath.join(' -> ')}).`,
      ));
    }
  }

  for (const [file, source] of sources) {
    const imports = moduleImports(source);
    if (imports.some(({ specifier }) => specifier.startsWith('@aws-sdk/'))
      && file !== 'src/media/neon-object-storage.js') {
      violations.push(violation(file, 'the object-storage SDK is restricted to the private storage adapter.'));
    }
    if (graph.get(file)?.includes('src/media/neon-object-storage.js')
      && !MEDIA_STORAGE_COMPOSITION_ROOTS.has(file)) {
      violations.push(violation(file, 'concrete object storage may be imported only by customer composition roots.'));
    }
    if (/process\.env/.test(source) && !RUNTIME_ENVIRONMENT_AUTHORITY.has(file)) {
      violations.push(violation(
        file,
        'process.env access is restricted to approved configuration and process entrypoints.',
      ));
    }
    if (imports.some(({ specifier }) => specifier === 'pg')
      && !isInside(file, 'src/persistence/postgres')) {
      violations.push(violation(
        file,
        'the PostgreSQL driver is restricted to the PostgreSQL infrastructure boundary.',
      ));
    }
    if (SQL_STATEMENT.test(source) && !isInside(file, 'src/persistence/postgres')) {
      violations.push(violation(
        file,
        'SQL is restricted to the PostgreSQL infrastructure boundary.',
      ));
    }

    for (const dependency of graph.get(file) || []) {
      if (isInside(file, 'src/demo')
        && REAL_PRODUCTION_IDENTITY_AND_PROVIDER_MODULES.has(dependency)) {
        violations.push(violation(
          file,
          `Demo runtime must not import Production identity/provider implementation ${dependency}.`,
        ));
      }
    }

    if (isInside(file, 'src/demo')
      && imports.some(({ specifier }) => specifier === '@azure/msal-node')) {
      violations.push(violation(
        file,
        'Demo runtime must not import the real Microsoft Entra client dependency.',
      ));
    }
  }

  const runtimeConfig = sources.get('src/demo/runtime-config.js');
  if (runtimeConfig) {
    for (const required of [
      'customer_session_secret',
      'customer_csrf_secret',
      'platform_session_secret',
      'platform_csrf_secret',
    ]) {
      if (!runtimeConfig.includes(required)) {
        violations.push(violation(
          'src/demo/runtime-config.js',
          `customer and Platform Demo credentials must remain separate (${required} is missing).`,
        ));
      }
    }
  }
  const demoConfig = sources.get('src/demo/config.js');
  if (demoConfig && !demoConfig.includes('DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN')) {
    violations.push(violation(
      'src/demo/config.js',
      'Demo configuration must reject aliased customer, Platform, and reset credentials.',
    ));
  }

  return Object.freeze([...new Set(violations)].sort());
}

export function moduleBoundaryViolations(sourceEntries) {
  const sources = sourcesMap(sourceEntries);
  const establishedViolations = backendSaas2BoundaryViolations(sources)
    .filter((item) => !approvedLegacyPlatformDependencyViolation(item));
  return Object.freeze([
    ...new Set([
      ...establishedViolations,
      ...architectureConsolidationBoundaryViolations(sources),
    ]),
  ].sort());
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current.replaceAll('\\', '/'));
  }
  return files;
}

async function main() {
  const sources = new Map();
  for (const file of await sourceFiles('src')) sources.set(file, await readFile(file, 'utf8'));
  const violations = moduleBoundaryViolations(sources);
  if (violations.length) {
    for (const item of violations) console.error(item);
    process.exitCode = 1;
    return;
  }
  console.log(`General backend module boundary check passed for ${sources.size} source modules.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
