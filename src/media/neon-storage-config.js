const ENDPOINT = /^https:\/\/br-[a-z0-9-]+\.storage\.c-5\.eu-central-1\.aws\.neon\.tech$/;
const BRANCH = /^br-[a-z0-9-]{5,80}$/;

export function validateNeonStorageBranchId(branch) {
  if (typeof branch !== 'string' || branch !== branch.trim() || !BRANCH.test(branch)) {
    throw new TypeError('MEDIA_STORAGE_BRANCH_INVALID');
  }
  return branch;
}

// Pure provider configuration: only a validated branch can vary the fixed Frankfurt
// storage destination. No SDK, environment access, credentials lookup or transport.
export function createNeonBranchStorageConfig({ branch, bucket, accessKeyId, secretAccessKey } = {}) {
  validateNeonStorageBranchId(branch);
  return validateNeonStorageConfig({
    endpoint: `https://${branch}.storage.c-5.eu-central-1.aws.neon.tech`,
    region: 'eu-central-1', bucket, accessKeyId, secretAccessKey,
  });
}

export function validateNeonStorageConfig(config) {
  if (!config || !ENDPOINT.test(config.endpoint) || config.region !== 'eu-central-1'
    || typeof config.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
    || typeof config.accessKeyId !== 'string' || config.accessKeyId.length < 8 || config.accessKeyId.length > 256
    || typeof config.secretAccessKey !== 'string' || config.secretAccessKey.length < 16
    || config.secretAccessKey.length > 512 || /[\s\x00-\x1f]/.test(config.accessKeyId + config.secretAccessKey)) {
    throw new TypeError('MEDIA_STORAGE_CONFIG_INVALID');
  }
  return Object.freeze({ ...config });
}
