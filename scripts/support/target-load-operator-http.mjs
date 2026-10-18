import http from 'node:http';
import { applySecurityHeaders, assertRequestHost } from '../../src/security.js';
import { loadObserverAuthorized } from './target-load-guard.mjs';

const PHASES = new Set(['preparing', 'waiting', 'measuring', 'measured', 'failed']);

export function createTargetOperatorServer({ settings, status, clock = Date.now } = {}) {
  let window = clock(); let previous = window; let reads = 0; let closed = false;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000,
    headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    function send(code, value = '') {
      applySecurityHeaders(response, { mode: 'production' });
      response.writeHead(code, { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(value), Connection: 'close' }); response.end(value);
    }
    const now = clock();
    if (closed || !Number.isSafeInteger(now) || now < previous || now >= settings.scope.expiresMs - 10_000) {
      closed = true; send(503); return;
    }
    previous = now;
    try {
      const count = name => request.rawHeaders.reduce((n, key, i) => n + (i % 2 === 0 && key.toLowerCase() === name ? 1 : 0), 0);
      if (count('host') !== 1) throw new Error();
      assertRequestHost(request.headers, settings.origin);
      if (request.method !== 'GET' || request.headers['transfer-encoding'] !== undefined
        || ![undefined, '0'].includes(request.headers['content-length'])) throw new Error();
      if (request.url === '/__load/health') { send(200, '{"status":"ok"}'); return; }
      if (now - window >= 60_000) { window = now; reads = 0; }
      reads += 1;
      if (reads > 120 || request.url !== '/__load/status' || count('authorization') !== 1
        || !loadObserverAuthorized(request.headers.authorization, settings.token)) throw new Error();
      const value = status();
      if (!PHASES.has(value.phase) || Object.keys(value).some(key => !['phase', 'evidence'].includes(key))) throw new Error();
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 65_536) throw new Error();
      send(200, body);
    } catch { send(404); }
  });
  server.maxConnections = 16;
  return server;
}
