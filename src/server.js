import http from 'node:http';
import { createApp } from './app.js';

export function createHttpServer(options) {
  const { config } = options;
  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, createApp(options));

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  return server;
}
