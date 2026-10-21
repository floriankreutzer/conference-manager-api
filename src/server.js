import http from 'node:http';
import { createApp } from './app.js';

export function createHttpServer(options) {
  const { config,requestHandlerFactory=null } = options;
  if (requestHandlerFactory!==null && typeof requestHandlerFactory!=='function') {
    throw new TypeError('HTTP_REQUEST_HANDLER_FACTORY_INVALID');
  }
  const app=createApp(options),handler=requestHandlerFactory===null ? app : requestHandlerFactory(app);
  if (typeof handler!=='function') throw new TypeError('HTTP_REQUEST_HANDLER_INVALID');
  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, handler);

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  return server;
}
