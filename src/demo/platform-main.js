import { applyPlatformSecurityHeaders, assertPlatformRequestHost, assertPlatformRequestTarget,
  assertPlatformRequestOrigin, createPlatformRequestId } from '../platform/http/security.js';
import { startDemoEntrypointRuntime } from './entrypoint-runtime.js';
import { loadDemoPlatformConfig } from './config.js';
import { createDemoPlatformComposition } from './platform-composition.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { assertPlatformRouteKey } from '../platform/http/observability.js';
import { startDemoMediaStorageRuntime } from './media-storage-runtime.js';

const config = loadDemoPlatformConfig(process.env);
const runtime = await startDemoEntrypointRuntime({
  env: process.env, config, surface: 'platform',
  boundary: { applySecurityHeaders: applyPlatformSecurityHeaders, assertRequestHost: assertPlatformRequestHost,
    assertRequestTarget: assertPlatformRequestTarget, assertRequestOrigin: assertPlatformRequestOrigin,
    createRequestId: createPlatformRequestId },
  onExpiryFailure() { process.exit(1); },
  async startActive(trafficGate) {
    const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
    const metrics = createMetricsRegistry({
      assertRouteKey: assertPlatformRouteKey,
      write: (line) => process.stdout.write(line),
    });
    return startDemoMediaStorageRuntime({
      env: process.env, config, surface: 'platform',
      createComposition: (resetMediaObjectStorage) => createDemoPlatformComposition({
        config, staticFileAdapter, metrics, resetMediaObjectStorage, trafficGate,
      }),
    });
  },
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
