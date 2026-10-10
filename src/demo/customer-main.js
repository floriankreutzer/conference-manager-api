import { applySecurityHeaders, assertRequestHost, assertSafeRequestTarget, assertSameOrigin, createRequestId } from '../security.js';
import { startDemoEntrypointRuntime } from './entrypoint-runtime.js';
import { createDemoCustomerComposition } from './customer-composition.js';
import { loadDemoCustomerConfig } from './config.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { startDemoMediaStorageRuntime } from './media-storage-runtime.js';

const config = loadDemoCustomerConfig(process.env);
const runtime = await startDemoEntrypointRuntime({
  env: process.env, config, surface: 'customer',
  boundary: { applySecurityHeaders, assertRequestHost, assertRequestTarget: assertSafeRequestTarget,
    assertRequestOrigin: assertSameOrigin, createRequestId },
  onExpiryFailure() { process.exit(1); },
  async startActive(trafficGate) {
    const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
    const metrics = createMetricsRegistry({ write: (line) => process.stdout.write(line) });
    return startDemoMediaStorageRuntime({
      env: process.env, config, surface: 'customer',
      createComposition: (mediaObjectStorage) => createDemoCustomerComposition({
        config, staticFileAdapter, metrics, mediaObjectStorage, trafficGate,
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
