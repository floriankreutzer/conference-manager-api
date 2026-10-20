import { randomUUID } from 'node:crypto';
import { normalizeCustomerInvitationBatch } from '../../authorization/customer-invitation-policy.js';
import { PLATFORM_OPERATION,requireDisplayName,requireReason,
  requireInternalId } from '../../platform/application/platform-operation-contract.js';
import { PlatformOperationConflictError } from '../../platform/application/platform-operation-errors.js';
import { withPostgresTransaction } from './transaction.js';
import { createCustomerInvitationCustody } from './customer-invitation-custody.js';
import { lockPlatformOperationReceipt,findPlatformOperationReceipt,storePlatformOperationReceipt,
  requireCurrentPlatformMutationAuthorization,appendPlatformMutationEvidence } from './platform-operations-repository.js';

const operation=PLATFORM_OPERATION.TENANT_INVITATION_CREATE;
const snapshotFields=['id','revision','roles','locale','state','expiresAt','delivery'];
function snapshot(row) {
  return Object.fromEntries(snapshotFields.map(key=>[key,row[key]]));
}
// Explicit Platform authority. No Customer principal, bearer claim or synthetic
// User is created to reach invitation custody. All effects join the proof's ALS
// transaction, so authorization, both audit domains and outbox commit together.
export function createPostgresPlatformCustomerOnboardingRepository(pool,{ environment,cipher,content,
  tenantAuditRepository,platformAuditRepository,identifierFactory=randomUUID } = {}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment)
    || typeof cipher?.platformCreationDigest!=='function'
    || typeof tenantAuditRepository?.appendWithClient!=='function'
    || typeof platformAuditRepository?.appendWithClient!=='function') {
    throw new TypeError('PLATFORM_CUSTOMER_ONBOARDING_REPOSITORY_CONFIGURATION_INVALID');
  }
  const custody=createCustomerInvitationCustody(pool,{ environment,cipher,content,identifierFactory });
  const auditRepositories={ tenantAuditRepository,platformAuditRepository };
  return Object.freeze({
    async create(input) {
      if (input?.environment!==environment || input.authorization?.operation!==operation
        || input.authorization?.targetTenantId!==null || typeof input.evidenceFor!=='function') {
        throw new TypeError('PLATFORM_CUSTOMER_ONBOARDING_INPUT_INVALID');
      }
      const tenantId=requireInternalId(input.proposedTenantId),displayName=requireDisplayName(input.displayName);
      const reason=requireReason(input.reason),correlationId=requireInternalId(input.correlationId);
      const normalized=normalizeCustomerInvitationBatch({ commandId: input.commandId,invitations: input.invitations });
      return withPostgresTransaction(pool,async client=>{
        // Replays require live authority too; stale/revoked sessions cannot read receipts.
        const operatorId=await requireCurrentPlatformMutationAuthorization(client,input.authorization,null,{ creation: true });
        const bytes=Buffer.from(JSON.stringify({ displayName,reason,invitations: normalized.invitations }),'utf8');
        let requestDigest;
        try { requestDigest=cipher.platformCreationDigest(bytes,{ operatorId,commandId: normalized.commandId }); }
        finally { bytes.fill(0); }
        const key={ operatorId,operation,tenantId: null,idempotencyKey: normalized.commandId };
        await lockPlatformOperationReceipt(client,key);
        const previous=await findPlatformOperationReceipt(client,key);
        if (previous) {
          if (previous.requestDigest!==requestDigest) throw new PlatformOperationConflictError();
          const receipt=previous.result;
          if (!receipt || Object.keys(receipt).sort().join(',')!=='environment,invitations,tenant'
            || receipt.environment!==environment || !receipt.tenant
            || Object.keys(receipt.tenant).sort().join(',')!=='displayName,id,status'
            || receipt.tenant.displayName!==displayName || receipt.tenant.status!=='onboarding'
            || !Array.isArray(receipt.invitations) || receipt.invitations.length!==normalized.invitations.length) {
            throw new Error('PLATFORM_CUSTOMER_ONBOARDING_RECEIPT_INVALID');
          }
          const originalId=requireInternalId(receipt.tenant.id),invitations=[];
          for (const stored of receipt.invitations) {
            if (!stored || Object.keys(stored).sort().join(',')!==[...snapshotFields].sort().join(',')) {
              throw new Error('PLATFORM_CUSTOMER_ONBOARDING_RECEIPT_INVALID');
            }
            const current=await custody.load(client,originalId,requireInternalId(stored.id));
            invitations.push(Object.freeze({ ...stored,tenantId: originalId,environment,recipient: current.recipient }));
          }
          return Object.freeze({ outcome: 'idempotent',tenant: Object.freeze({ ...receipt.tenant }),
            invitations: Object.freeze(invitations) });
        }
        const clock=await client.query('SELECT clock_timestamp() AS now'),now=clock.rows[0]?.now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('PLATFORM_CUSTOMER_ONBOARDING_CLOCK_INVALID');
        const created=await client.query({ name: 'platform-customer-onboarding-tenant-create',
          text: `INSERT INTO tenants(id,display_name,status,created_at,updated_at)
            VALUES($1,$2,'onboarding',$3,$3) ON CONFLICT(id) DO NOTHING RETURNING id`,values: [tenantId,displayName,now] });
        if (created.rowCount!==1) throw new PlatformOperationConflictError();
        async function evidence(invitationId=null) {
          const events=await input.evidenceFor({ tenantId,invitationId,occurredAt: now.toISOString() });
          if (events?.tenantAuditEvent?.correlationId!==correlationId) throw new Error('PLATFORM_CUSTOMER_ONBOARDING_EVIDENCE_INVALID');
          return appendPlatformMutationEvidence(client,events,tenantId,auditRepositories);
        }
        await evidence();
        const invitations=[];
        const ordered=normalized.invitations.map((intent,index)=>({ intent,index,hash: cipher.recipientLookup(intent.recipient) }))
          .sort((left,right)=>left.hash<right.hash ? -1 : left.hash>right.hash ? 1 : 0);
        for (const { intent,index } of ordered) {
          invitations[index]=await custody.issue(client,{ tenantId,intent,tenantDisplayName: displayName,now,
            recordAudit: async ({ invitationId })=>(await evidence(invitationId)).id });
        }
        const tenant=Object.freeze({ id: tenantId,displayName,status: 'onboarding' });
        await storePlatformOperationReceipt(client,{ ...key,requestDigest,occurredAt: now,
          result: { environment,tenant,invitations: invitations.map(snapshot) } });
        return Object.freeze({ outcome: 'updated',tenant,invitations: Object.freeze(invitations) });
      });
    },
  });
}
