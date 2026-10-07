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
