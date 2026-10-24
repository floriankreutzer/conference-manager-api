import { randomUUID } from 'node:crypto';
import {
  normalizePlatformOwnerBootstrapRequest,normalizePlatformOwnerRolesRequest,
} from '../../operator/platform-owner-bootstrap-request.js';
import { withPostgresTransaction } from './transaction.js';

const refuse=()=>{ throw new Error('PLATFORM_OWNER_BOOTSTRAP_REFUSED'); };

// Offline owner only. Never compose into HTTP, runtime or either Demo graph.
export function createPostgresPlatformOwnerBootstrapRepository(pool,{ auditRepository,expected,expectedOfflineRole }={}) {
  if (typeof pool?.connect!=='function' || typeof auditRepository?.appendWithClient!=='function'
    || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole ?? '')) refuse();
  return Object.freeze({
    async grantAllOwnerRoles(value) {
      const request=normalizePlatformOwnerRolesRequest(value,expected);
      try {
        return await withPostgresTransaction(pool,async client=>{
          await client.query("SET LOCAL statement_timeout='10s'");
          const lock=await client.query('SELECT pg_try_advisory_xact_lock(740193,2) AS acquired');
          if (lock.rows[0]?.acquired!==true) refuse();
          await client.query('LOCK TABLE platform_operators IN SHARE ROW EXCLUSIVE MODE NOWAIT');
          const authority=await client.query(`SELECT current_user AS active_role,session_user AS authenticated_role,
            pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass`);
          if (!authority.rows[0] || ['active_role','authenticated_role','owner_role']
            .some(key=>authority.rows[0][key]!==expectedOfflineRole)) refuse();
          const owner=await client.query(`SELECT id,roles,security_version FROM platform_operators o
            WHERE provider='microsoft_entra_platform' AND provider_tenant_reference=$1 AND provider_subject_reference=$2
              AND status='active' AND scope_mode='all' AND security_version=$3
              AND (SELECT count(*) FROM platform_operators WHERE provider<>'demo_platform')=1
              AND EXISTS(SELECT 1 FROM platform_audit_events WHERE target_type='platform_operator_bootstrap' AND target_id=o.id::text)
              AND NOT EXISTS(SELECT 1 FROM platform_audit_events WHERE target_type='platform_owner_roles')
              AND EXISTS(SELECT 1 FROM protected_runtime_deployments WHERE environment='int' AND security_epoch=$4)
            FOR UPDATE`,[request.directoryId,request.subjectId,request.expectedSecurityVersion,request.deploymentEpoch]);
          if (owner.rowCount!==1) refuse();
          const previous=owner.rows[0];
          const updated=await client.query(`UPDATE platform_operators SET roles=ARRAY[
            'platform_security_admin','platform_security_auditor','platform_support_reader','platform_tenant_operator']::text[]
            WHERE id=$1 RETURNING security_version`,[previous.id]);
          if (Number(updated.rows[0].security_version)!==request.expectedSecurityVersion+1) refuse();
          const sessions=await client.query(`UPDATE platform_sessions SET revoked_at=clock_timestamp()
            WHERE operator_id=$1 AND revoked_at IS NULL`,[previous.id]);
          const transactions=await client.query('DELETE FROM platform_oidc_auth_transactions WHERE expected_operator_id=$1',[previous.id]);
          await auditRepository.appendWithClient(client,{
            operatorId: null,roles: [],permissions: [],assuranceLevel: 'offline_owner',targetTenantId: null,
            action: 'platform.operator.changed',targetType: 'platform_owner_roles',targetId: previous.id,
            previousState: { roleCount: previous.roles.length,securityVersion: request.expectedSecurityVersion },
            newState: { roleCount: 4,securityVersion: request.expectedSecurityVersion+1,scopeMode: 'all' },
            occurredAt: new Date().toISOString(),correlationId: request.correlationId,outcome: 'success',
            metadata: { operation: 'owner_all_platform_roles',environment: 'int',deploymentEpoch: request.deploymentEpoch,
              approvalReference: request.approvalReference,sessionsRevoked: sessions.rowCount,transactionsRevoked: transactions.rowCount },
            retentionClass: 'recovery',
          });
          await client.query(`INSERT INTO platform_operator_change_alert_outbox(operator_id,change_type,correlation_id,created_at)
            VALUES($1,'access_changed',$2,clock_timestamp())`,[previous.id,request.correlationId]);
          return Object.freeze({ status: 'owner_roles_granted',operatorId: previous.id,
            environment: 'int',correlationId: request.correlationId });
        });
      } catch { refuse(); }
    },
    async initialize(value) {
      const request=normalizePlatformOwnerBootstrapRequest(value,expected);
      try {
        return await withPostgresTransaction(pool,async client=>{
          await client.query("SET LOCAL statement_timeout='10s'");
          const lock=await client.query('SELECT pg_try_advisory_xact_lock(740193,2) AS acquired');
          if (lock.rows[0]?.acquired!==true) refuse();
          // Lock before reading emptiness; concurrent ordinary writes cannot race creation.
          await client.query('LOCK TABLE platform_operators IN SHARE ROW EXCLUSIVE MODE NOWAIT');
          const authority=await client.query(`SELECT current_user AS active_role,session_user AS authenticated_role,
            pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass`);
          if (!authority.rows[0] || ['active_role','authenticated_role','owner_role']
            .some(key=>authority.rows[0][key]!==expectedOfflineRole)) refuse();
          const readiness=await client.query(`SELECT
            EXISTS(SELECT 1 FROM protected_runtime_deployments WHERE environment='int' AND security_epoch=$1) AS current,
            EXISTS(SELECT 1 FROM platform_operators WHERE provider<>'demo_platform') AS occupied,
            EXISTS(SELECT 1 FROM platform_audit_events WHERE target_type='platform_operator_bootstrap') AS used`,
          [request.deploymentEpoch]);
          const posture=readiness.rows[0];
          if (!posture || posture.current!==true || posture.occupied!==false || posture.used!==false) refuse();
          const operatorId=randomUUID();
          await client.query(`INSERT INTO platform_operators
            (id,provider,provider_tenant_reference,provider_subject_reference,status,scope_mode,roles)
            VALUES($1,'microsoft_entra_platform',$2,$3,'active','all',
              ARRAY['platform_security_admin','platform_tenant_operator']::text[])`,
          [operatorId,request.directoryId,request.subjectId]);
          await auditRepository.appendWithClient(client,{
            operatorId: null,roles: [],permissions: [],assuranceLevel: 'offline_owner',targetTenantId: null,
            action: 'platform.operator.changed',targetType: 'platform_operator_bootstrap',targetId: operatorId,
            previousState: null,newState: { status: 'active',scopeMode: 'all',roleCount: 2,securityVersion: 1 },
            occurredAt: new Date().toISOString(),correlationId: request.correlationId,outcome: 'success',
            metadata: { operation: 'first_owner_bootstrap',environment: 'int',deploymentEpoch: request.deploymentEpoch,
              approvalReference: request.approvalReference },retentionClass: 'recovery',
          });
          await client.query(`INSERT INTO platform_operator_change_alert_outbox
            (operator_id,change_type,correlation_id,created_at) VALUES($1,'created',$2,clock_timestamp())`,
          [operatorId,request.correlationId]);
          return Object.freeze({ status: 'initialized',operatorId,environment: 'int',correlationId: request.correlationId });
        });
      } catch { refuse(); }
    },
  });
}
