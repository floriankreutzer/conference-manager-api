import { resolve } from 'node:path';
import { readBoundedRegularFile } from './lib/bounded-evidence-file.mjs';
import { validateExchangeApplicationRbacEvidence } from '../src/operator/exchange-application-rbac-evidence.js';

const MAX_EVIDENCE_BYTES = 65_536;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;

function errorCode(error) {
  const candidate = error?.code || error?.message;
  return SAFE_ERROR_CODE.test(candidate || '')
    ? candidate
    : 'EXCHANGE_APPLICATION_RBAC_VALIDATION_FAILED';
}

function evidencePath(argv) {
  if (argv.length !== 1 || typeof argv[0] !== 'string' || argv[0].length < 1) {
    throw new Error('EXCHANGE_APPLICATION_RBAC_FILE_REQUIRED');
  }
  return resolve(argv[0]);
}

async function main() {
  try {
    const path = evidencePath(process.argv.slice(2));
    let document;
    try {
      document = JSON.parse(await readBoundedRegularFile(path, { maxBytes: MAX_EVIDENCE_BYTES }));
    } catch {
      throw new Error('EXCHANGE_APPLICATION_RBAC_FILE_OR_JSON_INVALID');
    }
    const validated = validateExchangeApplicationRbacEvidence(document);
    process.stdout.write(`${JSON.stringify(validated.summary)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: errorCode(error),
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
