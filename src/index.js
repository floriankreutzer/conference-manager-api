import { createCustomerComposition } from './customer-composition.js';
import { loadConfig } from './config.js';
import { createEntraClient } from './identity/entra-client.js';
import { createMicrosoft365Client } from './integrations/microsoft365-client.js';
import { createLogger } from './logger.js';
import { createMetricsRegistry } from './observability/metrics.js';

const config = loadConfig();
const logger = createLogger();
const metrics = createMetricsRegistry({ write: (line) => process.stdout.write(line) });
const entraClient = config.entraClientId
  ? createEntraClient({
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    authority: config.entraAuthority,
    redirectUri: config.entraRedirectUri,
  })
  : null;
const microsoft365Client = config.entraClientId
  ? createMicrosoft365Client({
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    publicOrigin: config.publicOrigin,
    timeoutMs: config.microsoft365GraphTimeoutMs,
    allowInsecureLocalhost: config.mode === 'development' || config.mode === 'test',
  })
  : null;
const composition = createCustomerComposition({
  config,
  entraClient,
  microsoft365Client,
  logger,
  metrics,
});

await composition.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await composition.stop();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
