import http from 'node:http';

import {
  DemoRuntimeGateError,
  withDemoRuntimeSharedGate,
} from '../persistence/postgres/demo-runtime-gate.js';
import { createPlatformApp } from '../platform/app.js';
import {
  applyPlatformSecurityHeaders,
  createPlatformRequestId,
} from '../platform/http/security.js';

const RESET_PATH = '/api/v1/platform/demo/reset';

function sendRuntimeFailure(response, config, error) {
  if (response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const requestId = createPlatformRequestId();
  const unavailable = error instanceof DemoRuntimeGateError;
  const body = JSON.stringify({ error: Object.freeze({
    code: unavailable ? 'PLATFORM_DEMO_RUNTIME_UNAVAILABLE' : 'PLATFORM_INTERNAL_ERROR',
    requestId,
  }) });
  applyPlatformSecurityHeaders(response, config);
  response.statusCode = unavailable ? 503 : 500;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function requestPath(request, publicOrigin) {
  try {
    return new URL(request.url, publicOrigin).pathname;
  } catch {
    return null;
  }
}

export function createDemoPlatformHttpServer(options) {
  const { config, persistence, demoRuntimeGatePool } = options || {};
  if (
    !config?.demoRuntime
    || !persistence?.pool
    || !demoRuntimeGatePool
    || typeof demoRuntimeGatePool.connect !== 'function'
    || demoRuntimeGatePool === persistence.pool
  ) {
    throw new TypeError('DEMO_PLATFORM_SERVER_CONFIG_REQUIRED');
  }
  const app = createPlatformApp(options);
  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, async (request, response) => {
    if (request.method === 'POST' && requestPath(request, config.publicOrigin) === RESET_PATH) {
      await app(request, response);
      return;
    }
    try {
      await withDemoRuntimeSharedGate(demoRuntimeGatePool, () => app(request, response));
    } catch (error) {
      sendRuntimeFailure(response, config, error);
    }
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  return server;
}
