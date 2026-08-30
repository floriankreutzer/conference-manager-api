import http from 'node:http';

import { createApp } from '../app.js';
import {
  DemoRuntimeGateError,
  withDemoRuntimeSharedGate,
} from '../persistence/postgres/demo-runtime-gate.js';
import { applySecurityHeaders, createRequestId } from '../security.js';
import { createDemoStaticHandler } from './static-handler.js';

const LIVENESS_PATH = '/api/v1/health/live';

function requestPath(request, publicOrigin) {
  try {
    return new URL(request.url, publicOrigin).pathname;
  } catch {
    return null;
  }
}

function sendRuntimeFailure(response, config, error) {
  if (response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const requestId = createRequestId();
  const unavailable = error instanceof DemoRuntimeGateError;
  const body = JSON.stringify({ error: Object.freeze({
    code: unavailable ? 'DEMO_RUNTIME_UNAVAILABLE' : 'INTERNAL_ERROR',
    requestId,
  }) });
  applySecurityHeaders(response, config);
  response.statusCode = unavailable ? 503 : 500;
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

export function createDemoCustomerHttpServer(options) {
  const { config, persistence, demoRuntimeGatePool } = options || {};
  if (
    !config?.demoRuntime
    || !persistence?.pool
    || !demoRuntimeGatePool
    || typeof demoRuntimeGatePool.connect !== 'function'
    || demoRuntimeGatePool === persistence.pool
  ) {
    throw new TypeError('DEMO_CUSTOMER_SERVER_CONFIG_REQUIRED');
  }
  const app = createApp(options);
  const staticHandler = config.staticRoot
    ? createDemoStaticHandler({ root: config.staticRoot, surface: 'customer' })
    : null;
  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, async (request, response) => {
    const path = requestPath(request, config.publicOrigin);
    if (path === LIVENESS_PATH) {
      await app(request, response);
      return;
    }
    if (staticHandler && !path?.startsWith('/api/')) {
      try {
        await staticHandler(request, response);
      } catch (error) {
        sendRuntimeFailure(response, config, error);
      }
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
