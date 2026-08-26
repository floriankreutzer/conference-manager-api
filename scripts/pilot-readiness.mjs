import { resolve } from 'node:path';
import { readBoundedRegularFile } from './lib/bounded-evidence-file.mjs';
import { validatePilotReadinessEvidence } from '../src/operator/pilot-readiness-evidence.js';

const MAX_EVIDENCE_BYTES = 65_536;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;

function errorCode(error) {
  const candidate = error?.code || error?.message;
  return SAFE_ERROR_CODE.test(candidate || '') ? candidate : 'PILOT_READINESS_VALIDATION_FAILED';
}

function parseArguments(argv) {
  const requireReady = argv.includes('--require-ready');
  const paths = argv.filter((value) => value !== '--require-ready');
  if (paths.length !== 1 || typeof paths[0] !== 'string' || paths[0].length < 1) {
    throw new Error('PILOT_READINESS_FILE_REQUIRED');
  }
  return Object.freeze({ requireReady, path: resolve(paths[0]) });
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    let encoded;
    try {
      encoded = await readBoundedRegularFile(options.path, { maxBytes: MAX_EVIDENCE_BYTES });
    } catch {
      throw new Error('PILOT_READINESS_FILE_INVALID');
    }
    let document;
    try {
      document = JSON.parse(encoded);
    } catch {
      throw new Error('PILOT_READINESS_JSON_INVALID');
    }
    const validated = validatePilotReadinessEvidence(document, {
      requireReady: options.requireReady,
    });
    process.stdout.write(`${JSON.stringify({
      status: 'validated',
      ...validated.summary,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: errorCode(error),
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
