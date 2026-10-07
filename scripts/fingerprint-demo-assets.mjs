import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REFERENCES = 200;

// Build-only transform of the reviewed copied HTML. No network, provider authority,
// source checkout changes, browser input or arbitrary HTML execution is involved.
export async function fingerprintDemoAssets(root, htmlPaths = ['index.html', 'platform-admin-demo/index.html']) {
  const realRoot = await realpath(root);
  const digests = new Map();
  let references = 0;
  for (const htmlPath of htmlPaths) {
    if (!['index.html', 'platform-admin-demo/index.html'].includes(htmlPath)) throw new Error('DEMO_FINGERPRINT_HTML_INVALID');
    const filename = await realpath(path.join(realRoot, htmlPath));
    if (!filename.startsWith(`${realRoot}${path.sep}`)) throw new Error('DEMO_FINGERPRINT_PATH_INVALID');
    const chunks = []; let length = 0;
    for await (const chunk of createReadStream(filename)) {
      length += chunk.length;
      if (length > MAX_HTML_BYTES) throw new Error('DEMO_FINGERPRINT_HTML_TOO_LARGE');
      chunks.push(chunk);
    }
    const source = Buffer.concat(chunks, length);
    let html = source.toString('utf8');
    for (const match of html.matchAll(/\b(?:src|href)=(['"])([^'"]{1,8192})\1/g)) {
      const url = new URL(match[2], `demo://local/${htmlPath}`);
      if (url.protocol !== 'demo:' || url.hostname !== 'local' || url.hash
        || !/^\/(?:assets|src)\//.test(url.pathname)) continue;
      references += 1;
      if (references > MAX_REFERENCES) throw new Error('DEMO_FINGERPRINT_REFERENCE_BOUND');
      const target = await realpath(path.join(realRoot, decodeURIComponent(url.pathname.slice(1))));
      if (!target.startsWith(`${realRoot}${path.sep}`)) throw new Error('DEMO_FINGERPRINT_PATH_INVALID');
      let digest = digests.get(target);
      if (!digest) {
        const hash = createHash('sha256'); let length = 0;
        for await (const chunk of createReadStream(target)) {
          length += chunk.length;
          if (length > MAX_FILE_BYTES) throw new Error('DEMO_FINGERPRINT_FILE_TOO_LARGE');
          hash.update(chunk);
        }
        digest = hash.digest('hex'); digests.set(target, digest);
      }
      url.search = ''; url.searchParams.set('sha256', digest);
      const rewritten = match[0].replace(match[2], `${url.pathname}${url.search}`);
      html = html.replace(match[0], rewritten);
    }
    await writeFile(filename, html, { encoding: 'utf8' });
  }
  return Object.freeze({ references, files: digests.size });
}
