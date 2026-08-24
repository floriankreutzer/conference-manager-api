import { createRequestService } from './application/request-service.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { loadConfig } from './config.js';
import { createSessionService } from './identity/session-service.js';
import { createLogger } from './logger.js';
import { createPostgresPersistence } from './persistence/postgres/index.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const logger = createLogger();
const persistence = config.databaseUrl ? createPostgresPersistence(config) : null;
const authorizationPolicy = createAuthorizationPolicy();
const sessionService = persistence
  ? createSessionService({
    repository: persistence.sessionRepository,
    publicOrigin: config.publicOrigin,
    csrfSecret: config.csrfSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,
  })
  : null;
const requestService = persistence
  ? createRequestService({
    repository: persistence.requestRepository,
    authorizationPolicy,
  })
  : null;
const server = createHttpServer({
  config,
  logger,
  authorizationPolicy,
  sessionService,
  requestService,
  loadTenant: persistence?.loadTenant,
  readinessChecks: persistence?.readinessChecks || [],
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.lifecycle({ event: `shutdown_${signal.toLowerCase()}` });

  const forceTimer = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  forceTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await persistence?.close();
    clearTimeout(forceTimer);
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

server.listen(config.port, config.host, () => {
  logger.lifecycle({ event: 'server_started' });
});
