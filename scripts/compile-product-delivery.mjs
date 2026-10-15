import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';

try {
  if (process.argv.length !== 2) throw new Error('ARGUMENTS_INVALID');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256_000) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(`${JSON.stringify(compileProductDeliveryReport(input))}\n`);
} catch {
  process.stderr.write('PRODUCT_DELIVERY_COMPILATION_FAILED\n');
  process.exitCode = 1;
}
