import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { planBookingWorkload } from './support/booking-workload-plan.mjs';

const MAX_BYTES = 16_384;
let file;
try {
  if (process.argv.length !== 3) throw new Error('WORKLOAD_PLAN_INVALID');
  file = await open(process.argv[2], constants.O_RDONLY | constants.O_NONBLOCK);
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('WORKLOAD_PLAN_INVALID');
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_BYTES) throw new Error('WORKLOAD_PLAN_INVALID');
  const report = planBookingWorkload(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('WORKLOAD_PLAN_FAILED\n');
  process.exitCode = 1;
} finally { await file?.close(); }
