import { normalizePlatformAuditSegmentRequest } from '../../operator/platform-audit-segment-request.js';
import { withPostgresTransaction } from './transaction.js';

export function createPostgresPlatformAuditSegmentInitializer(pool,{ expected,expectedOfflineRole,auditRepository }={}) {
  if (!pool?.connect || !auditRepository?.appendWithClient || !auditRepository?.verifyWithClient
    || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole ?? '')) throw new TypeError('PLATFORM_AUDIT_SEGMENT_CONFIGURATION_INVALID');
  return Object.freeze({
    async initialize(value) {
      const request=normalizePlatformAuditSegmentRequest(value,expected);
      try {
        return await withPostgresTransaction(pool,async client=>{
          await client.query("SET LOCAL statement_timeout='10s'");
          const lease=await client.query('SELECT pg_try_advisory_xact_lock(740193,2) AS acquired');
          if (!lease.rows[0]?.acquired) throw new Error('REFUSED');
          await client.query('LOCK TABLE platform_audit_segments IN ACCESS EXCLUSIVE MODE NOWAIT');
          const authority=await client.query(`SELECT current_user AS active_role,session_user AS authenticated_role,
            pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass`);
          if (!authority.rows[0] || ['active_role','authenticated_role','owner_role']
            .some(key=>authority.rows[0][key]!==expectedOfflineRole)) throw new Error('REFUSED');
          await client.query(`INSERT INTO platform_audit_segments
            (id,environment,deployment_epoch,legacy_event_count,legacy_terminal_event_hash,inventory_digest,approval_reference)
            SELECT $1,$2,$3,$4,terminal_event_hash,$5,$6 FROM platform_audit_chain_state WHERE singleton`,
          [request.segmentId,'int',request.deploymentEpoch,request.legacyEventCount,request.inventoryDigest,request.approvalReference]);
          await client.query('INSERT INTO platform_audit_segment_heads(segment_id) VALUES($1)',[request.segmentId]);
          await auditRepository.appendWithClient(client,{
            operatorId: null,roles: [],permissions: [],assuranceLevel: 'offline_owner',targetTenantId: null,
            action: 'platform.operator.changed',targetType: 'platform_audit_segment',targetId: request.segmentId,
            previousState: null,newState: { integrityVersion: 2 },occurredAt: new Date().toISOString(),
            correlationId: request.correlationId,outcome: 'success',retentionClass: 'recovery',
            metadata: { operation: 'audit_segment_genesis',environment: 'int',deploymentEpoch: request.deploymentEpoch,
              approvalReference: request.approvalReference,inventoryDigest: request.inventoryDigest,legacyVerification: 'unavailable' },
          });
          await auditRepository.verifyWithClient(client);
          return Object.freeze({ status: 'initialized',environment: 'int',segmentId: request.segmentId,
            legacyEventCount: request.legacyEventCount,legacyVerification: 'unavailable',correlationId: request.correlationId });
        });
      } catch { throw new Error('PLATFORM_AUDIT_SEGMENT_INITIALIZATION_REFUSED'); }
    },
  });
}
