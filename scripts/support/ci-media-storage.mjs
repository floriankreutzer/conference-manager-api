import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createNeonObjectStorage } from '../../src/media/neon-object-storage.js';
import { mediaObjectReference, MEDIA_OBJECT_MAX_BYTES } from '../../src/media/object-storage-contract.js';

const BUCKET = 'ci-private-media';
export const CI_MEDIA_STORAGE_PORT = 9130;
const MAX_OBJECTS = 10000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function assertToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new TypeError('CI_MEDIA_STORAGE_AUTHORITY_REQUIRED');
}

function assertPort(port) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('CI_MEDIA_STORAGE_PORT_INVALID');
}

function xmlError(response, status, code) {
  const body = `<Error><Code>${code}</Code></Error>`;
  response.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

// Test infrastructure only: a bounded private loopback S3 protocol fixture. It is never
// selected by a production/Demo runtime entrypoint or configured through a browser input.
export function createCiMediaStorageServer({ token, port = CI_MEDIA_STORAGE_PORT }) {
  assertToken(token);
  assertPort(port);
  const objects = new Map();
  let totalBytes = 0;
  const server = http.createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    if (request.url === '/ready' && request.method === 'GET') { response.writeHead(200); response.end(); return; }
    const authority = request.headers['x-ci-object-authority'];
    if (typeof authority !== 'string' || !/^[a-f0-9]{64}$/.test(authority)
      || !timingSafeEqual(Buffer.from(authority), Buffer.from(token))) { xmlError(response, 403, 'AccessDenied'); return; }
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) { xmlError(response, 405, 'MethodNotAllowed'); return; }
    let pathname;
    try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; } catch { xmlError(response, 400, 'InvalidRequest'); return; }
    const parts = pathname.split('/');
    if (parts.length !== 7 || parts[1] !== BUCKET || parts[2] !== 'v1') { xmlError(response, 404, 'NoSuchKey'); return; }
    const key = parts.slice(2).join('/');
    if (request.method === 'GET') {
      const object = objects.get(key);
      if (!object) { xmlError(response, 404, 'NoSuchKey'); return; }
      response.writeHead(200, { 'Content-Type': object.reference.contentType, 'Content-Length': object.bytes.length });
      response.end(object.bytes);
      return;
    }
    if (request.method === 'DELETE') {
      totalBytes -= objects.get(key)?.bytes.length || 0;
      objects.delete(key);
      response.writeHead(204); response.end(); return;
    }
    const length = request.headers['content-length'];
    if (typeof length !== 'string' || !/^\d{1,7}$/.test(length)
      || Number(length) < 1 || Number(length) > MEDIA_OBJECT_MAX_BYTES) { xmlError(response, 400, 'InvalidRequest'); return; }
    try {
      const reference = mediaObjectReference({ tenantId: parts[3], kind: parts[4], assetId: parts[5], sha256: parts[6],
        byteLength: Number(length), contentType: request.headers['content-type'] });
      if (reference.key !== key) throw new Error('INVALID_KEY');
      const chunks = [];
      let received = 0;
      for await (const chunk of request) {
        received += chunk.length;
        if (received > reference.byteLength) { request.destroy(); return; }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, received);
      if (received !== reference.byteLength || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
        throw new Error('INVALID_BYTES');
      }
      const previous = objects.get(key);
      if (previous && previous.reference.contentType !== reference.contentType) { xmlError(response, 409, 'Conflict'); return; }
      if ((!previous && objects.size >= MAX_OBJECTS)
        || totalBytes - (previous?.bytes.length || 0) + bytes.length > MAX_TOTAL_BYTES) { xmlError(response, 503, 'SlowDown'); return; }
      totalBytes += bytes.length - (previous?.bytes.length || 0);
      objects.set(key, { reference, bytes });
      response.writeHead(200, { 'Content-Length': 0 }); response.end();
    } catch {
      if (!response.headersSent && !response.destroyed) xmlError(response, 400, 'InvalidRequest');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 100;
  return Object.freeze({
    server,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return server.address();
    },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); objects.clear(); },
  });
}

export function createCiMediaObjectStorage({ token, port = CI_MEDIA_STORAGE_PORT }) {
  assertToken(token);
  assertPort(port);
  if (port === 0) throw new TypeError('CI_MEDIA_STORAGE_PORT_INVALID');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8 });
  const requestHandler = {
    handle(request, { abortSignal } = {}) {
      return new Promise((resolve, reject) => {
        const outgoing = http.request({ hostname: '127.0.0.1', port, agent, signal: abortSignal,
          method: request.method, path: request.path,
          headers: { ...request.headers, 'x-ci-object-authority': token } }, (response) => {
          resolve({ response: { statusCode: response.statusCode, headers: response.headers, body: response } });
        });
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('CI_MEDIA_STORAGE_TIMEOUT')));
        outgoing.once('error', reject);
        outgoing.end(request.body);
      });
    },
    destroy() { agent.destroy(); },
  };
  return createNeonObjectStorage({ endpoint: 'https://br-ci-object-acceptance.storage.c-5.eu-central-1.aws.neon.tech',
    region: 'eu-central-1', bucket: BUCKET, accessKeyId: 'ci-object-access-key', secretAccessKey: token }, {
    clientFactory(options) { return new S3Client({ ...options, requestHandler }); },
  });
}
