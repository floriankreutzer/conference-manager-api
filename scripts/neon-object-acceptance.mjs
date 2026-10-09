import { writeFile } from 'node:fs/promises';
import { createNeonObjectStorage } from '../src/media/neon-object-storage.js';
import { loadNeonAcceptanceConfig, runNeonAcceptanceProbe } from './support/neon-acceptance-probe.mjs';

try {
  if (process.argv.length !== 2) throw new Error('NEON_ACCEPTANCE_ARGUMENTS_INVALID');
  const config = loadNeonAcceptanceConfig(process.env);
  const storage = createNeonObjectStorage(config);
  const result = await runNeonAcceptanceProbe({ storage, sourceRuntimeRef: process.env.GITHUB_SHA,
    recordIntent: (evidence) => writeFile('neon-object-acceptance-intent.json', `${JSON.stringify(evidence)}\n`,
      { mode: 0o600, flag: 'wx' }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
} catch {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, passed: false, code: 'NEON_ACCEPTANCE_FAILED' })}\n`);
  process.exitCode = 1;
}
