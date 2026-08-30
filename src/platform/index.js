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

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function createPlatformProcess({ env, config = loadPlatformConfig(env), ...dependencies } = {}) {
  if (!env && !config) throw new TypeError('PLATFORM_ENV_OR_CONFIG_REQUIRED');
  const server = createPlatformHttpServer({ config, ...dependencies });
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
      await close(server);
      started = false;
    },
  });
}
