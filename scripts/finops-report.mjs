import { open } from 'node:fs/promises';
import { evaluateFinopsReport, renderFinopsDashboard } from '../src/observability/finops-report.js';

const MAX_BYTES = 65_536;
let file;
try {
  if (process.argv.length < 3 || process.argv.length > 4
    || (process.argv.length === 4 && process.argv[3] !== '--html')) throw new Error('FINOPS_REPORT_INPUT_REQUIRED');
  file = await open(process.argv[2], 'r');
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('FINOPS_REPORT_INPUT_INVALID');
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_BYTES) throw new Error('FINOPS_REPORT_INPUT_INVALID');
  const report = evaluateFinopsReport(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  process.stdout.write(process.argv[3] === '--html' ? renderFinopsDashboard(report) : `${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('FINOPS_REPORT_FAILED\n');
  process.exitCode = 1;
} finally { await file?.close(); }
