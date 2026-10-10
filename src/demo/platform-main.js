import { loadDemoPlatformConfig } from './config.js';
import { createDemoPlatformComposition } from './platform-composition.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { assertPlatformRouteKey } from '../platform/http/observability.js';
import { startDemoMediaStorageRuntime } from './media-storage-runtime.js';

const config = loadDemoPlatformConfig(process.env);
const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
const metrics = createMetricsRegistry({
  assertRouteKey: assertPlatformRouteKey,
  write: (line) => process.stdout.write(line),
});
const runtime = await startDemoMediaStorageRuntime({
  env: process.env, config, surface: 'platform',
  createComposition: (resetMediaObjectStorage) => createDemoPlatformComposition({
    config, staticFileAdapter, metrics, resetMediaObjectStorage,
  }),
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await runtime.stop();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
