import { loadPlatformPasskeyOfflineConfig } from '../src/operator/platform-passkey-offline-config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformPasskeyGrantIssuer } from '../src/persistence/postgres/platform-passkey-grant-issuer.js';
import { readFixedDescriptorJson, validateSecretOutputDescriptor, writeSecretToFixedDescriptor } from './lib/fixed-descriptor-json.mjs';

const SAFE_ERROR = /^[A-Z][A-Z0-9_]{2,127}$/;
let pool;
try {
  const config = loadPlatformPasskeyOfflineConfig(process.env);
  const request = readFixedDescriptorJson(3);
  validateSecretOutputDescriptor(4);
  if (request?.environment !== config.environment || request?.securityEpoch !== config.securityEpoch) {
    throw new Error('PLATFORM_PASSKEY_OFFLINE_REQUEST_DEPLOYMENT_MISMATCH');
  }
  pool = createPostgresPool(config);
  if (!await isPostgresSchemaReady(pool)) throw new Error('PLATFORM_PASSKEY_OFFLINE_SCHEMA_NOT_READY');
  const auditRepository = createPostgresPlatformAuditRepository(pool, { hmacSecret: config.auditHmacSecret });
  const issuer = createPostgresPlatformPasskeyGrantIssuer(pool, { auditRepository, expectedOfflineRole: config.expectedOfflineRole });
  const issued = await issuer.issueOffline(request);
  writeSecretToFixedDescriptor(JSON.stringify(issued.grant), 4);
  process.stdout.write(`${JSON.stringify({ status: 'issued', grantId: issued.grant.grantId,
    expiresAt: issued.expiresAt, operatorSecurityVersion: issued.operatorSecurityVersion })}\n`);
} catch (error) {
  const candidate = error?.code || error?.message;
  process.stderr.write(`${JSON.stringify({ status: 'failed',
    code: SAFE_ERROR.test(candidate || '') ? candidate : 'PLATFORM_PASSKEY_OFFLINE_FAILED' })}\n`);
  process.exitCode = 1;
} finally {
  try { await pool?.end(); } catch { process.exitCode = 1; }
}
