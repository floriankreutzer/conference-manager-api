import { loadDemoPlatformConfig } from './config.js';
import { createDemoPlatformComposition } from './platform-composition.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { assertPlatformRouteKey } from '../platform/http/observability.js';

const config = loadDemoPlatformConfig(process.env);
const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
const metrics = createMetricsRegistry({
  assertRouteKey: assertPlatformRouteKey,
  write: (line) => process.stdout.write(line),
});
const composition = createDemoPlatformComposition({ config, staticFileAdapter, metrics });
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
