import http from 'node:http';

// This process intentionally owns no database, storage, static files or business workers.
export async function startDemoClosedRuntime({ config, surface, trafficGate } = {}) {
  const server = http.createServer({ maxHeaderSize: 16_384, requireHostHeader: true }, (request, response) => {
    trafficGate.handle(request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port || (surface === 'customer' ? 3000 : 3100), config.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let stopped = false;
  return Object.freeze({
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections();
          reject(new Error('DEMO_CLOSED_SHUTDOWN_TIMEOUT'));
        }, 10_000);
        server.close((error) => {
          clearTimeout(timeout);
          if (error) reject(new Error('DEMO_CLOSED_SHUTDOWN_FAILED'));
          else resolve();
        });
      });
    },
  });
}
