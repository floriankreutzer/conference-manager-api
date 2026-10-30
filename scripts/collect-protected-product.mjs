import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { protectedRuntimeObservationDatabase } from './support/protected-runtime-observation-execution.mjs';
import { collectProtectedProductReport } from './support/protected-product-collector.mjs';

let pool;
try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  const env = process.env, output = env.PROTECTED_PRODUCT_OUTPUT_PATH;
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.normalize(output) !== output) throw new Error('REFUSED');
  if (await realpath(path.dirname(output)) !== path.dirname(output)) throw new Error('REFUSED');
  const parent = await lstat(path.dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
    || (parent.mode & 0o077) !== 0) throw new Error('REFUSED');
  const database = protectedRuntimeObservationDatabase(env);
  pool = createPostgresPool({ mode: 'production', ...loadDatabaseConfig({ DATABASE_URL: database.databaseUrl,
    DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '1', DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '10000' }, 'production') });
  const report = await collectProtectedProductReport({ pool, expectedOfflineRole: database.expectedOfflineRole,
    securityEpoch: env.PROTECTED_OBSERVATION_SECURITY_EPOCH, dataProfile: env.PROTECTED_PRODUCT_DATA_PROFILE,
    tenantAuditHmacSecret: env.PROTECTED_TENANT_AUDIT_HMAC_SECRET,
    platformAuditHmacSecret: env.PROTECTED_PLATFORM_AUDIT_HMAC_SECRET });
  const bytes = Buffer.from(JSON.stringify(report));if (bytes.length > 24000) throw new Error('REFUSED');
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes);await file.sync(); } finally { await file.close(); }
  process.stdout.write('PROTECTED_PRODUCT_COLLECTED\n');
} catch { process.stderr.write('PROTECTED_PRODUCT_COLLECTION_REFUSED\n');process.exitCode = 1; }
finally { if (pool) await pool.end(); }
