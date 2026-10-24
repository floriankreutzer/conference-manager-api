import { loadPlatformPasskeyOfflineConfig } from '../src/operator/platform-passkey-offline-config.js';
import { normalizePlatformOwnerRolesRequest } from '../src/operator/platform-owner-bootstrap-request.js';
import { createPostgresPool,isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';

import { loadMigrations } from './db-migrations.mjs';

let pool;
try {
  if (process.argv.length!==2) throw new Error('REFUSED');
  const config=loadPlatformPasskeyOfflineConfig(process.env);
  const expected={ environment: 'int',deploymentEpoch: process.env.PLATFORM_OWNER_BOOTSTRAP_DEPLOYMENT_EPOCH,
    directoryId: process.env.PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID,subjectId: process.env.PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID };
  const request=normalizePlatformOwnerRolesRequest(readFixedDescriptorJson(3),expected);
  pool=createPostgresPool(config);
  if (!await isPostgresSchemaReady(pool)) throw new Error('REFUSED');
  const migrations=await loadMigrations();
  const ledger=await pool.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  if (ledger.rowCount!==migrations.length || ledger.rows.some((row,index)=>row.version!==migrations[index].version
    || row.name!==migrations[index].name || row.checksum!==migrations[index].checksum)) throw new Error('REFUSED');
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: config.auditHmacSecret,
    segment: { id: process.env.PLATFORM_AUDIT_SEGMENT_ID,environment: 'int',deploymentEpoch: expected.deploymentEpoch } });
  await auditRepository.verificationContext();
  const repository=createPostgresPlatformOwnerBootstrapRepository(pool,{ auditRepository,expected,
    expectedOfflineRole: config.expectedOfflineRole });
  process.stdout.write(JSON.stringify(await repository.grantAllOwnerRoles(request))+'\n');
} catch {
  process.stderr.write('PLATFORM_OWNER_ROLES_REFUSED\n');process.exitCode=1;
} finally {
  try { await pool?.end(); } catch { process.exitCode=1; }
}
