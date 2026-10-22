import { loadPlatformPasskeyOfflineConfig } from '../src/operator/platform-passkey-offline-config.js';
import { normalizePlatformAuditSegmentRequest } from '../src/operator/platform-audit-segment-request.js';
import { createPostgresPlatformAuditSegmentInitializer } from '../src/persistence/postgres/platform-audit-segment-initializer.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPool,isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { loadMigrations } from './db-migrations.mjs';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';

let pool;
let stage = 'ARGUMENTS';
try {
  if (process.argv.length!==2) throw new Error('REFUSED');
  stage = 'CONFIGURATION';
  let config;
  try { config=loadPlatformPasskeyOfflineConfig(process.env); } catch (error) {
    if (['MODE','OWNER_CONFIGURATION','DATABASE_URL','DATABASE_BINDING','SECURITY_REVISION','SIGNING_KEY'].includes(error?.stage)) {
      stage=error.stage;
    }
    throw new Error('REFUSED');
  }
  stage = 'REQUEST';
  const legacyCount=process.env.PLATFORM_AUDIT_SEGMENT_LEGACY_EVENT_COUNT;
  if (typeof legacyCount!=='string' || !/^(0|[1-9]\d{0,3})$/.test(legacyCount)) throw new Error('REFUSED');
  const expected={ environment: 'int',segmentId: process.env.PLATFORM_AUDIT_SEGMENT_ID,
    deploymentEpoch: process.env.PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH,
    legacyEventCount: Number(legacyCount),
    inventoryDigest: process.env.PLATFORM_AUDIT_SEGMENT_INVENTORY_DIGEST };
  const request=normalizePlatformAuditSegmentRequest(readFixedDescriptorJson(3),expected);
  stage = 'CONNECTION';
  pool=createPostgresPool(config);
  const schemaReady=await isPostgresSchemaReady(pool);
  stage = 'SCHEMA';
  if (!schemaReady) throw new Error('REFUSED');
  stage = 'LEDGER';
  const migrations=await loadMigrations();
  const ledger=await pool.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  if (ledger.rowCount!==migrations.length || ledger.rows.some((row,index)=>row.version!==migrations[index].version
    || row.name!==migrations[index].name || row.checksum!==migrations[index].checksum)) throw new Error('REFUSED');
  stage = 'INITIALIZATION';
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: config.auditHmacSecret,
    segment: { id: expected.segmentId,environment: 'int',deploymentEpoch: expected.deploymentEpoch } });
  const repository=createPostgresPlatformAuditSegmentInitializer(pool,{ expected,expectedOfflineRole: config.expectedOfflineRole,
    auditRepository });
  process.stdout.write(JSON.stringify(await repository.initialize(request))+'\n');
} catch {
  process.stderr.write(`PLATFORM_AUDIT_SEGMENT_INITIALIZATION_REFUSED\nPLATFORM_AUDIT_STAGE_${stage}_REFUSED\n`);process.exitCode=1;
} finally {
  try { await pool?.end(); } catch { process.exitCode=1; }
}
