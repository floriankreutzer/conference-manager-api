import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { createPostgresCustomerEmailChallengeRepository } from '../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const id = number => `f0000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
test('mailbox code custody keeps unknown flows uniform and rotates proof without issuing Tenant authority', async t => {
  const database = loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test',...database }); t.after(() => pool.end()); await migrateUp(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const auditService = createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions = createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: 'https://customer-int.example.com',csrfSecret: 's'.repeat(48) });
  const cipher = createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) }); t.after(() => cipher.destroy());
  const content = createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://customer-int.example.com' });
  const flowBinding = createCustomerEmailFlowBinding({ environment: 'int',secret: 'f'.repeat(48) }); t.after(() => flowBinding.destroy());
  const proofFactory = createEmailMailboxProofFactory({ environment: 'int',secret: 'p'.repeat(48),codeFactory: () => '00001234' });
  const challenges = createPostgresCustomerEmailChallengeRepository(pool,{ environment: 'int',cipher,content,flowBinding,proofFactory });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic Mailbox Tenant','onboarding')",[id(1)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic Admin')",[id(1),id(2)]);
  await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[id(1),id(2)]);
  const session = await sessions.issue({ tenantId: id(1),userId: id(2),securityVersion: 1,
    ...tenantAuthorizationSnapshot(['employee','tenant_admin']),providerIdentity: { provider: 'test_identity',reference: id(2) } },
  { correlationId: id(3) });
  const invitations = createCustomerInvitationService({ authorizationPolicy,auditService,environment: 'int',
    repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,content,auditRepository }) });
  await invitations.issueBatch({ principal: session.principal,
    tenantContext: { tenantId: id(1),status: 'onboarding' },correlationId: id(3) },
    { commandId: id(4),invitations: [{ recipient: 'Invited@example.com',locale: 'de',roles: ['tenant_admin'] }] });
  const sourceKey = 'c'.repeat(64);
  const unknown = await challenges.request({ recipient: 'Unknown@example.com',locale: 'de',sourceKey });
  const known = await challenges.request({ recipient: 'Invited@example.com',locale: 'de',sourceKey });
  assert.deepEqual(Object.keys(known).sort(),Object.keys(unknown).sort());
  assert.deepEqual(Object.keys(await challenges.pending(known)),Object.keys(await challenges.pending(unknown)));
  assert.equal((await challenges.pending(unknown)).status,'code_required');
  assert.equal((await challenges.verify({ ...unknown,code: '00001234',sourceKey })).status,'rejected');
  const count = async () => (await pool.query('SELECT attempt_count FROM customer_email_challenges WHERE id=$1',[known.challengeId]))
    .rows[0].attempt_count;
  assert.equal((await challenges.verify({ ...known,csrfToken: '0'.repeat(64),code: '00001234',sourceKey })).status,'rejected');
  assert.equal(await count(),0);
  assert.equal((await challenges.verify({ ...known,code: '99999999',sourceKey })).status,'rejected'); assert.equal(await count(),1);
  const concurrent = await Promise.all([1,2].map(() => challenges.verify({ ...known,code: '00001234',sourceKey })));
  assert.deepEqual(concurrent.map(item => item.status).sort(),['membership_required','rejected']);
  const choice = concurrent.find(item => item.status === 'membership_required');
  assert.notEqual(choice.browserToken,known.browserToken); assert.notEqual(choice.csrfToken,known.csrfToken);
  assert.equal((await challenges.pending(known)).status,'rejected');
  assert.equal((await challenges.pending(choice)).status,'membership_required');
  assert.doesNotMatch(JSON.stringify(choice),/tenantId|mailboxId|roles|permissions|recipient|userId/);
  const persisted = (await pool.query('SELECT to_jsonb(challenge) AS value FROM customer_email_challenges challenge')).rows;
  assert.doesNotMatch(JSON.stringify(persisted),/Invited@example|Unknown@example|00001234|99999999/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,1);
  const deliveries = await pool.query("SELECT count(*)::int AS n FROM customer_access_deliveries WHERE purpose='mailbox_code'");
  assert.equal(deliveries.rows[0].n,1);
});
