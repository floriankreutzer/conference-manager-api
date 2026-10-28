import { randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../../scripts/support/protected-runtime-role-grants.mjs';
import { deriveProtectedAuthenticationFlowSecret } from '../../src/identity/protected-authentication-flow-secret.js';
import { createCustomerAccessCipher } from '../../src/persistence/customer-access-cipher.js';
import { createPostgresAuditRepository } from '../../src/persistence/postgres/audit-repository.js';
import { createProtectedPostgresTlsFixture } from './protected-postgres-tls-fixture.js';
import { createProtectedOwnerMicrosoftFixture } from './protected-owner-microsoft-fixture.js';
import { unusedProtectedRuntimePort,startProtectedRuntimeProcess,startProtectedOwnerBrowserPlatformProcess }
  from './protected-runtime-process-fixture.js';

const ORIGINS=Object.freeze({ customer: 'https://app-int.example.test',platform: 'https://ops-int.example.com' });
// Isolated complete browser fixture: actual roots, TLS/SCRAM and runtime roles.
// Initial ordinary MFA is fixture state. Only the child SDK's provider network
// is substituted; actual browser callback/proof/approval/admission remain owned
// by the independently constructed roots. Never real Microsoft/device evidence.
export async function createProtectedOwnerBrowserRuntimeFixture(input) {
  if (!input || !['apiCommit,frontendCommit,hostedFrontend','apiCommit,frontendCommit,hostedFrontend,participants']
    .includes(Object.keys(input).sort().join(','))
    || Object.hasOwn(input,'participants') && typeof input.participants!=='boolean'
    || ![input.apiCommit,input.frontendCommit].every(value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value))
    || !input.hostedFrontend || Object.keys(input.hostedFrontend).sort().join(',')!=='customer,platform'
    || !Object.values(input.hostedFrontend).every(value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('OWNER_BROWSER_FIXTURE_REFS_REQUIRED');
  }
  const participants=input.participants===true,privateCodes=[];
  const cleanups=[],pools=[],children=[];let closed=false;
  async function close() {
    if (closed) return;closed=true;let failed=false;
    for (const child of children.reverse()) try { await child.stop(); } catch { failed=true; }
    for (const pool of pools) try { await pool.end(); } catch { failed=true; }
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch { failed=true; }
    if (failed) throw new Error('OWNER_BROWSER_FIXTURE_CLEANUP_FAILED');
  }
  try {
    const database=await createProtectedPostgresTlsFixture({ after: cleanup=>cleanups.push(cleanup) });
    function connect(url) {
      const pool=new pg.Pool({ connectionString: url,ssl: { ca: database.certificate,rejectUnauthorized: true },
        max: 1,connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
    }
    const pool=connect(database.url.href),lease=connect(database.url.href),epoch=randomUUID();
    await migrateUp(pool,fileURLToPath(new URL('../../migrations',import.meta.url)));
    await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
    const passwords=['customer','platform'].map(()=>randomBytes(32).toString('hex'));
    for (const [index,surface] of ['customer','platform'].entries()) {
      if (!/^[a-f0-9]{64}$/.test(passwords[index])) throw new Error('OWNER_BROWSER_FIXTURE_PASSWORD_INVALID');
      await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${passwords[index]}'`);
    }
    const previousDirectory=process.cwd();
    try {
      process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
      await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
    } finally { process.chdir(previousDirectory); }
    function connection(index) {
      const url=new URL(database.url);url.username=`cm_protected_int_${index===0 ? 'customer' : 'platform'}`;
      url.password=passwords[index];return url.href;
    }
    const owner=await createProtectedOwnerMicrosoftFixture(pool,lease,{ epoch,runtimePool: connect(connection(1)),
      runtimeLeasePool: connect(connection(1)),transactionSecret: deriveProtectedAuthenticationFlowSecret({
        environment: 'int',securityEpoch: epoch,secret: 'o'.repeat(48),purpose: 'platform-microsoft-flow' }) });
    const target=randomUUID(),foreign=randomUUID(),suspended=randomUUID();
    for (const [tenant,name,status] of [[target,'Owner browser Customer','active'],[foreign,'Other Customer','active'],
      [suspended,'Suspended Customer','suspended']]) {
      await pool.query('INSERT INTO tenants(id,display_name,status) VALUES($1,$2,$3)',[tenant,name,status]);
      await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[tenant]);
    }
    const common={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: database.caPath,PROTECTED_ENVIRONMENT: 'int',
      PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: input.apiCommit,
      PROTECTED_FRONTEND_COMMIT: input.frontendCommit,PROTECTED_SERVICE_VERSION: '1.0.0',
      PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1',PROTECTED_CUSTOMER_ORIGIN: ORIGINS.customer,
      PROTECTED_PLATFORM_ORIGIN: ORIGINS.platform,PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),
      PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
      PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]),
      PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED: 'true',PROTECTED_OWNER_HANDOFF_SECRET: 'h'.repeat(48),
      PROTECTED_HOSTED_FRONTEND_ENABLED: 'true',...(participants ? { PROTECTED_SYNTHETIC_ENABLED: 'true',
        PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'z'.repeat(48) } : {}) };
    const customerClientId=randomUUID();
    const platform=await startProtectedOwnerBrowserPlatformProcess({ ...common,
      CM_OWNER_BROWSER_SUBJECT: owner.current().principal.providerIdentity.subjectReference,
      PROTECTED_HOSTED_FRONTEND_SHA256: input.hostedFrontend.platform,PROTECTED_PLATFORM_DATABASE_URL: connection(1),
      PROTECTED_PEER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PLATFORM_ENTRA_CLIENT_ID: owner.clientId,
      PROTECTED_PLATFORM_ENTRA_TENANT_ID: owner.directoryId,PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),
      PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),
      PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
      PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@example.test',PROTECTED_PLATFORM_ASSURANCE_MODE: 'microsoft_mfa',
      PROTECTED_PLATFORM_OWNER_HANDOFF_INTENT_SECRET: 'i'.repeat(48),
      ...(participants ? { PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'j'.repeat(48) } : {}),
      PROTECTED_PLATFORM_HOST: '127.0.0.1',PROTECTED_PLATFORM_PORT: String(await unusedProtectedRuntimePort()) });
    children.push(platform);if (platform.outcome.type!=='listening') throw new Error('OWNER_BROWSER_PLATFORM_NOT_READY');
    const customer=await startProtectedRuntimeProcess('customer',{ ...common,
      PROTECTED_HOSTED_FRONTEND_SHA256: input.hostedFrontend.customer,PROTECTED_CUSTOMER_DATABASE_URL: connection(0),
      PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PEER_ENTRA_CLIENT_ID: owner.clientId,
      PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'g'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
      PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'n'.repeat(48),
      PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
      PROTECTED_CUSTOMER_HOST: '127.0.0.1',PROTECTED_CUSTOMER_PORT: String(await unusedProtectedRuntimePort()) });
    children.push(customer);if (customer.outcome.type!=='listening') throw new Error('OWNER_BROWSER_CUSTOMER_NOT_READY');
    const initial=owner.current(),audit=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });
    const cipher=participants ? createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
      keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) }) : null;
    if (cipher) cleanups.push(()=>cipher.destroy());
    return Object.freeze({ origins: ORIGINS,initialSetCookie: initial.setCookie,
      ports: Object.freeze({ customer: customer.outcome.port,platform: platform.outcome.port }),close,
      ...(participants ? { async waitForMicrosoftOperationCapacity(requiredSlots=1) {
        if (![1,2].includes(requiredSlots)) throw new Error('PARTICIPANT_BROWSER_PROOF_CAPACITY_INVALID');
        // Production counts every unexpired proof, including consumed records.
        // Wait on the actual database clock; never rewrite its budget or expiry.
        async function capacity() {
          const row=(await pool.query(`WITH active AS MATERIALIZED (
            SELECT expires_at FROM platform_microsoft_operation_proofs
            WHERE operator_id=$1 AND expires_at>clock_timestamp()
          ), totals AS (SELECT count(*)::int AS live FROM active)
          SELECT live,CASE WHEN live+$2>5 THEN GREATEST(0,CEIL(EXTRACT(EPOCH FROM (
            (SELECT expires_at FROM active ORDER BY expires_at OFFSET (live+$2-6) LIMIT 1)-clock_timestamp()))*1000))
            ELSE 0 END AS wait_ms FROM totals`,[owner.operatorId,requiredSlots])).rows[0];
          const live=Number(row.live),waitMs=Number(row.wait_ms);
          if (!Number.isInteger(live) || live<0 || live>5 || !Number.isInteger(waitMs) || waitMs<0 || waitMs>120000) {
            throw new Error('PARTICIPANT_BROWSER_PROOF_CAPACITY_INVALID');
          }
          return { live,waitMs };
        }
        const before=await capacity(),waitedMs=before.live+requiredSlots>5 ? before.waitMs+25 : 0;
        if (waitedMs) await delay(waitedMs);
        const after=await capacity();
        if (after.live+requiredSlots>5) throw new Error('PARTICIPANT_BROWSER_PROOF_CAPACITY_UNAVAILABLE');
        return Object.freeze({ requiredSlots,liveProofs: before.live,waitedMs });
      },async mailboxCode(recipient) {
        if (!['northwind@example.test','contoso@example.test','fabrikam@example.test'].includes(recipient)) {
          throw new Error('PARTICIPANT_BROWSER_MAILBOX_REJECTED');
        }
        const row=(await pool.query(`SELECT delivery.* FROM customer_access_deliveries delivery
          JOIN customer_email_challenges challenge ON challenge.environment=delivery.environment AND challenge.id=delivery.challenge_id
          JOIN customer_access_mailboxes mailbox ON mailbox.environment=challenge.environment AND mailbox.id=challenge.mailbox_id
          JOIN customer_access_memberships member ON member.environment=mailbox.environment AND member.mailbox_id=mailbox.id
          JOIN synthetic_invited_memberships binding ON binding.environment=member.environment
            AND binding.tenant_id=member.tenant_id AND binding.membership_id=member.id AND binding.operator_id=$2
          JOIN synthetic_tenant_generations generation ON generation.environment=binding.environment
            AND generation.id=binding.generation_id
          WHERE delivery.environment='int' AND delivery.purpose='mailbox_code' AND mailbox.lookup_hash=$1
            AND generation.state='active' AND challenge.consumed_at IS NULL AND challenge.verified_at IS NULL
          ORDER BY delivery.created_at DESC LIMIT 1`,[cipher.recipientLookup(recipient),owner.operatorId])).rows[0];
        if (!row) throw new Error('PARTICIPANT_BROWSER_CODE_UNAVAILABLE');
        const bytes=cipher.open(row.payload_envelope,{ environment: 'int',mailboxId: row.mailbox_id,recordId: row.id,
          purpose: 'mailbox_code',tenantId: null });
        try {
          const code=JSON.parse(bytes.toString('utf8')).text.match(/\b\d{8}\b/)?.[0];
          if (!code) throw new Error('PARTICIPANT_BROWSER_CODE_INVALID');privateCodes.push(code);return code;
        } finally { bytes.fill(0); }
      } } : {}),
      async evidence() {
        if (await audit.verifyTenantChain(target)!==true || !await owner.auditRepository.isReady()) {
          throw new Error('OWNER_BROWSER_AUDIT_INVALID');
        }
        const counts=(await pool.query(`SELECT
          (SELECT count(*)::int FROM platform_passkey_credentials) AS application_keys,
          (SELECT count(*)::int FROM platform_owner_customer_users) AS own_bindings,
          (SELECT count(DISTINCT user_id)::int FROM owner_customer_handoffs WHERE status='consumed') AS distinct_own_users,
          (SELECT count(*)::int FROM owner_customer_handoffs WHERE status='consumed') AS consumed_flows,
          (SELECT count(*)::int FROM tenant_user_roles) AS ordinary_user_grants`)).rows[0];
        const secrets=[database.password,...passwords,...privateCodes,initial.setCookie.split(';')[0],
          'h'.repeat(48),'a'.repeat(48),'t'.repeat(48)];
        if (children.some(child=>secrets.some(value=>child.logs().includes(value)))) throw new Error('OWNER_BROWSER_LOG_REDACTION_FAILED');
        const participantEvidence={};
        if (participants) {
          const rows=(await pool.query(`SELECT tenant_id FROM tenant_runtime_registry WHERE environment='int'
            AND mode='synthetic' AND operator_id=$1 ORDER BY tenant_id`,[owner.operatorId])).rows;
          for (const row of rows) if (!await audit.verifyTenantChain(row.tenant_id)) throw new Error('PARTICIPANT_BROWSER_AUDIT_INVALID');
          const totals=(await pool.query(`SELECT count(*)::int AS registered,
            count(*) FILTER(WHERE member.accepted_at IS NOT NULL)::int AS accepted
            FROM synthetic_invited_memberships binding JOIN customer_access_memberships member
              ON member.environment=binding.environment AND member.tenant_id=binding.tenant_id AND member.id=binding.membership_id
            WHERE binding.environment='int' AND binding.operator_id=$1`,[owner.operatorId])).rows[0];
          participantEvidence.participants=Object.freeze(totals);
        }
        return Object.freeze({ ...participantEvidence,refs: { apiCommit: input.apiCommit,frontendCommit: input.frontendCommit },...counts,
          tenantChainVerified: true,platformChainVerified: true,provider: 'isolated-actual-msal-network' });
      },
    });
  } catch { await close();throw new Error('OWNER_BROWSER_FIXTURE_SETUP_FAILED'); }
}
