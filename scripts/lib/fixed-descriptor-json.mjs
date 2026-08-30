import { fstatSync, readSync, writeSync } from 'node:fs';

const MAX_BYTES = 16_384;

function descriptorError(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function readFixedDescriptorJson(descriptor = 3) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 9) {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_INVALID');
  }
  const stat = fstatSync(descriptor);
  if (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isDirectory()) {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_TYPE_INVALID');
  }
  const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
  let offset = 0;
  while (offset <= MAX_BYTES) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset === 0 || offset > MAX_BYTES) descriptorError('PLATFORM_FIXED_DESCRIPTOR_SIZE_INVALID');
  try {
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } catch {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_JSON_INVALID');
  }
}

export function writeSecretToFixedDescriptor(secret, descriptor = 4) {
  if (typeof secret !== 'string' || /[\r\n\u0000]/.test(secret)) {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_SECRET_INVALID');
  }
  const stat = fstatSync(descriptor);
  if (stat.isFile() && (stat.mode & 0o077) !== 0) {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_PERMISSIONS_INVALID');
  }
  if (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isDirectory()) {
    descriptorError('PLATFORM_FIXED_DESCRIPTOR_TYPE_INVALID');
  }
  const payload = Buffer.from(`${secret}\n`, 'ascii');
  let offset = 0;
  while (offset < payload.length) offset += writeSync(descriptor, payload, offset);
}
