import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLiveMediaRecord, requireLiveMedia } from './support/live-media-operator-config.mjs';
import { assertLiveMediaSourceBinding } from './support/live-media-source-binding.mjs';

// This controller runs only from the exact current main dispatch checkout,
// before the record-selected checkout, dependency installation or secret step.
try {
  requireLiveMedia(process.argv.length === 2 && typeof process.env.GITHUB_OUTPUT === 'string', 'LIVE_MEDIA_SOURCE_INVALID');
  const operation = loadLiveMediaRecord(process.env);
  assertLiveMediaSourceBinding({ sourceSha: operation.record.sourceSha, controllerSha: operation.controllerSha,
    expectedHead: operation.controllerSha, repository: fileURLToPath(new URL('../', import.meta.url)) });
  appendFileSync(process.env.GITHUB_OUTPUT, 'source_sha=' + operation.record.sourceSha + '\n', { encoding: 'utf8' });
  process.stdout.write(JSON.stringify({ status: 'source_bound', sourceSha: operation.record.sourceSha,
    controllerSha: operation.controllerSha, recordSha256: operation.recordSha256 }) + '\n');
} catch {
  process.stdout.write('{"status":"failed","code":"LIVE_MEDIA_SOURCE_INVALID"}\n');
  process.exitCode = 1;
}
