import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDependencyPolicy } from '../scripts/check-dependencies.mjs';

function fixture({ version = '1.2.3', license = 'MIT', hasInstallScript = false } = {}) {
  return {
    manifest: {
      dependencies: { example: version },
    },
    lockfile: {
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: { example: version },
        },
        'node_modules/example': {
          version,
          license,
          ...(hasInstallScript ? { hasInstallScript: true } : {}),
        },
      },
    },
  };
}

test('dependency policy accepts exact locked dependencies with approved licenses', () => {
  const { manifest, lockfile } = fixture();
  assert.doesNotThrow(() => validateDependencyPolicy(manifest, lockfile));
});

test('dependency policy rejects version ranges and lockfile drift', () => {
  const ranged = fixture({ version: '^1.2.3' });
  assert.throws(
    () => validateDependencyPolicy(ranged.manifest, ranged.lockfile),
    /exact semantic version/,
  );

  const drift = fixture();
  drift.lockfile.packages[''].dependencies.example = '1.2.4';
  assert.throws(
    () => validateDependencyPolicy(drift.manifest, drift.lockfile),
    /must match package-lock.json exactly/,
  );
});

test('dependency policy rejects denied licenses and install lifecycle scripts', () => {
  const denied = fixture({ license: 'GPL-3.0-only' });
  assert.throws(
    () => validateDependencyPolicy(denied.manifest, denied.lockfile),
    /denied license/,
  );

  const scripted = fixture({ hasInstallScript: true });
  assert.throws(
    () => validateDependencyPolicy(scripted.manifest, scripted.lockfile),
    /install lifecycle script/,
  );
});

test('dependency policy requires license metadata for installed packages', () => {
  const missing = fixture({ license: '' });
  assert.throws(
    () => validateDependencyPolicy(missing.manifest, missing.lockfile),
    /license metadata/,
  );
});
