import { compileOperationsSources, OPERATIONS_SOURCE_MAX_BYTES } from '../src/observability/operations-source-contract.js';
import { exactProductObject } from '../src/observability/product-delivery-contract.js';

try {
  if (process.argv.length !== 2) throw new Error('INVALID');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 3 * OPERATIONS_SOURCE_MAX_BYTES) throw new Error('INVALID');
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  exactProductObject(input, ['automatic', 'manual', 'feedback']);
  process.stdout.write(`${JSON.stringify(compileOperationsSources(input.automatic, input.manual, input.feedback))}\n`);
} catch {
  process.stderr.write('OPERATIONS_SOURCE_COMPILATION_FAILED\n');
  process.exitCode = 1;
}
