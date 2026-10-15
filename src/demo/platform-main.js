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
import { loadDemoProductDelivery } from './platform-product-delivery.js';
import { loadDemoMediaStorageConfig } from './media-storage-config.js';
import { createLiveMetricsStorage } from './platform-live-storage.js';
import { createDailyLiveMetrics } from './platform-live-metrics.js';

const config = loadDemoPlatformConfig(process.env);
const platformAccess = loadDemoPlatformAccessConfig(process.env);
const providerUsage = loadDemoProviderUsage(process.env, platformAccess);
const productDelivery = loadDemoProductDelivery(process.env, platformAccess);
const liveEnabled = process.env.DEMO_LIVE_METRICS_ENABLED;
if (![undefined, 'false', 'true'].includes(liveEnabled)
  || (liveEnabled === 'true' && platformAccess.mode !== 'password')) throw new TypeError('LIVE_METRICS_CONFIG_INVALID');
const liveStorageConfig = liveEnabled === 'true'
  ? loadDemoMediaStorageConfig(process.env, { config, surface: 'platform' }).storage : null;
if (liveEnabled === 'true' && !liveStorageConfig) throw new TypeError('LIVE_METRICS_NEON_REQUIRED');
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
    const liveStorage = liveStorageConfig ? createLiveMetricsStorage(liveStorageConfig) : null;
    const liveMetrics = liveStorage ? createDailyLiveMetrics({ storage: liveStorage }) : null;
    let active;
    try { active = await startDemoMediaStorageRuntime({
      env: process.env, config, surface: 'platform',
      createComposition: (resetMediaObjectStorage) => createDemoPlatformComposition({
        config, staticFileAdapter, metrics, resetMediaObjectStorage, trafficGate, accessGate, providerUsage, productDelivery, liveMetrics,
      }),
    }); } catch (error) { liveStorage?.close(); throw error; }
    return Object.freeze({ async stop() {
      try { await active.stop(); } finally { liveStorage?.close(); }
    } });
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
