import { createDemoCustomerComposition } from './customer-composition.js';
import { loadDemoCustomerConfig } from './config.js';
import { loadDemoStaticFileAdapter } from './static-file-loader.js';
import { createMetricsRegistry } from '../observability/metrics.js';
import { startDemoMediaStorageRuntime } from './media-storage-runtime.js';

const config = loadDemoCustomerConfig(process.env);
const staticFileAdapter = await loadDemoStaticFileAdapter(config.staticRoot);
const metrics = createMetricsRegistry({ write: (line) => process.stdout.write(line) });
const runtime = await startDemoMediaStorageRuntime({
  env: process.env, config, surface: 'customer',
  createComposition: (mediaObjectStorage) => createDemoCustomerComposition({
    config, staticFileAdapter, metrics, mediaObjectStorage,
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
