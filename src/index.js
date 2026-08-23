import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const logger = createLogger();
const server = createHttpServer({ config, logger });

function shutdown(signal) {
  logger.lifecycle({ event: `shutdown_${signal.toLowerCase()}` });
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, config.host, () => {
  logger.lifecycle({ event: 'server_started' });
});
