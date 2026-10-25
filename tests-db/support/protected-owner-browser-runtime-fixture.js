import { randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../../scripts/support/protected-runtime-role-grants.mjs';
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
  if (!input || Object.keys(input).sort().join(',')!=='apiCommit,frontendCommit,hostedFrontend'
    || ![input.apiCommit,input.frontendCommit].every(value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value))
    || !input.hostedFrontend || Object.keys(input.hostedFrontend).sort().join(',')!=='customer,platform'
    || !Object.values(input.hostedFrontend).every(value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('OWNER_BROWSER_FIXTURE_REFS_REQUIRED');
  }
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
      runtimeLeasePool: connect(connection(1)),transactionSecret: 'o'.repeat(48) });
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
      PROTECTED_HOSTED_FRONTEND_ENABLED: 'true' };
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
    return Object.freeze({ origins: ORIGINS,initialSetCookie: initial.setCookie,
      ports: Object.freeze({ customer: customer.outcome.port,platform: platform.outcome.port }),close,
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
        const secrets=[database.password,...passwords,initial.setCookie.split(';')[0],'h'.repeat(48),'a'.repeat(48),'t'.repeat(48)];
        if (children.some(child=>secrets.some(value=>child.logs().includes(value)))) throw new Error('OWNER_BROWSER_LOG_REDACTION_FAILED');
        return Object.freeze({ refs: { apiCommit: input.apiCommit,frontendCommit: input.frontendCommit },...counts,
          tenantChainVerified: true,platformChainVerified: true,provider: 'isolated-actual-msal-network' });
      },
    });
  } catch { await close();throw new Error('OWNER_BROWSER_FIXTURE_SETUP_FAILED'); }
}
