import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DENIED_LICENSE = /\b(?:AGPL|GPL)-3\.0(?:-only|-or-later)?\b/i;

function dependencySections(manifest) {
  return {
    dependencies: manifest.dependencies || {},
    devDependencies: manifest.devDependencies || {},
  };
}

function assertSameSection(name, manifestSection, lockSection) {
  const manifestEntries = Object.entries(manifestSection).sort(([a], [b]) => a.localeCompare(b));
  const lockEntries = Object.entries(lockSection || {}).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(manifestEntries) !== JSON.stringify(lockEntries)) {
    throw new Error(`${name} must match package-lock.json exactly`);
  }
}

export function validateDependencyPolicy(manifest, lockfile) {
  if (!lockfile || lockfile.lockfileVersion < 3 || !lockfile.packages?.['']) {
    throw new Error('package-lock.json must use lockfileVersion 3 or newer');
  }

  const root = lockfile.packages[''];
  const sections = dependencySections(manifest);
  assertSameSection('dependencies', sections.dependencies, root.dependencies);
  assertSameSection('devDependencies', sections.devDependencies, root.devDependencies);

  for (const [sectionName, dependencies] of Object.entries(sections)) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!EXACT_VERSION.test(version)) {
        throw new Error(`${sectionName}.${name} must use an exact semantic version`);
      }
      const installed = lockfile.packages[`node_modules/${name}`];
      if (!installed || installed.version !== version) {
        throw new Error(`${name} must resolve to the exact locked direct dependency version`);
      }
    }
  }

  for (const [path, dependency] of Object.entries(lockfile.packages)) {
    if (!path) continue;
    if (dependency.hasInstallScript === true) {
      throw new Error(`${path} declares an install lifecycle script`);
    }
    const license = dependency.license;
    if (typeof license !== 'string' || !license.trim()) {
      throw new Error(`${path} must declare license metadata in package-lock.json`);
    }
    if (DENIED_LICENSE.test(license)) {
      throw new Error(`${path} uses denied license ${license}`);
    }
  }
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateDependencyPolicy(readJson('package.json'), readJson('package-lock.json'));
  console.log('Dependency policy check passed.');
}
