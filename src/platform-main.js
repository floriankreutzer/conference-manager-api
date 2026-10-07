import { createPlatformComposition } from './platform-composition.js';
import { loadPlatformConfig } from './platform/config.js';
import { createProductionPlatformAuthentication } from './platform-production-authentication.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { assertPlatformRouteKey } from './platform/http/observability.js';

const composition = createPlatformComposition({
  config: loadPlatformConfig(process.env),
  authenticationFactory: createProductionPlatformAuthentication,
  metrics: createMetricsRegistry({
    assertRouteKey: assertPlatformRouteKey,
    write: (line) => process.stdout.write(line),
  }),
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
