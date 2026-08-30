import http from 'node:http';
import { createPlatformApp } from './app.js';

export function createPlatformHttpServer(options) {
  const { config } = options || {};
  if (!config) throw new TypeError('PLATFORM_CONFIG_REQUIRED');
  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, createPlatformApp(options));
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  return server;
}
