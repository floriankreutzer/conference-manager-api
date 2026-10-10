import test from 'node:test';
import assert from 'node:assert/strict';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

test('SDK and concrete storage cannot enter HTTP, business, domain, SQL or Platform modules', () => {
  for (const file of ['src/http/room-media.js', 'src/application/room-media-service.js',
    'src/domain/media.js', 'src/persistence/postgres/room-media-repository.js', 'src/platform/media.js',
    'src/platform-main.js', 'src/demo/customer-provider.js']) {
    assert.ok(architectureConsolidationBoundaryViolations({
      [file]: "import { S3Client } from '@aws-sdk/client-s3';",
    }).some((entry) => entry.includes('SDK is restricted')));
    const prefix = file.startsWith('src/persistence/') ? '../../' : file === 'src/platform-main.js' ? './' : '../';
    assert.ok(architectureConsolidationBoundaryViolations({
      [file]: `import '${prefix}media/neon-object-storage.js';`,
      'src/media/neon-object-storage.js': 'export const storage = true;',
    }).some((entry) => entry.includes('only by customer composition roots')));
  }
});

test('provider-neutral media contract is available to repositories; SDK stays in adapter', () => {
  assert.deepEqual(architectureConsolidationBoundaryViolations({
    'src/persistence/postgres/room-media-repository.js': "import '../../media/object-storage-contract.js';",
    'src/media/object-storage-contract.js': 'export const reference = true;',
    'src/media/neon-object-storage.js': "import { S3Client } from '@aws-sdk/client-s3';",
    'src/customer-composition.js': "import './media/neon-object-storage.js';",
  }), []);
});

test('operator backfill and rollback cannot become a runtime or browser-controlled authority', () => {
  for (const file of ['src/index.js', 'src/customer-composition.js', 'src/platform-main.js',
    'src/demo/platform-composition.js', 'src/http/room-media.js', 'src/persistence/postgres/index.js']) {
    const prefix = file.startsWith('src/persistence/') ? './' : file.split('/').length === 3 ? '../persistence/postgres/'
      : './persistence/postgres/';
    assert.ok(architectureConsolidationBoundaryViolations({
      [file]: `import '${prefix}media-backfill-repository.js';`,
      'src/persistence/postgres/media-backfill-repository.js': 'export const backfill = true;',
    }).some((entry) => entry.includes('operator media migration')));
  }
});

test('only Demo process entrypoints can reach the shared media startup factory', () => {
  const factory = 'src/demo/media-storage-runtime.js';
  const adapter = 'src/media/neon-object-storage.js';
  for (const file of ['src/demo/customer-main.js', 'src/demo/platform-main.js']) {
    assert.deepEqual(architectureConsolidationBoundaryViolations({
      [file]: "import './media-storage-runtime.js';",
      [factory]: "import '../media/neon-object-storage.js';",
      [adapter]: 'export const storage = true;',
    }), []);
  }
  for (const file of ['src/platform-main.js', 'src/platform/media.js', 'src/demo/platform-composition.js',
    'src/demo/customer-composition.js', 'src/http/room-media.js', 'src/demo/http/customer-control-routes.js']) {
    const prefix = file.startsWith('src/demo/http/') ? '../' : file.startsWith('src/demo/') ? './'
      : file === 'src/platform-main.js' ? './demo/' : '../demo/';
    assert.ok(architectureConsolidationBoundaryViolations({
      [file]: `import '${prefix}media-storage-runtime.js';`,
      [factory]: "import '../media/neon-object-storage.js';",
      [adapter]: 'export const storage = true;',
    }).some((entry) => entry.includes('factory is restricted to Demo process entrypoints')));
  }
});
