import { createNeonBranchStorageConfig } from '../src/media/neon-storage-config.js';
import { createOperationsSourceStorage } from '../src/demo/platform-operations-source-storage.js';
import { createOperationsSources } from '../src/demo/platform-operations-sources.js';
import { OPERATIONS_SOURCE_MAX_BYTES } from '../src/observability/operations-source-contract.js';

let storage;
try {
  const [action, kind, ...extra] = process.argv.slice(2);
  if (!['read', 'write'].includes(action) || !['manual', 'feedback'].includes(kind) || extra.length) throw new Error('INVALID');
  if (action === 'write' && process.env.OPERATIONS_SOURCE_WRITE_ENABLED !== 'true') throw new Error('FORBIDDEN');
  const config = createNeonBranchStorageConfig({ branch: process.env.OPERATIONS_SOURCE_BRANCH_ID,
    bucket: 'conference-manager-media', accessKeyId: process.env.OPERATIONS_SOURCE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OPERATIONS_SOURCE_SECRET_ACCESS_KEY });
  storage = createOperationsSourceStorage(config, { writable: action === 'write' });
  const sources = createOperationsSources({ storage, operatorId: process.env.OPERATIONS_SOURCE_OPERATOR_ID });
  let result;
  if (action === 'read') result = await sources.read(kind);
  else {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > OPERATIONS_SOURCE_MAX_BYTES) throw new Error('INVALID');
      chunks.push(chunk);
    }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || !Object.hasOwn(input, 'source') || !Object.hasOwn(input, 'expectedVersion')) throw new Error('INVALID');
    result = await sources.write(kind, input.source, input.expectedVersion);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(error?.message === 'OPERATIONS_SOURCE_CONFLICT'
    ? 'OPERATIONS_SOURCE_CONFLICT\n' : 'OPERATIONS_SOURCE_COMMAND_FAILED\n');
  process.exitCode = 1;
} finally { storage?.close(); }
