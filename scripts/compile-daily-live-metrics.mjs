import { normalizeDailyLiveSnapshot } from '../src/demo/platform-live-metrics.js';

// Only aggregate input is accepted. Never echo a rejected source, credentials or identities.
try {
  if (process.argv.length !== 2) throw new TypeError('INVALID_ARGUMENTS');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 48_000) throw new TypeError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const normalized = normalizeDailyLiveSnapshot(input);
  const age = Date.now() - Date.parse(normalized.observedAt);
  if (age < 0 || age >= 86_400_000) throw new TypeError('INVALID_OBSERVATION_CLOCK');
  process.stdout.write(`${JSON.stringify(input)}\n`);
} catch {
  process.stderr.write('DAILY_LIVE_METRICS_COMPILATION_FAILED\n');
  process.exitCode = 1;
}
