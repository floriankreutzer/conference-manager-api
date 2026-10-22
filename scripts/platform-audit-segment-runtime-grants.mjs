import { loadPlatformPasskeyOfflineConfig } from '../src/operator/platform-passkey-offline-config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { platformAuditSegmentRoleGrantPlan,grantPlatformAuditSegmentRuntimeRoles } from './support/protected-runtime-role-grants.mjs';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';

let pool;
try {
  if (process.argv.length!==2) throw new Error('REFUSED');
  const config=loadPlatformPasskeyOfflineConfig(process.env);
  const request=readFixedDescriptorJson(3),plan=platformAuditSegmentRoleGrantPlan(request);
  if (plan.segmentId!==process.env.PLATFORM_AUDIT_SEGMENT_ID
    || plan.securityEpoch!==process.env.PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH) throw new Error('REFUSED');
  pool=createPostgresPool(config);
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: config.auditHmacSecret,
    segment: { id: plan.segmentId,environment: 'int',deploymentEpoch: plan.securityEpoch } });
  process.stdout.write(JSON.stringify(await grantPlatformAuditSegmentRuntimeRoles(pool,request,
    { expectedOfflineRole: config.expectedOfflineRole,auditRepository: audit }))+'\n');
} catch {
  process.stderr.write('PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED\n');process.exitCode=1;
} finally {
  try { await pool?.end(); } catch { process.exitCode=1; }
}
