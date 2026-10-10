import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { outboundConfigurationViolation } from '../scripts/outbound-configuration-boundary.mjs';
import { createNeonBranchStorageConfig } from '../src/media/neon-storage-config.js';

const PROVIDER_CONFIG = 'src/media/neon-storage-config.js';

test('only the exact pure Neon provider configuration receives the reviewed endpoint exception', async () => {
  const content = await readFile(new URL(`../${PROVIDER_CONFIG}`, import.meta.url), 'utf8');
  assert.equal(outboundConfigurationViolation(PROVIDER_CONFIG, content), null);
  for (const file of ['src/demo/media-storage-config.js', 'src/demo/media-storage-runtime.js',
    'src/demo/customer-main.js', 'src/demo/platform-main.js', 'src/platform/config.js',
    'src/media/neon-object-storage.js', 'src/media/other-storage-config.js']) {
    for (const url of ['https://', 'http://', 'https://unapproved.invalid', 'http://127.0.0.1',
      'https://${branch}.storage.c-5.eu-central-1.aws.neon.tech']) {
      assert.match(outboundConfigurationViolation(file, `const destination = '${url}';`), /hard-coded outbound URL/);
    }
  }
});

test('the pure provider exception cannot introduce a second URL, region, SDK, environment or transport', async () => {
  const content = await readFile(new URL(`../${PROVIDER_CONFIG}`, import.meta.url), 'utf8');
  for (const extra of ["const other = 'https://unapproved.invalid';",
    "const other = 'http://${branch}.storage.c-5.eu-central-1.aws.neon.tech';",
    "const other = 'https://${branch}.storage.c-5.us-east-1.aws.neon.tech';",
    "import { S3Client } from '@aws-sdk/client-s3';", 'const credentials = process.env;',
    'fetch(destination);', 'request(destination);', "const sdk = require('@aws-sdk/client-s3');"]) {
    assert.match(outboundConfigurationViolation(PROVIDER_CONFIG, `${content}\n${extra}`), /must remain pure Neon configuration/);
  }
});

test('provider helper derives the fixed endpoint only after branch validation and preserves strict credential validation', () => {
  const input = { branch: 'br-synthetic-provider-test', bucket: 'conference-manager-media',
    accessKeyId: 'synthetic-provider-access', secretAccessKey: 'synthetic-provider-secret-00001' };
  const config = createNeonBranchStorageConfig(input);
  assert.equal(config.endpoint, 'https://br-synthetic-provider-test.storage.c-5.eu-central-1.aws.neon.tech');
  assert.equal(config.region, 'eu-central-1');
  assert.equal(Object.isFrozen(config), true);
  for (const branch of ['https://unapproved.invalid', 'br-safe/path', 'br-safe?query', 'br-safe\n', undefined]) {
    assert.throws(() => createNeonBranchStorageConfig({ ...input, branch }), /MEDIA_STORAGE_BRANCH_INVALID/);
  }
  assert.throws(() => createNeonBranchStorageConfig({ ...input, secretAccessKey: '' }), /MEDIA_STORAGE_CONFIG_INVALID/);
});
