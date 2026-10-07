import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const compressGzip = promisify(gzip);
const compressBrotli = promisify(brotliCompress);

function inside(root, candidate) {
  return candidate.startsWith(`${root}${path.sep}`);
}

export function createDemoStaticFileAdapter({ root } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('DEMO_STATIC_ROOT_REQUIRED');
  const resolvedRoot = path.resolve(root);
  const realRootPromise = realpath(resolvedRoot);
  const approvedFiles = new WeakSet();
  const cache = new Map();
  let cacheBytes = 0;
  let active = 0;

  async function representation(file, { encoding = 'identity' } = {}) {
    if (!approvedFiles.has(file) || !['identity', 'gzip', 'br'].includes(encoding)) {
      throw new TypeError('DEMO_STATIC_FILE_REQUIRED');
    }
    if (encoding !== 'identity' && file.size > 1048576) throw new TypeError('DEMO_STATIC_COMPRESSION_BOUND');
    const key = `${file.path}\0${file.identity}\0${encoding}`;
    if (cache.has(key)) {
      const entry = cache.get(key); cache.delete(key); cache.set(key, entry);
      return entry;
    }
    if (active >= 8) throw new Error('DEMO_STATIC_CAPACITY_EXCEEDED');
    active += 1;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of createReadStream(file.path)) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new Error('DEMO_STATIC_FILE_TOO_LARGE');
        chunks.push(chunk);
      }
      const current = await stat(file.path);
      const identity = `${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}`;
      if (identity !== file.identity || size !== file.size) throw new Error('DEMO_STATIC_FILE_CHANGED');
      const raw = Buffer.concat(chunks, size);
      const digest = createHash('sha256').update(raw).digest('hex');
      const bytes = encoding === 'gzip' ? await compressGzip(raw, { level: 6 })
        : encoding === 'br' ? await compressBrotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : raw;
      const entry = Object.freeze({ bytes, encoding, digest,
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"` });
      if (bytes.length <= MAX_CACHE_BYTES) {
        if (cache.has(key)) { cacheBytes -= cache.get(key).bytes.length; cache.delete(key); }
        while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes.length > MAX_CACHE_BYTES) {
          const oldest = cache.keys().next().value;
          cacheBytes -= cache.get(oldest).bytes.length; cache.delete(oldest);
        }
        cache.set(key, entry); cacheBytes += bytes.length;
      }
      return entry;
    } finally { active -= 1; }
  }

  return Object.freeze({
    async open(relativePath) {
      if (typeof relativePath !== 'string' || !relativePath) {
        return Object.freeze({ kind: 'invalid' });
      }
      const candidate = path.resolve(resolvedRoot, relativePath);
      if (!inside(resolvedRoot, candidate)) return Object.freeze({ kind: 'invalid' });

      let realRoot;
      let realFilePath;
      let fileStat;
      try {
        [realRoot, realFilePath] = await Promise.all([realRootPromise, realpath(candidate)]);
        fileStat = await stat(realFilePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return Object.freeze({ kind: 'missing' });
        }
        throw error;
      }
      if (!inside(realRoot, realFilePath)) return Object.freeze({ kind: 'invalid' });
      if (!fileStat.isFile()) return Object.freeze({ kind: 'missing' });
      if (fileStat.size > MAX_FILE_BYTES) return Object.freeze({ kind: 'too_large' });
      const file = Object.freeze({
        kind: 'file',
        path: realFilePath,
        size: fileStat.size,
        identity: `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`,
      });
      approvedFiles.add(file);
      return file;
    },

    representation,

    async pipe(file, response) {
      if (!approvedFiles.has(file)) {
        throw new TypeError('DEMO_STATIC_FILE_REQUIRED');
      }
      await pipeline(createReadStream(file.path), response);
    },
  });
}
