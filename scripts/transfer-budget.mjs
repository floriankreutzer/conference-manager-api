import { open } from 'node:fs/promises';
import { evaluateTransferBudget } from '../src/observability/transfer-budget.js';

const MAX_INPUT_BYTES = 16_384;
let file;
try {
  if (process.argv.length !== 3) throw new Error('TRANSFER_BUDGET_INPUT_REQUIRED');
  file = await open(process.argv[2], 'r');
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('TRANSFER_BUDGET_INPUT_INVALID');
  const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_INPUT_BYTES) throw new Error('TRANSFER_BUDGET_INPUT_INVALID');
  const report = evaluateTransferBudget(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  // Input JSON, file names, account data and filesystem errors are never echoed on failure.
  process.stderr.write('TRANSFER_BUDGET_REPORT_FAILED\n');
  process.exitCode = 1;
} finally {
  await file?.close();
}
