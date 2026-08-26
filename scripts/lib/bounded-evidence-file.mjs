import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function readBoundedRegularFile(path, { maxBytes } = {}) {
  if (typeof path !== 'string' || path.length < 1) throw new TypeError('EVIDENCE_FILE_PATH_INVALID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('EVIDENCE_FILE_BOUND_INVALID');

  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new TypeError('EVIDENCE_FILE_INVALID');

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new TypeError('EVIDENCE_FILE_INVALID');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await file?.close();
  }
}
