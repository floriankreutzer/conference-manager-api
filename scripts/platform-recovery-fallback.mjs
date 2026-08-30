import { executePlatformRecoveryFallback } from '../src/platform/fallback/recovery-fallback.js';
import { createPlatformComposition } from '../src/platform-composition.js';
import { loadPlatformConfig } from '../src/platform/config.js';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';

const SAFE_ERROR = /^[A-Z][A-Z0-9_]{2,127}$/;

function output(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

let composition;
try {
  const request = readFixedDescriptorJson(3);
  const config = loadPlatformConfig(process.env);
  if (!['pilot', 'production'].includes(config.mode)) {
    throw new Error('PLATFORM_FALLBACK_ENVIRONMENT_INVALID');
  }
  composition = createPlatformComposition({ config });
  for (const check of composition.persistence.readinessChecks) {
    if (await check() !== true) throw new Error('PLATFORM_FALLBACK_PERSISTENCE_NOT_READY');
  }
  const result = await executePlatformRecoveryFallback({ request, services: composition.fallback });
  output(process.stdout, Object.freeze({ status: 'completed', result }));
} catch (error) {
  const candidate = error?.code || error?.message;
  output(process.stderr, Object.freeze({
    status: 'failed',
    code: SAFE_ERROR.test(candidate || '') ? candidate : 'PLATFORM_FALLBACK_FAILED',
  }));
  process.exitCode = 1;
} finally {
  try {
    await composition?.persistence.close();
  } catch {
    process.exitCode = 1;
  }
}
