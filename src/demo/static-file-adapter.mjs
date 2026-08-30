import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

function inside(root, candidate) {
  return candidate.startsWith(`${root}${path.sep}`);
}

export function createDemoStaticFileAdapter({ root } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('DEMO_STATIC_ROOT_REQUIRED');
  const resolvedRoot = path.resolve(root);
  const realRootPromise = realpath(resolvedRoot);

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
      return Object.freeze({
        kind: 'file',
        path: realFilePath,
        size: fileStat.size,
      });
    },

    async pipe(file, response) {
      if (!file || file.kind !== 'file' || typeof file.path !== 'string') {
        throw new TypeError('DEMO_STATIC_FILE_REQUIRED');
      }
      await pipeline(createReadStream(file.path), response);
    },
  });
}
