import { applyPlatformSecurityHeaders, assertPlatformRequestHost, assertPlatformRequestTarget,
  assertPlatformRequestOrigin, createPlatformRequestId } from '../platform/http/security.js';
import { startDemoEntrypointRuntime } from './entrypoint-runtime.js';
import { loadDemoPlatformConfig } from './config.js';
import { createDemoPlatformComposition } from './platform-composition.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { assertPlatformRouteKey } from '../platform/http/observability.js';
import { startDemoMediaStorageRuntime } from './media-storage-runtime.js';
import { loadDemoPlatformAccessConfig } from './platform-access-config.js';
import { createDemoPlatformAccessGate } from './platform-access-gate.js';
import { loadDemoProviderUsage } from './platform-provider-usage.js';

const config = loadDemoPlatformConfig(process.env);
const platformAccess = loadDemoPlatformAccessConfig(process.env);
const providerUsage = loadDemoProviderUsage(process.env, platformAccess);
const runtime = await startDemoEntrypointRuntime({
  env: process.env, config, surface: 'platform',
  boundary: { applySecurityHeaders: applyPlatformSecurityHeaders, assertRequestHost: assertPlatformRequestHost,
    assertRequestTarget: assertPlatformRequestTarget, assertRequestOrigin: assertPlatformRequestOrigin,
    createRequestId: createPlatformRequestId },
  onExpiryFailure() { process.exit(1); },
  async startActive(trafficGate) {
    const accessGate = createDemoPlatformAccessGate({ settings: platformAccess, publicOrigin: config.origins.platform });
    const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
    const metrics = createMetricsRegistry({
      assertRouteKey: assertPlatformRouteKey,
      write: (line) => process.stdout.write(line),
    });
    return startDemoMediaStorageRuntime({
      env: process.env, config, surface: 'platform',
      createComposition: (resetMediaObjectStorage) => createDemoPlatformComposition({
        config, staticFileAdapter, metrics, resetMediaObjectStorage, trafficGate, accessGate, providerUsage,
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
