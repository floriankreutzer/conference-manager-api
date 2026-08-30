import { createDemoPlatformComposition } from './platform-composition.js';
import { loadDemoPlatformConfig } from './config.js';

const composition = createDemoPlatformComposition({ config: loadDemoPlatformConfig(process.env) });
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
