import { loadPlatformConfig } from './config.js';
import { createPlatformHttpServer } from './server.js';

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function closePlatformHttpServerWithinDeadline(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        server.closeAllConnections();
      } catch {
        // The timeout remains the authoritative shutdown failure.
      }
      reject(new Error('PLATFORM_SHUTDOWN_TIMEOUT'));
    }, timeoutMs);

    try {
      server.close((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export function createPlatformProcess({
  env,
  config = loadPlatformConfig(env),
  httpServerFactory = createPlatformHttpServer,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ...dependencies
} = {}) {
  if (!env && !config) throw new TypeError('PLATFORM_ENV_OR_CONFIG_REQUIRED');
  if (typeof httpServerFactory !== 'function') throw new TypeError('PLATFORM_HTTP_SERVER_FACTORY_REQUIRED');
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new TypeError('PLATFORM_SHUTDOWN_TIMEOUT_INVALID');
  }
  const server = httpServerFactory({ config, ...dependencies });
  let started = false;
  return Object.freeze({
    config,
    server,
    async start() {
      if (started) throw new TypeError('PLATFORM_PROCESS_ALREADY_STARTED');
      const address = await listen(server, config);
      started = true;
      return address;
    },
    async stop() {
      if (!started) return;
      try {
        await closePlatformHttpServerWithinDeadline(server, shutdownTimeoutMs);
      } finally {
        started = false;
      }
    },
  });
}
