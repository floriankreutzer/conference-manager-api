import { randomUUID } from 'node:crypto';
import { createAuditService } from '../../src/audit/audit-service.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../../src/authorization/policy.js';
import { createCustomerInvitationService } from '../../src/application/customer-invitation-service.js';
import { createCustomerEmailFlowBinding } from '../../src/identity/customer-email-flow-binding.js';
import { createCustomerEmailAdmissionService } from '../../src/identity/customer-email-admission-service.js';
import { createEmailMailboxProofFactory } from '../../src/identity/email-code-proof.js';
import { createSessionService } from '../../src/identity/session-service.js';
import { createCustomerAccessEmailContent } from '../../src/integrations/customer-access-email-content.js';
import { createCustomerAccessCipher } from '../../src/persistence/customer-access-cipher.js';
import { createPostgresAuditRepository } from '../../src/persistence/postgres/audit-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from '../../src/persistence/postgres/customer-email-admission-repository.js';
import { createPostgresCustomerEmailChallengeRepository } from '../../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresCustomerInvitationRepository } from '../../src/persistence/postgres/customer-invitation-repository.js';
import { createPostgresSessionRepository } from '../../src/persistence/postgres/session-repository.js';

// Seed only synthetic invitation authority. The tested email User is then created
// by actual code proof/admission/session custody, never by editing a Demo persona.
// No provider send is invoked; .test recipients and deterministic code are fixtures.
export async function createInvitedCustomerFixture(pool,t) {
  const tenantId=randomUUID(),adminId=randomUUID(),correlationId=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic invited customer','onboarding')",[tenantId]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic invitation admin')",[tenantId,adminId]);
  await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[tenantId,adminId]);
  const authorizationPolicy=createAuthorizationPolicy();
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
  const admin=await sessions.issue({ tenantId,userId: adminId,securityVersion: 1,
    ...tenantAuthorizationSnapshot(['employee','tenant_admin']),providerIdentity: { provider: 'test_identity',reference: adminId } },
  { correlationId });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const content=createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' });
  const invitations=createCustomerInvitationService({ authorizationPolicy,auditService,environment: 'int',
    repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,content,auditRepository }) });
  await invitations.issueBatch({ principal: admin.principal,tenantContext: { tenantId,status: 'onboarding' },correlationId },
    { commandId: randomUUID(),invitations: [{ recipient: 'Invited@example.test',roles: ['tenant_admin'],locale: 'de' }] });
  const flowBinding=createCustomerEmailFlowBinding({ environment: 'int',secret: 'f'.repeat(48) });t.after(()=>flowBinding.destroy());
  const proofFactory=createEmailMailboxProofFactory({ environment: 'int',secret: 'p'.repeat(48),codeFactory: ()=> '00001234' });
  const challenges=createPostgresCustomerEmailChallengeRepository(pool,{ environment: 'int',cipher,content,flowBinding,proofFactory });
  const admission=createCustomerEmailAdmissionService({ repository: createPostgresCustomerEmailAdmissionRepository(pool,
    { environment: 'int',flowBinding,auditRepository }),auditService,sessionService: sessions });
  const sourceKey='e'.repeat(64),pending=await challenges.request({ recipient: 'Invited@example.test',locale: 'de',sourceKey });
  const verified=await challenges.verify({ ...pending,code: '00001234',sourceKey });
  if (verified.status!=='membership_required') throw new Error('SYNTHETIC_EMAIL_PROOF_FAILED');
  const choices=await admission.choices(verified),membershipId=choices.items[0]?.membershipId;
  const issued=await admission.select({ ...verified,correlationId: randomUUID() },{ membershipId });
  const cookie=issued.setCookie?.split(';')[0],principal=await sessions.resolvePrincipal({ headers: { cookie } });
  if (!principal || principal.providerIdentity.provider!=='email_code') throw new Error('SYNTHETIC_EMAIL_ADMISSION_FAILED');
  return { tenantId,membershipId,principal,cookie,sessions,auditService,auditRepository,authorizationPolicy };
}
