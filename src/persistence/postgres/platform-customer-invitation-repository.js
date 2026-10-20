import { randomUUID } from 'node:crypto';
import { normalizeCustomerInvitationBatch } from '../../authorization/customer-invitation-policy.js';
import { PLATFORM_OPERATION,requireInternalId,requireReason } from '../../platform/application/platform-operation-contract.js';
import { PlatformOperationConflictError,PlatformOperationDeniedError } from '../../platform/application/platform-operation-errors.js';
import { CustomerInvitationConflictError } from '../../domain/customer-invitation-errors.js';
import { AuthorizationDeniedError } from '../../authorization/errors.js';
import { withPostgresTransaction } from './transaction.js';
import { createCustomerInvitationCustody } from './customer-invitation-custody.js';
import { customerInvitationRecord,CUSTOMER_INVITATION_COLUMNS,CUSTOMER_INVITATION_JOINS } from './customer-invitation-records.js';
import { requireCurrentPlatformMutationAuthorization,lockPlatformOperationReceipt,findPlatformOperationReceipt,
  storePlatformOperationReceipt,appendPlatformMutationEvidence } from './platform-operations-repository.js';

const fields=['id','revision','roles','locale','state','expiresAt','delivery'];
const snapshot=row=>Object.fromEntries(fields.map(key=>[key,row[key]]));
export function createPostgresPlatformCustomerInvitationRepository(pool,{ environment,cipher,content,
  tenantAuditRepository,platformAuditRepository,identifierFactory=randomUUID,tenantEligibility=null } = {}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment)
    || typeof cipher?.commandDigest!=='function' || typeof tenantAuditRepository?.appendWithClient!=='function'
    || typeof platformAuditRepository?.appendWithClient!=='function'
    || tenantEligibility!==null && ['allowsWithClient','lockAdmissionWithClient']
      .some(method=>typeof tenantEligibility?.[method]!=='function')) {
    throw new TypeError('PLATFORM_CUSTOMER_INVITATION_CONFIGURATION_INVALID');
  }
  const custody=createCustomerInvitationCustody(pool,{ environment,cipher,content,identifierFactory });
  const auditRepositories={ tenantAuditRepository,platformAuditRepository };
  function scope(input,operation) {
    if (input?.environment!==environment || input.authorization?.operation!==operation
      || input.authorization?.targetTenantId!==input.tenantId) throw new TypeError('PLATFORM_CUSTOMER_INVITATION_SCOPE_INVALID');
    return requireInternalId(input.tenantId);
  }
  async function lockTenant(client,tenantId,readOnly=false) {
    const name=readOnly ? 'platform-customer-invitation-tenant-read' : 'platform-customer-invitation-tenant-lock';
    const result=await client.query({ name,
      text: `SELECT display_name FROM tenants WHERE id=$1 AND status IN ('pending','onboarding','ready','active')
        FOR ${readOnly ? 'SHARE' : 'UPDATE'}`,values: [tenantId] });
    if (result.rowCount!==1) throw new PlatformOperationDeniedError();
    return result.rows[0].display_name;
  }
  async function time(client) {
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('PLATFORM_CUSTOMER_INVITATION_CLOCK_INVALID');
    return now;
  }
  async function restore(client,tenantId,value) {
    if (!Array.isArray(value) || value.length<1 || value.length>20) throw new Error('PLATFORM_CUSTOMER_INVITATION_RECEIPT_INVALID');
    const rows=[];
    for (const stored of value) {
      if (!stored || Object.keys(stored).sort().join(',')!==[...fields].sort().join(',')) {
        throw new Error('PLATFORM_CUSTOMER_INVITATION_RECEIPT_INVALID');
      }
      const current=await custody.load(client,tenantId,requireInternalId(stored.id));
      rows.push(Object.freeze({ ...stored,environment,tenantId,recipient: current.recipient }));
    }
    return Object.freeze(rows);
  }
  async function mutation(input,operation,command,work) {
    const tenantId=scope(input,operation),commandId=requireInternalId(input.commandId),reason=requireReason(input.reason);
    requireInternalId(input.correlationId);
    if (typeof input.evidenceFor!=='function') throw new TypeError('PLATFORM_CUSTOMER_INVITATION_EVIDENCE_REQUIRED');
    try { return await withPostgresTransaction(pool,async client=>{
      const operatorId=await requireCurrentPlatformMutationAuthorization(client,input.authorization,tenantId);
      const bytes=Buffer.from(JSON.stringify({ operation,reason,command }),'utf8');let requestDigest;
      try { requestDigest=cipher.commandDigest(bytes,{ tenantId,commandId,actorType: 'platform',actorId: operatorId }); }
      finally { bytes.fill(0); }
      const key={ operatorId,operation,tenantId,idempotencyKey: commandId };
      await lockPlatformOperationReceipt(client,key);
      if (tenantEligibility!==null && await tenantEligibility.lockAdmissionWithClient(client,tenantId)!==true) {
        throw new PlatformOperationDeniedError();
      }
      const tenantDisplayName=await lockTenant(client,tenantId),previous=await findPlatformOperationReceipt(client,key);
      if (previous) {
        if (previous.requestDigest!==requestDigest) throw new PlatformOperationConflictError();
        if (!previous.result || Object.keys(previous.result).sort().join(',')!=='environment,invitations'
          || previous.result.environment!==environment) throw new Error('PLATFORM_CUSTOMER_INVITATION_RECEIPT_INVALID');
        return { outcome: 'idempotent',invitations: await restore(client,tenantId,previous.result.invitations) };
      }
      const now=await time(client);
      async function recordAudit({ invitationId,nextRevision=1 }) {
        const evidence=await input.evidenceFor({ invitationId,nextRevision,occurredAt: now.toISOString() });
        if (evidence?.tenantAuditEvent?.correlationId!==input.correlationId) {
          throw new Error('PLATFORM_CUSTOMER_INVITATION_EVIDENCE_INVALID');
        }
        return (await appendPlatformMutationEvidence(client,evidence,tenantId,auditRepositories)).id;
      }
      const rows=await work(client,{ tenantId,tenantDisplayName,now,recordAudit });
      await storePlatformOperationReceipt(client,{ ...key,requestDigest,occurredAt: now,
        result: { environment,invitations: rows.map(snapshot) } });
      return { outcome: 'updated',invitations: Object.freeze(rows) };
    }); } catch (error) {
      if (error instanceof CustomerInvitationConflictError) throw new PlatformOperationConflictError();
      if (error instanceof AuthorizationDeniedError) throw new PlatformOperationDeniedError();
      throw error;
    }
  }
  return Object.freeze({
    async list(input) {
      const tenantId=scope(input,PLATFORM_OPERATION.INVITATION_LIST),limit=input.limit;
      if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || typeof input.evidenceFor!=='function') {
        throw new TypeError('PLATFORM_CUSTOMER_INVITATION_LIST_INVALID');
      }
      const after=input.afterInvitationId===null ? null : requireInternalId(input.afterInvitationId);
      return withPostgresTransaction(pool,async client=>{
        await requireCurrentPlatformMutationAuthorization(client,input.authorization,tenantId);
        if (tenantEligibility!==null && await tenantEligibility.allowsWithClient(client,tenantId)!==true) {
          throw new PlatformOperationDeniedError();
        }
        await lockTenant(client,tenantId,true);
        const result=await client.query({ name: 'platform-customer-invitation-list',
          text: `SELECT ${CUSTOMER_INVITATION_COLUMNS} FROM customer_member_invitations invitation ${CUSTOMER_INVITATION_JOINS}
            WHERE invitation.environment=$1 AND invitation.tenant_id=$2 AND ($3::uuid IS NULL OR invitation.id>$3::uuid)
            ORDER BY invitation.id LIMIT $4`,values: [environment,tenantId,after,limit] });
        const rows=Object.freeze(result.rows.map(row=>customerInvitationRecord(cipher,environment,row)));
        const evidence=await input.evidenceFor({ occurredAt: (await time(client)).toISOString() });
        const stored=await platformAuditRepository.appendWithClient(client,evidence.platformAuditEvent,
          { expectedTargetTenantId: tenantId });
        if (!stored || stored.targetTenantId!==tenantId) throw new Error('PLATFORM_AUDIT_APPEND_FAILED');
        return rows;
      });
    },
    issueBatch(input) {
      const normalized=normalizeCustomerInvitationBatch({ commandId: input.commandId,invitations: input.invitations });
      return mutation(input,PLATFORM_OPERATION.TENANT_INVITATION_CREATE,normalized.invitations,async(client,context)=>{
        const rows=[],ordered=normalized.invitations.map((intent,index)=>({ intent,index,hash: cipher.recipientLookup(intent.recipient) }))
          .sort((left,right)=>left.hash<right.hash ? -1 : left.hash>right.hash ? 1 : 0);
        for (const { intent,index } of ordered) rows[index]=await custody.issue(client,{ ...context,intent });
        return rows;
      });
    },
    mutate(input) {
      const operation=input.operation;
      if (![PLATFORM_OPERATION.INVITATION_REISSUE,PLATFORM_OPERATION.INVITATION_REVOKE].includes(operation)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1
        || input.expectedRevision>=Number.MAX_SAFE_INTEGER) throw new TypeError('PLATFORM_CUSTOMER_INVITATION_MUTATION_INVALID');
      const invitationId=requireInternalId(input.invitationId),expectedRevision=input.expectedRevision;
      return mutation(input,operation,{ invitationId,expectedRevision },async(client,context)=>[
        await custody.mutate(client,{ ...context,invitationId,expectedRevision,
          operation: operation===PLATFORM_OPERATION.INVITATION_REISSUE ? 'reissue' : 'revoke' }),
      ]);
    },
  });
}
